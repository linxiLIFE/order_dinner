import "dotenv/config";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool, withReadOnlySnapshot, withTransaction, type DbClient } from "./db.js";
import { migrateAndSeed, pruneExpiredIdempotencyKeys } from "./migrate.js";
import { createToken, requireAuth, requireRole } from "./auth.js";
import type { AuthenticatedRequest, AuthUser } from "./types.js";
import {
  averageFen,
  csvDocument,
  fenAsYuan,
  idempotencyLockKey,
  normalizeCustomerPhone,
  ratioPercent,
  redactFinancialDetails,
  requireNonNegativeInteger,
  requirePositiveInteger
} from "./domain.js";
import {
  businessDate,
  getSettings,
  maskPhone,
  publicError,
  settingBoolean,
  settingNumber
} from "./utils.js";

const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 3000);
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");

app.use(cors({ origin: true, credentials: false }));
app.use(express.json({ limit: "2mb" }));
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

class AppError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function fail(message: string, status = 400): never {
  throw new AppError(message, status);
}

function currentUser(req: AuthenticatedRequest): AuthUser {
  if (!req.user) fail("请先登录", 401);
  return req.user;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function routeParam(req: Request, name: string): string {
  return text(req.params[name]);
}

type StoreEvent = {
  type: string;
  orderId?: string;
  newOrderId?: string;
  tableId?: string | null;
};

type EventTicket = { employeeId: string; authVersion: number; expiresAt: number; tokenExpiresAt: number };
type EventStream = {
  response: Response;
  heartbeat: ReturnType<typeof setInterval>;
  employeeId: string;
  authVersion: number;
  tokenExpiresAt: number;
  validating: boolean;
};
const eventTickets = new Map<string, EventTicket>();
const eventStreams = new Set<EventStream>();

function closeEventStream(stream: EventStream): void {
  clearInterval(stream.heartbeat);
  eventStreams.delete(stream);
  if (!stream.response.destroyed && !stream.response.writableEnded) stream.response.end();
}

async function validateEventStream(stream: EventStream): Promise<void> {
  if (!eventStreams.has(stream)) return;
  if (stream.response.destroyed || stream.response.writableEnded || Date.now() >= stream.tokenExpiresAt) {
    closeEventStream(stream);
    return;
  }
  if (stream.validating) return;
  stream.validating = true;
  try {
    const result = await pool.query<{ active: boolean; auth_version: number }>(
      `SELECT active, auth_version FROM employees WHERE id = $1`,
      [stream.employeeId]
    );
    const employee = result.rows[0];
    if (!employee?.active || employee.auth_version !== stream.authVersion) {
      closeEventStream(stream);
      return;
    }
    if (!stream.response.write(": keep-alive\n\n")) closeEventStream(stream);
  } catch {
    closeEventStream(stream);
  } finally {
    stream.validating = false;
  }
}

function broadcastUpdate(event: StoreEvent): void {
  const message = `data: ${JSON.stringify({ ...event, at: new Date().toISOString() })}\n\n`;
  for (const stream of eventStreams) {
    try {
      if (stream.response.destroyed || stream.response.writableEnded) {
        closeEventStream(stream);
        continue;
      }
      if (!stream.response.write(message)) closeEventStream(stream);
    } catch {
      closeEventStream(stream);
    }
  }
}

function printerTokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function requirePrinterDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const deviceId = text(req.header("x-printer-device-id"));
    const token = text(req.header("x-printer-token"));
    if (!deviceId || !token) fail("打印设备认证信息不完整", 401);
    const result = await pool.query(
      `UPDATE printer_devices SET last_seen_at = now(), updated_at = now()
       WHERE id = $1 AND token_hash = $2 AND active = true RETURNING id`,
      [deviceId, printerTokenHash(token)]
    );
    if (!result.rows[0]) fail("打印设备认证已失效，请重新配置", 401);
    next();
  } catch (error) {
    publicError(res, error);
  }
}

function normalizedPhone(value: unknown): string | null {
  return normalizeCustomerPhone(value);
}

async function findOrCreateCustomer(client: DbClient, phone: string, name: string | null): Promise<string> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`customer-phone:${phone}`]);
  const digits = `regexp_replace(phone, '[^0-9]', '', 'g')`;
  const matches = await client.query<{ id: string; phone: string }>(
    `SELECT id, phone FROM customers
     WHERE CASE
       WHEN ${digits} LIKE '0086%' THEN substring(${digits} FROM 5)
       WHEN length(${digits}) = 13 AND ${digits} LIKE '86%' THEN substring(${digits} FROM 3)
       ELSE ${digits}
     END = $1
     FOR UPDATE`,
    [phone]
  );
  if (matches.rows.length > 1) fail("该手机号存在多条旧顾客档案，请先核对后再开台", 409);
  if (matches.rows[0]) {
    const updated = await client.query<{ id: string }>(
      `UPDATE customers SET phone = $1, name = COALESCE($2, name), updated_at = now()
       WHERE id = $3 RETURNING id`,
      [phone, name, matches.rows[0].id]
    );
    return updated.rows[0].id;
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO customers (phone, name) VALUES ($1, $2) RETURNING id`,
    [phone, name]
  );
  return inserted.rows[0].id;
}

type ItemRow = {
  id: string;
  batch_id: string;
  order_id: string;
  dish_id: string | null;
  dish_name: string;
  category_name: string;
  unit: string;
  price_fen: number;
  cost_fen: number;
  quantity: number;
  gifted_quantity: number;
  returned_quantity: number;
  returned_made_quantity: number;
  note: string;
  option_snapshot: unknown;
  batch_no: number;
  batch_kind: string;
  created_at: string;
};

type Totals = {
  grossFen: number;
  giftFen: number;
  returnFen: number;
  subtotalFen: number;
  costFen: number;
  lossFen: number;
};

function calculateTotals(items: ItemRow[]): Totals {
  return items.reduce(
    (total, item) => {
      const returned = Math.min(item.quantity, item.returned_quantity);
      const gifted = Math.min(Math.max(0, item.quantity - returned), item.gifted_quantity);
      const grossFen = item.quantity * item.price_fen;
      const giftFen = gifted * item.price_fen;
      const returnFen = returned * item.price_fen;
      const costFen = (item.quantity - returned + item.returned_made_quantity) * item.cost_fen;
      return {
        grossFen: total.grossFen + grossFen,
        giftFen: total.giftFen + giftFen,
        returnFen: total.returnFen + returnFen,
        subtotalFen: total.subtotalFen + Math.max(0, grossFen - giftFen - returnFen),
        costFen: total.costFen + costFen,
        lossFen: total.lossFen + item.returned_made_quantity * item.cost_fen
      };
    },
    { grossFen: 0, giftFen: 0, returnFen: 0, subtotalFen: 0, costFen: 0, lossFen: 0 }
  );
}

function marginPercent(revenueFen: number, costFen: number): number {
  return revenueFen > 0 ? Math.round(((revenueFen - costFen) / revenueFen) * 10000) / 100 : 0;
}

type DishOptionGroup = {
  id: string;
  name: string;
  required: boolean;
  allow_multiple: boolean;
  options: Array<{ id: string; label: string }>;
};

async function dishOptionGroups(client: DbClient, dishId: string): Promise<DishOptionGroup[]> {
  const result = await client.query<DishOptionGroup>(
    `SELECT g.id, g.name, g.required, g.allow_multiple,
            COALESCE((
              SELECT json_agg(json_build_object('id', o.id, 'label', o.label) ORDER BY o.sort_order, o.id)
              FROM dish_options o
              WHERE o.group_id = g.id AND o.active = true
            ), '[]'::json) AS options
     FROM dish_option_groups g
     WHERE g.dish_id = $1 AND g.active = true
     ORDER BY g.sort_order, g.name, g.id`,
    [dishId]
  );
  return result.rows;
}

function optionSelections(
  groups: DishOptionGroup[],
  rawSelections: unknown,
  customNote: unknown
): { note: string; snapshot: Array<Record<string, unknown>> } {
  const requested = Array.isArray(rawSelections) ? rawSelections : [];
  const snapshot: Array<Record<string, unknown>> = [];
  const noteParts: string[] = [];
  for (const group of groups) {
    const row = requested.find((value) => text((value as { groupId?: unknown })?.groupId) === group.id) as { optionIds?: unknown } | undefined;
    const optionIds = Array.from(new Set(Array.isArray(row?.optionIds) ? row.optionIds.map((id) => text(id)).filter(Boolean) : []));
    if (group.required && !optionIds.length) fail(`请选择${group.name}`);
    if (!group.allow_multiple && optionIds.length > 1) fail(`${group.name}只能选择一项`);
    const selected = optionIds.map((id) => group.options.find((option) => option.id === id)).filter(Boolean) as Array<{ id: string; label: string }>;
    if (selected.length !== optionIds.length) fail(`${group.name}包含无效选项`);
    if (selected.length) {
      noteParts.push(`${group.name}：${selected.map((option) => option.label).join("、")}`);
      snapshot.push({ groupId: group.id, groupName: group.name, optionIds, labels: selected.map((option) => option.label) });
    }
  }
  const note = text(customNote).slice(0, 300);
  if (note) noteParts.push(snapshot.length ? `备注：${note}` : note);
  return { note: noteParts.join("，").slice(0, 500), snapshot };
}

async function replaceDishOptionGroups(client: DbClient, dishId: string, rawGroups: unknown): Promise<void> {
  const parsed = z.array(z.object({
    name: z.string().trim().min(1).max(40),
    required: z.boolean().default(false),
    allowMultiple: z.boolean().default(false),
    options: z.array(z.object({ label: z.string().trim().min(1).max(40) }).strict()).min(1).max(30)
  }).strict()).max(20).safeParse(rawGroups);
  if (!parsed.success) fail("备注选项配置不正确");
  const groups = parsed.data;
  if (new Set(groups.map((group) => group.name)).size !== groups.length) fail("备注问题名称不能重复");
  await client.query(`DELETE FROM dish_option_groups WHERE dish_id = $1`, [dishId]);
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const rawGroup = groups[groupIndex];
    const name = rawGroup.name;
    const labels = Array.from(new Set(rawGroup.options.map((option) => option.label)));
    const group = await client.query<{ id: string }>(
      `INSERT INTO dish_option_groups (dish_id, name, required, allow_multiple, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [dishId, name, rawGroup.required, rawGroup.allowMultiple, groupIndex]
    );
    for (let optionIndex = 0; optionIndex < labels.length; optionIndex += 1) {
      await client.query(
        `INSERT INTO dish_options (group_id, label, sort_order) VALUES ($1, $2, $3)`,
        [group.rows[0].id, labels[optionIndex], optionIndex]
      );
    }
  }
}

async function orderItems(client: DbClient, orderId: string): Promise<ItemRow[]> {
  const result = await client.query<ItemRow>(
    `SELECT oi.*, ob.batch_no, ob.kind AS batch_kind
     FROM order_items oi
     JOIN order_batches ob ON ob.id = oi.batch_id
     WHERE oi.order_id = $1
     ORDER BY ob.batch_no, oi.created_at, oi.id`,
    [orderId]
  );
  return result.rows;
}

async function orderDetails(client: DbClient, orderId: string, includeFinancialDetails = false): Promise<Record<string, unknown>> {
  const orderResult = await client.query<{
    id: string;
    table_id: string | null;
    table_number: number | null;
    table_name: string | null;
    customer_id: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    points_balance: number | null;
    guest_label: string | null;
    people_count: number;
    status: string;
    order_version: number;
    business_date: string;
    parent_order_id: string | null;
    opened_at: string;
    settled_at: string | null;
    ended_at: string | null;
    end_reason: string;
    order_note: string;
  }>(
    `SELECT o.*, COALESCE(o.table_number_snapshot, t.number) AS table_number,
            COALESCE(o.table_name_snapshot, t.name) AS table_name,
            c.name AS customer_name, c.phone AS customer_phone,
            c.points_balance
     FROM orders o
     LEFT JOIN restaurant_tables t ON t.id = o.table_id
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = $1`,
    [orderId]
  );
  const order = orderResult.rows[0];
  if (!order) fail("订单不存在", 404);
  const items = await orderItems(client, orderId);
  const totals = calculateTotals(items);
  const settlementResult = await client.query(
    `SELECT s.id, s.version, s.gross_fen, s.gift_fen, s.return_fen,
            s.manual_discount_fen, s.points_discount_fen, s.received_fen,
            s.payment_method, s.earned_points, s.redeemed_points, s.reason,
            s.status, s.settled_at, e.name AS operator_name
     FROM settlements s LEFT JOIN employees e ON e.id = s.operator_id
     WHERE s.order_id = $1 ORDER BY s.version DESC, s.settled_at DESC`,
    [orderId]
  );
  const activeSettlement = settlementResult.rows.find((row) => row.status === "ACTIVE") as {
    gross_fen?: number;
    gift_fen?: number;
    return_fen?: number;
    manual_discount_fen?: number;
    points_discount_fen?: number;
  } | undefined;
  const settledRevenueFen = activeSettlement
    ? Number(activeSettlement.gross_fen || 0)
      - Number(activeSettlement.gift_fen || 0)
      - Number(activeSettlement.return_fen || 0)
      - Number(activeSettlement.manual_discount_fen || 0)
      - Number(activeSettlement.points_discount_fen || 0)
    : 0;
  const revenueFen = order.status === "OPEN"
    ? totals.subtotalFen
    : order.status === "SETTLED"
      ? settledRevenueFen
      : null;
  const { costFen, lossFen, ...publicTotals } = totals;
  const details: Record<string, unknown> = {
    id: order.id,
    tableId: order.table_id,
    tableNumber: order.table_number,
    tableName: order.table_name,
    customer: order.customer_id
      ? { id: order.customer_id, name: order.customer_name, phone: maskPhone(order.customer_phone), points: order.points_balance }
      : { id: null, name: order.guest_label || "散客", phone: null, points: 0 },
    peopleCount: order.people_count,
    status: order.status,
    orderVersion: order.order_version,
    businessDate: order.business_date,
    parentOrderId: order.parent_order_id,
    openedAt: order.opened_at,
    settledAt: order.settled_at,
    endedAt: order.ended_at,
    endReason: order.end_reason,
    orderNote: order.order_note,
    items: items.map((item) => ({
      id: item.id,
      dishId: item.dish_id,
      name: item.dish_name,
      categoryName: item.category_name,
      unit: item.unit,
      priceFen: item.price_fen,
      quantity: item.quantity,
      giftedQuantity: item.gifted_quantity,
      returnedQuantity: item.returned_quantity,
      returnedMadeQuantity: item.returned_made_quantity,
      availableQuantity: Math.max(0, item.quantity - item.gifted_quantity - item.returned_quantity),
      note: item.note,
      optionSnapshot: item.option_snapshot || [],
      batchNo: item.batch_no,
      batchKind: item.batch_kind,
      createdAt: item.created_at
    })),
    totals: includeFinancialDetails ? totals : publicTotals,
    revenueFen,
    grossMarginPercent: null,
    settlements: settlementResult.rows
  };
  if (includeFinancialDetails) {
    details.grossProfitFen = revenueFen === null ? null : revenueFen - costFen;
    details.grossMarginPercent = revenueFen === null ? null : marginPercent(revenueFen, costFen);
    details.lossFen = lossFen;
  }
  return details;
}

function requiredIdempotencyKey(value: unknown): string {
  const key = text(value);
  if (!key || key.length > 200) fail("请求编号缺失，请刷新后重试");
  return key;
}

function idempotencyPayload(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const { idempotencyKey: _idempotencyKey, ...payload } = body as Record<string, unknown>;
  return payload;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function payloadHash(payload: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

async function readIdempotent(
  client: DbClient,
  scope: string,
  requestKey: string,
  employeeId: string,
  payload: unknown,
  includeFinancialDetails: boolean
): Promise<unknown | null> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [idempotencyLockKey(scope, requestKey)]);
  const result = await client.query<{ response: unknown; employee_id: string | null; payload_hash: string | null }>(
    `SELECT response, employee_id, payload_hash FROM idempotency_keys WHERE scope = $1 AND request_key = $2`,
    [scope, requestKey]
  );
  const previous = result.rows[0];
  if (!previous) return null;
  if (previous.employee_id && previous.employee_id !== employeeId) fail("请求编号已被其他账号使用", 409);
  if (previous.payload_hash && previous.payload_hash !== payloadHash(payload)) {
    fail("上次请求尚未确认且内容已变化，请刷新后核对订单状态", 409);
  }
  return includeFinancialDetails ? previous.response : redactFinancialDetails(previous.response);
}

async function saveIdempotent(
  client: DbClient,
  scope: string,
  requestKey: string,
  employeeId: string,
  response: unknown,
  payload: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO idempotency_keys (scope, request_key, employee_id, response, payload_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (scope, request_key) DO NOTHING`,
    [scope, requestKey, employeeId, JSON.stringify(response), payloadHash(payload)]
  );
}

async function logOperation(
  client: DbClient,
  employeeId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  detail: unknown = {}
): Promise<void> {
  await client.query(
    `INSERT INTO operation_logs (employee_id, action, entity_type, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [employeeId, action, entityType, entityId, JSON.stringify(detail)]
  );
}

async function makePrintJobs(
  client: DbClient,
  orderId: string,
  batchId: string | null,
  kind: "KITCHEN" | "RETURN" | "RECEIPT",
  payload: unknown,
  copies = 2
): Promise<void> {
  for (let copyNo = 1; copyNo <= copies; copyNo += 1) {
    const printPayload = preparePrintPayload(kind, { ...(payload as object), copyNo } as Record<string, unknown>);
    await client.query(
      `INSERT INTO print_jobs (order_id, batch_id, kind, copy_no, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [orderId, batchId, kind, copyNo, JSON.stringify(printPayload)]
    );
  }
}

async function expireStalePrintClaims(client: DbClient = pool): Promise<void> {
  await client.query(
    `UPDATE print_jobs SET status = 'NEEDS_CHECK',
       last_error = COALESCE(NULLIF(last_error, ''), '打印设备领取超时，打印结果未知')
     WHERE status = 'CLAIMED' AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')`
  );
}

async function currentOrder(client: DbClient, orderId: string, lock = false) {
  const result = await client.query<{
    id: string;
    table_id: string | null;
    customer_id: string | null;
    guest_label: string | null;
    people_count: number;
    status: string;
    order_version: number;
    business_date: string;
  }>(
    `SELECT id, table_id, customer_id, guest_label, people_count, status, order_version, business_date
     FROM orders WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [orderId]
  );
  const order = result.rows[0];
  if (!order) fail("订单不存在", 404);
  return order;
}

function printOrderPayload(order: Record<string, unknown>, items: Array<Record<string, unknown>>, title: string) {
  const createdAt = new Date().toISOString();
  return {
    title,
    orderId: order.id,
    tableNumber: order.tableNumber,
    tableName: order.tableName,
    peopleCount: order.peopleCount,
    customer: (order.customer as { name?: string; phone?: string | null } | undefined)?.name || "散客",
    phone: (order.customer as { phone?: string | null } | undefined)?.phone || null,
    orderNote: title === "结账小票" ? "" : text(order.orderNote),
    openedAt: order.openedAt || null,
    settledAt: order.settledAt || null,
    createdAt,
    layout: {
      tableNameSize: "LARGE",
      dishNameSize: "LARGE",
      quantityInline: true,
      showItemPrice: false
    },
    items: items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      priceFen: Number(item.priceFen ?? item.price_fen ?? 0),
      note: item.note || ""
    }))
  };
}

function normalizeReprintTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  const base = title.replace(/(?:\s*[（(]补打[）)])+\s*$/u, "").trim() || "打印任务";
  return `${base}（补打）`;
}

type PrinterLine = { text: string; align: "LEFT" | "CENTER"; size: "NORMAL" | "LARGE" | "EMPHASIS" };

function printerDisplayWidth(value: string): number {
  return Array.from(value).reduce((width, character) => width + (character.codePointAt(0)! <= 0x7f ? 1 : 2), 0);
}

function printerColumns(size: PrinterLine["size"]): number {
  switch (size) {
    case "LARGE":
      return 21;
    case "EMPHASIS":
    case "NORMAL":
      return 42;
  }
}

function wrapPrinterText(value: string, maxWidth: number): string[] {
  if (!value) return [];
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const character of value) {
    const characterWidth = character.codePointAt(0)! <= 0x7f ? 1 : 2;
    if (lineWidth > 0 && lineWidth + characterWidth > maxWidth) {
      lines.push(line);
      line = "";
      lineWidth = 0;
    }
    line += character;
    lineWidth += characterWidth;
  }
  lines.push(line);
  return lines;
}

function printerTime(value: unknown): string {
  if (typeof value !== "string" || !value || value === "null") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value || "00";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function printerMoney(value: unknown): string {
  const fen = Number(value || 0);
  return `￥${(Number.isFinite(fen) ? fen / 100 : 0).toFixed(2)}`;
}

function printerItemNote(value: unknown): string {
  const parts = String(value || "").split(/[；;]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 1) parts[0] = parts[0].replace(/^备注[：:]\s*/, "");
  return parts.filter(Boolean).join("，");
}

function buildPrinterLines(kind: "KITCHEN" | "RETURN" | "RECEIPT", payload: Record<string, unknown>): PrinterLine[] {
  const receipt = kind === "RECEIPT";
  const lines: PrinterLine[] = [];
  const push = (
    value: string,
    align: PrinterLine["align"] = "LEFT",
    size: PrinterLine["size"] = "NORMAL",
    maxWidth = printerColumns(size)
  ) => {
    const wrapped = value ? wrapPrinterText(value, maxWidth) : [""];
    for (const text of wrapped) lines.push({ text, align, size });
  };
  const pushRight = (value: string, size: PrinterLine["size"], maxWidth = printerColumns(size)) => {
    const leadingSpaces = Math.max(0, maxWidth - printerDisplayWidth(value));
    push(`${" ".repeat(leadingSpaces)}${value}`, "LEFT", size, maxWidth);
  };
  const stringValue = (value: unknown, fallback = "") => value === null || value === undefined ? fallback : String(value);
  const tableName = stringValue(payload.tableName) || (Number(payload.tableNumber) > 0 ? `${Number(payload.tableNumber)}号桌` : "无桌台");
  const large = "LARGE" as const;
  const emphasis = "EMPHASIS" as const;
  const normal = "NORMAL" as const;
  const center = "CENTER" as const;
  const dishColumns = printerColumns(emphasis);
  const printNoteAndQuantity = (note: string, quantityLabel: string) => {
    const quantityWidth = printerDisplayWidth(quantityLabel);
    const maxNoteWidth = dishColumns - quantityWidth - 1;
    const noteText = `  ${note}`;
    if (maxNoteWidth < 1) {
      for (const noteLine of wrapPrinterText(noteText, dishColumns)) push(noteLine, "LEFT", normal, dishColumns);
      pushRight(quantityLabel, emphasis, dishColumns);
      return;
    }

    const noteLines = wrapPrinterText(noteText, dishColumns);
    let finalNoteLine = noteLines.pop() || "";
    if (printerDisplayWidth(finalNoteLine) > maxNoteWidth) {
      const wrappedFinalLine = wrapPrinterText(finalNoteLine, maxNoteWidth);
      finalNoteLine = wrappedFinalLine.pop() || "";
      noteLines.push(...wrappedFinalLine);
    }
    for (const noteLine of noteLines) push(noteLine, "LEFT", normal, dishColumns);

    const gap = dishColumns - printerDisplayWidth(finalNoteLine) - quantityWidth;
    if (gap < 1) {
      push(finalNoteLine, "LEFT", normal, dishColumns);
      pushRight(quantityLabel, emphasis, dishColumns);
      return;
    }
    push(`${finalNoteLine}${" ".repeat(gap)}${quantityLabel}`, "LEFT", normal, dishColumns);
  };

  const storeName = receipt ? stringValue(payload.storeName).trim() : "";
  if (storeName) {
    push(storeName, center, large);
    push("");
  }
  push(stringValue(payload.title, receipt ? "结账小票" : kind === "RETURN" ? "退菜单" : "备菜单"), center, large);
  push("");
  push(tableName, center, large);
  push(`人数：${Number(payload.peopleCount) || 0}    顾客：${stringValue(payload.customer, "散客")}`);
  if (payload.batchNo !== undefined && payload.batchNo !== null) push(`批次：第 ${Number(payload.batchNo) || 0} 批`);
  if (receipt) {
    push(`开台时间：${printerTime(payload.openedAt)}`);
    push(`结账时间：${printerTime(payload.settledAt || payload.createdAt)}`);
  } else {
    push(`时间：${printerTime(payload.createdAt)}`);
  }
  const orderNote = stringValue(payload.orderNote);
  if (!receipt && orderNote) push(`本单备注：${orderNote}`);
  push("------------------------------------------");

  const items = Array.isArray(payload.items) ? payload.items as Array<Record<string, unknown>> : [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    const name = stringValue(item.name) || "菜品";
    const quantity = Number(item.quantity) || 0;
    const unit = stringValue(item.unit, "份");
    const quantityLabel = `x${quantity}${unit}`;
    const note = receipt ? "" : printerItemNote(item.note);
    const sameDishLine = printerDisplayWidth(name) + 1 + printerDisplayWidth(quantityLabel) <= dishColumns;
    if (sameDishLine) {
      const gap = Math.max(1, dishColumns - printerDisplayWidth(name) - printerDisplayWidth(quantityLabel));
      push(`${name}${" ".repeat(gap)}${quantityLabel}`, "LEFT", emphasis);
      if (note) {
        for (const noteLine of wrapPrinterText(`  ${note}`, dishColumns)) push(noteLine, "LEFT", normal, dishColumns);
      }
    } else {
      for (const nameLine of wrapPrinterText(name, dishColumns)) push(nameLine, "LEFT", emphasis, dishColumns);
      if (note) printNoteAndQuantity(note, quantityLabel);
      else pushRight(quantityLabel, emphasis, dishColumns);
    }
    if (note && itemIndex < items.length - 1) push("");
  }

  if (receipt) {
    const totals = payload.totals && typeof payload.totals === "object" ? payload.totals as Record<string, unknown> : {};
    push("------------------------------------------");
    if (totals.grossFen !== undefined && totals.grossFen !== null) push(`菜品原价：${printerMoney(totals.grossFen)}`);
    const printDiscount = (label: string, value: unknown) => {
      const amount = Number(value);
      if (Number.isFinite(amount) && amount > 0) push(`${label}：-${printerMoney(amount)}`);
    };
    printDiscount("赠送", totals.giftFen);
    printDiscount("退菜", totals.returnFen);
    printDiscount("人工减免", totals.manualDiscountFen);
    printDiscount("积分抵扣", totals.pointsDiscountFen);
    push(`应收：${printerMoney(totals.dueFen ?? totals.receivedFen)}`);
    push(`实收：${printerMoney(totals.receivedFen)}`, "LEFT", emphasis);
    const paymentMethod = stringValue(payload.paymentMethod).trim();
    if (paymentMethod) push(`收款方式：${paymentMethod}`);
    if (Number(payload.redeemedPoints) > 0) push(`本次抵扣积分：${Number(payload.redeemedPoints)} 分`);
    if (Number(payload.earnedPoints) > 0) push(`本次获得积分：${Number(payload.earnedPoints)} 分`);
  }
  const footer = stringValue(payload.footer);
  if (footer) {
    push("------------------------------------------");
    push(footer, center);
  }
  push("");
  push("");
  push("");
  return lines;
}

function preparePrintPayload(
  kind: "KITCHEN" | "RETURN" | "RECEIPT",
  payload: Record<string, unknown>,
  rebuild = false
): Record<string, unknown> {
  if (!rebuild && Array.isArray(payload.printLines) && payload.printLines.length > 0) return payload;
  const normalized = payload.reprintOf
    ? { ...payload, title: normalizeReprintTitle(payload.title) }
    : { ...payload };
  return { ...normalized, printLines: buildPrinterLines(kind, normalized) };
}

const loginSchema = z.object({ username: z.string().trim().min(1).max(120), password: z.string().min(1).max(200) });
const settingsSchema = z.object({
  store_name: z.string().trim().min(1).max(120).optional(),
  receipt_footer: z.string().max(500).optional(),
  points_enabled: z.boolean().optional(),
  points_earn_fen: z.number().int().min(1).max(1_000_000_000).optional(),
  points_redeem_points: z.number().int().min(1).max(1_000_000_000).optional(),
  points_redeem_fen: z.number().int().min(1).max(1_000_000_000).optional(),
  printer_device_id: z.string().trim().max(120).optional(),
  printer_device_name: z.string().trim().max(120).optional()
}).strict();

type LoginBucket = { failures: number; resetAt: number; blockedUntil: number; touchedAt: number };
const loginBuckets = new Map<string, LoginBucket>();
const loginWindowMs = 15 * 60 * 1000;

function loginBucketKey(req: Request, kind: "ip" | "account"): string {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase().slice(0, 120) : "";
  return kind === "ip" ? `ip:${ip}` : `account:${ip}:${username}`;
}

function checkLoginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  for (const [key, bucket] of loginBuckets) {
    if (bucket.blockedUntil <= now && bucket.resetAt <= now) loginBuckets.delete(key);
  }
  for (const key of [loginBucketKey(req, "ip"), loginBucketKey(req, "account")]) {
    const bucket = loginBuckets.get(key);
    if (bucket && bucket.blockedUntil > now) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.blockedUntil - now) / 1000)));
      res.status(429).json({ error: "登录尝试过于频繁，请稍后再试" });
      return;
    }
  }
  next();
}

function recordLoginFailure(req: Request): void {
  const now = Date.now();
  const limits: Array<[string, number]> = [
    [loginBucketKey(req, "ip"), 20],
    [loginBucketKey(req, "account"), 5]
  ];
  for (const [key, limit] of limits) {
    const old = loginBuckets.get(key);
    const bucket = !old || old.resetAt <= now
      ? { failures: 0, resetAt: now + loginWindowMs, blockedUntil: 0, touchedAt: now }
      : old;
    bucket.failures += 1;
    bucket.touchedAt = now;
    if (bucket.failures >= limit) bucket.blockedUntil = now + loginWindowMs;
    loginBuckets.set(key, bucket);
  }
  if (loginBuckets.size > 10_000) {
    const oldest = [...loginBuckets.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt).slice(0, 1_000);
    for (const [key] of oldest) loginBuckets.delete(key);
  }
}

function clearAccountLoginFailures(req: Request): void {
  loginBuckets.delete(loginBucketKey(req, "account"));
}

app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "order-dinner", time: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.post("/api/auth/login", checkLoginRateLimit, async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      recordLoginFailure(req);
      fail("请输入账号和密码");
    }
    const result = await pool.query<{
      id: string;
      username: string;
      name: string;
      role: "OWNER" | "CASHIER";
      password_hash: string;
      auth_version: number;
    }>(
      `SELECT id, username, name, role, password_hash, auth_version FROM employees
       WHERE username = $1 AND active = true`,
      [parsed.data.username]
    );
    const employee = result.rows[0];
    if (!employee || !(await bcrypt.compare(parsed.data.password, employee.password_hash))) {
      recordLoginFailure(req);
      res.status(401).json({ error: "账号或密码不正确" });
      return;
    }
    clearAccountLoginFailures(req);
    const user: AuthUser = {
      id: employee.id,
      username: employee.username,
      name: employee.name,
      role: employee.role
    };
    res.json({ token: createToken(user, employee.auth_version), user });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/auth/me", requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: currentUser(req) });
});

app.post("/api/auth/event-ticket", requireAuth, (req: AuthenticatedRequest, res) => {
  const user = currentUser(req);
  const now = Date.now();
  for (const [ticket, value] of eventTickets) {
    if (value.expiresAt <= now) eventTickets.delete(ticket);
  }
  if (eventTickets.size >= 4096) {
    res.status(429).json({ error: "实时同步连接过多，请稍后重试" });
    return;
  }
  const ticket = crypto.randomBytes(32).toString("hex");
  eventTickets.set(ticket, {
    employeeId: user.id,
    authVersion: user.authVersion || 0,
    expiresAt: now + 30_000,
    tokenExpiresAt: req.tokenExpiresAt || now
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ ticket, expiresAt: new Date(now + 30_000).toISOString() });
});

app.get("/api/events", async (req, res) => {
  const ticket = text(req.query.ticket);
  const record = eventTickets.get(ticket);
  eventTickets.delete(ticket);
  if (!record || record.expiresAt <= Date.now()) {
    res.status(401).json({ error: "实时同步授权已失效，请重新连接" });
    return;
  }
  const employeeStreamCount = [...eventStreams].filter((stream) => stream.employeeId === record.employeeId).length;
  if (eventStreams.size >= 256 || employeeStreamCount >= 10) {
    res.status(429).json({ error: "实时同步连接数量已达上限" });
    return;
  }
  try {
    const employee = await pool.query<{ active: boolean; auth_version: number }>(
      `SELECT active, auth_version FROM employees WHERE id = $1`,
      [record.employeeId]
    );
    if (!employee.rows[0]?.active || employee.rows[0].auth_version !== record.authVersion) {
      res.status(401).json({ error: "账号已停用，请重新登录" });
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(": connected\n\n");
    const stream: EventStream = {
      response: res,
      heartbeat: setInterval(() => { void validateEventStream(stream); }, 25_000),
      employeeId: record.employeeId,
      authVersion: record.authVersion,
      tokenExpiresAt: record.tokenExpiresAt,
      validating: false
    };
    stream.heartbeat.unref();
    eventStreams.add(stream);
    res.on("close", () => {
      closeEventStream(stream);
    });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/tables", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.number, t.name, t.seats, t.status, t.sort_order,
              o.id AS order_id, o.people_count, o.opened_at,
              c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
              COALESCE((SELECT SUM((quantity - returned_quantity) * price_fen - gifted_quantity * price_fen)
                        FROM order_items WHERE order_id = o.id), 0) AS current_fen
       FROM restaurant_tables t
       LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'OPEN'
       LEFT JOIN customers c ON c.id = o.customer_id
       ORDER BY t.sort_order, t.number`
    );
    res.json({ tables: result.rows.map((row) => ({
      id: row.id,
      number: row.number,
      name: row.name,
      seats: row.seats,
      status: row.status,
      order: row.order_id
        ? {
            id: row.order_id,
            peopleCount: row.people_count,
            openedAt: row.opened_at,
            currentFen: Number(row.current_fen || 0),
            customer: row.customer_id
              ? { id: row.customer_id, name: row.customer_name, phone: maskPhone(row.customer_phone) }
              : { id: null, name: "散客", phone: null }
          }
        : null
    })) });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/tables", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const number = requirePositiveInteger(req.body?.number, "桌号必须是大于零的整数", 10_000);
    const seats = req.body?.seats === undefined ? 4 : requirePositiveInteger(req.body.seats, "座位数必须是大于零的整数", 500);
    const name = text(req.body?.name) || `${number}号桌`;
    const tableId = await withTransaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO restaurant_tables (number, name, seats, sort_order)
         VALUES ($1, $2, $3, $1) RETURNING id`,
        [number, name, seats]
      );
      await logOperation(client, user.id, "CREATE_TABLE", "TABLE", result.rows[0].id, { number, name, seats });
      return result.rows[0].id;
    });
    broadcastUpdate({ type: "table.updated", tableId });
    res.status(201).json({ tableId });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/tables/:tableId/open", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const tableId = routeParam(req, "tableId");
    const requestKey = requiredIdempotencyKey(req.body?.idempotencyKey);
    const requestPayload = idempotencyPayload(req.body);
    const phone = normalizedPhone(requestPayload.phone);
    const customerName = text(requestPayload.customerName) || null;
    const people = requestPayload.people === undefined ? 2 : requirePositiveInteger(requestPayload.people, "用餐人数必须是大于零的整数", 500);
    const response = await withTransaction(async (client) => {
      const previous = await readIdempotent(client, `open:${tableId}`, requestKey, user.id, requestPayload, user.role === "OWNER");
      if (previous) return previous;
      const tableResult = await client.query<{ id: string; number: number; name: string; status: string }>(
        `SELECT id, number, name, status FROM restaurant_tables WHERE id = $1 FOR UPDATE`,
        [tableId]
      );
      const table = tableResult.rows[0];
      if (!table) fail("桌台不存在", 404);
      if (table.status !== "AVAILABLE") fail("桌台已被占用或停用，请刷新桌台状态", 409);
      let customerId: string | null = null;
      if (phone) {
        customerId = await findOrCreateCustomer(client, phone, customerName);
      }
      const order = await client.query<{ id: string }>(
        `INSERT INTO orders
         (table_id, table_number_snapshot, table_name_snapshot, customer_id, guest_label, people_count, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [tableId, table.number, table.name, customerId, customerId ? null : (customerName || "散客"), people, user.id]
      );
      await client.query(`UPDATE restaurant_tables SET status = 'OCCUPIED', updated_at = now() WHERE id = $1`, [tableId]);
      await logOperation(client, user.id, "OPEN_TABLE", "ORDER", order.rows[0].id, { tableId, tableNumber: table.number, tableName: table.name });
      const result = await orderDetails(client, order.rows[0].id, user.role === "OWNER");
      await saveIdempotent(client, `open:${tableId}`, requestKey, user.id, result, requestPayload);
      return result;
    });
    broadcastUpdate({
      type: "order.created",
      orderId: String((response as Record<string, unknown>).id),
      tableId
    });
    res.status(201).json({ order: response });
  } catch (error) {
    publicError(res, error);
  }
});

app.delete("/api/tables/:tableId", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const tableId = routeParam(req, "tableId");
    await withTransaction(async (client) => {
      const table = await client.query<{ id: string; number: number; name: string; status: string }>(
        `SELECT id, number, name, status FROM restaurant_tables WHERE id = $1 FOR UPDATE`,
        [tableId]
      );
      if (!table.rows[0]) fail("桌台不存在", 404);
      if (table.rows[0].status === "OCCUPIED") fail("使用中的桌台不能删除，请先结束当前账单");
      const history = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM orders WHERE table_id = $1`,
        [tableId]
      );
      if (Number(history.rows[0]?.count || 0) > 0) fail("已有订单记录的桌台不能删除，可改名或停用");
      await client.query(`DELETE FROM restaurant_tables WHERE id = $1`, [tableId]);
      await logOperation(client, user.id, "DELETE_TABLE", "TABLE", tableId, { number: table.rows[0].number, name: table.rows[0].name });
    });
    broadcastUpdate({ type: "table.updated", tableId });
    res.json({ ok: true });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/orders/search", requireAuth, async (req, res) => {
  try {
    const includeFinancialDetails = (req as AuthenticatedRequest).user?.role === "OWNER";
    const limit = req.query.limit === undefined ? 50 : requirePositiveInteger(req.query.limit, "每页条数格式不正确", 100);
    const offsetValue = req.query.offset === undefined ? 0 : requireNonNegativeInteger(req.query.offset, "查询页码格式不正确");
    const params: unknown[] = [];
    const conditions: string[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const from = text(req.query.from);
    const to = text(req.query.to);
    const status = text(req.query.status);
    const keyword = text(req.query.q);
    const paymentMethod = text(req.query.paymentMethod);
    const minFenText = text(req.query.minFen);
    const maxFenText = text(req.query.maxFen);
    if (from) {
      validateDate(from);
      conditions.push(`o.business_date >= ${add(from)}::date`);
    }
    if (to) {
      validateDate(to);
      if (from && from > to) fail("开始日期不能晚于结束日期");
      conditions.push(`o.business_date <= ${add(to)}::date`);
    }
    if (["OPEN", "SETTLED", "REVERSED", "VOID"].includes(status)) conditions.push(`o.status = ${add(status)}`);
    if (paymentMethod) conditions.push(`COALESCE(last_settlement.payment_method, '') = ${add(paymentMethod)}`);
    if (keyword) {
      const pattern = add(`%${keyword}%`);
      conditions.push(`(
        o.id::text ILIKE ${pattern}
        OR COALESCE(c.name, o.guest_label, '') ILIKE ${pattern}
        OR COALESCE(c.phone, '') ILIKE ${pattern}
        OR COALESCE(o.table_name_snapshot, t.name, '') ILIKE ${pattern}
        OR COALESCE(o.table_number_snapshot::text, t.number::text, '') ILIKE ${pattern}
      )`);
    }
    if (minFenText) {
      const minFen = requireNonNegativeInteger(minFenText, "最低金额格式不正确");
      conditions.push(`(
        CASE WHEN o.status = 'SETTLED' THEN COALESCE(last_settlement.gross_fen - last_settlement.gift_fen - last_settlement.return_fen - last_settlement.manual_discount_fen - last_settlement.points_discount_fen, 0)
             WHEN o.status = 'OPEN' THEN current_total.current_fen ELSE 0 END
      ) >= ${add(minFen)}`);
    }
    if (maxFenText) {
      const maxFen = requireNonNegativeInteger(maxFenText, "最高金额格式不正确");
      conditions.push(`(
        CASE WHEN o.status = 'SETTLED' THEN COALESCE(last_settlement.gross_fen - last_settlement.gift_fen - last_settlement.return_fen - last_settlement.manual_discount_fen - last_settlement.points_discount_fen, 0)
             WHEN o.status = 'OPEN' THEN current_total.current_fen ELSE 0 END
      ) <= ${add(maxFen)}`);
    }
    const result = await pool.query(
      `SELECT o.id, o.table_id,
              COALESCE(o.table_number_snapshot, t.number) AS table_number,
              COALESCE(o.table_name_snapshot, t.name) AS table_name,
              o.customer_id, COALESCE(c.name, o.guest_label, '散客') AS customer_name,
              c.phone AS customer_phone, o.people_count, o.status, o.business_date,
              o.opened_at, o.settled_at, o.ended_at, o.end_reason,
              CASE WHEN o.status = 'SETTLED' THEN COALESCE(last_settlement.gross_fen - last_settlement.gift_fen - last_settlement.return_fen - last_settlement.manual_discount_fen - last_settlement.points_discount_fen, 0)
                   WHEN o.status = 'OPEN' THEN current_total.current_fen ELSE 0 END::int AS amount_fen,
              CASE WHEN o.status = 'SETTLED' THEN COALESCE(last_settlement.gross_fen - last_settlement.gift_fen - last_settlement.return_fen - last_settlement.manual_discount_fen - last_settlement.points_discount_fen, 0)
                   WHEN o.status = 'OPEN' THEN current_total.current_fen ELSE NULL END::int AS revenue_fen,
              ${includeFinancialDetails ? "COALESCE(cost_total.cost_fen, 0)::int" : "NULL::int"} AS cost_fen,
              last_settlement.payment_method, last_settlement.status AS settlement_status,
              last_settlement.id AS settlement_id,
              COALESCE(item_total.item_count, 0)::int AS item_count
       FROM orders o
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(GREATEST(0, (oi.quantity - oi.returned_quantity) * oi.price_fen - oi.gifted_quantity * oi.price_fen)), 0)::int AS current_fen
         FROM order_items oi WHERE oi.order_id = o.id
       ) current_total ON true
       LEFT JOIN LATERAL (
         SELECT s.id, s.received_fen, s.gross_fen, s.gift_fen, s.return_fen,
                s.manual_discount_fen, s.points_discount_fen, s.payment_method, s.status
         FROM settlements s WHERE s.order_id = o.id AND s.status = 'ACTIVE'
         ORDER BY s.version DESC, s.settled_at DESC LIMIT 1
       ) last_settlement ON true
       ${includeFinancialDetails ? `LEFT JOIN LATERAL (
         SELECT COALESCE(SUM((oi.quantity - oi.returned_quantity + oi.returned_made_quantity) * oi.cost_fen), 0) AS cost_fen
         FROM order_items oi WHERE oi.order_id = o.id
       ) cost_total ON true` : ""}
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(oi.quantity), 0) AS item_count
         FROM order_items oi WHERE oi.order_id = o.id
       ) item_total ON true
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY o.opened_at DESC, o.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit + 1, offsetValue]
    );
    const hasMore = result.rows.length > limit;
    const pageRows = result.rows.slice(0, limit);
    res.json({
      orders: pageRows.map((row) => {
        const safeRow = {
          ...row,
          customer_phone: maskPhone(row.customer_phone),
          amount_fen: Number(row.amount_fen || 0),
          item_count: Number(row.item_count || 0),
          revenue_fen: row.revenue_fen === null || row.revenue_fen === undefined ? null : Number(row.revenue_fen)
        } as Record<string, unknown>;
        if (includeFinancialDetails) {
          safeRow.cost_fen = Number(row.cost_fen || 0);
          safeRow.gross_profit_fen = row.revenue_fen === null || row.revenue_fen === undefined
            ? null
            : Number(row.revenue_fen || 0) - Number(row.cost_fen || 0);
          safeRow.gross_margin_percent = row.revenue_fen === null || row.revenue_fen === undefined
            ? null
            : marginPercent(Number(row.revenue_fen || 0), Number(row.cost_fen || 0));
        } else {
          delete safeRow.cost_fen;
        }
        return safeRow;
      }),
      hasMore,
      nextOffset: offsetValue + pageRows.length
    });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/orders/:orderId", requireAuth, async (req, res) => {
  try {
    const includeFinancialDetails = (req as AuthenticatedRequest).user?.role === "OWNER";
    const order = await withReadOnlySnapshot((client) => orderDetails(client, routeParam(req, "orderId"), includeFinancialDetails));
    res.json({ order });
  } catch (error) {
    publicError(res, error);
  }
});

app.patch("/api/orders/:orderId/note", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const orderId = routeParam(req, "orderId");
    const note = text(req.body?.note).slice(0, 500);
    const response = await withTransaction(async (client) => {
      const order = await currentOrder(client, orderId, true);
      if (order.status !== "OPEN") fail("只有进行中的订单可以修改备注");
      await client.query(`UPDATE orders SET order_note = $1, updated_at = now() WHERE id = $2`, [note, orderId]);
      await logOperation(client, user.id, "UPDATE_ORDER_NOTE", "ORDER", orderId, { note });
      return orderDetails(client, orderId, user.role === "OWNER");
    });
    broadcastUpdate({ type: "order.updated", orderId, tableId: (response.tableId as string | null) ?? null });
    res.json({ order: response });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/orders/:orderId/end", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const orderId = routeParam(req, "orderId");
    const requestKey = requiredIdempotencyKey(req.body?.idempotencyKey);
    const requestPayload = idempotencyPayload(req.body);
    const reason = text(requestPayload.reason) || "未结账直接结束";
    const response = await withTransaction(async (client) => {
      const previous = await readIdempotent(client, `end:${orderId}`, requestKey, user.id, requestPayload, user.role === "OWNER");
      if (previous) return previous;
      const order = await currentOrder(client, orderId, true);
      if (order.status !== "OPEN") fail("订单已结束，请刷新后操作");
      await client.query(
        `UPDATE orders SET status = 'VOID', ended_at = now(), ended_by = $1, end_reason = $2, updated_at = now()
         WHERE id = $3`,
        [user.id, reason, orderId]
      );
      if (order.table_id) {
        await client.query(`UPDATE restaurant_tables SET status = 'AVAILABLE', updated_at = now() WHERE id = $1`, [order.table_id]);
      }
      await logOperation(client, user.id, "END_ORDER_WITHOUT_PAYMENT", "ORDER", orderId, { reason });
      const details = await orderDetails(client, orderId, user.role === "OWNER");
      await saveIdempotent(client, `end:${orderId}`, requestKey, user.id, details, requestPayload);
      return details;
    });
    broadcastUpdate({
      type: "order.ended",
      orderId,
      tableId: ((response as Record<string, unknown>).tableId as string | null) ?? null
    });
    res.json({ order: response });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/orders/:orderId/items", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const orderId = routeParam(req, "orderId");
    const requestKey = requiredIdempotencyKey(req.body?.idempotencyKey);
    const requestPayload = idempotencyPayload(req.body);
    const printCopies = requestPayload.copies === undefined
      ? 2
      : requirePositiveInteger(requestPayload.copies, "备菜单打印份数必须在1到20份之间", 20);
    const rawItems = Array.isArray(requestPayload.items) ? requestPayload.items : [];
    if (!rawItems.length) fail("请选择至少一道菜品");
    const response = await withTransaction(async (client) => {
      const previous = await readIdempotent(client, `items:${orderId}`, requestKey, user.id, requestPayload, user.role === "OWNER");
      if (previous) return previous;
      const order = await currentOrder(client, orderId, true);
      if (order.status !== "OPEN") fail("订单已结账或已撤销，请刷新后操作");
      const batch = await client.query<{ id: string; batch_no: number }>(
        `INSERT INTO order_batches (order_id, batch_no, kind, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id, batch_no`,
        [orderId, order.order_version + 1, order.order_version === 0 ? "INITIAL" : "ADD", user.id]
      );
      const inserted: Array<Record<string, unknown>> = [];
      for (const raw of rawItems) {
        const dishId = text(raw?.dishId);
        const quantity = requirePositiveInteger(raw?.quantity, "菜品数量不正确", 100_000);
        if (!dishId || quantity < 1) fail("菜品数量不正确");
        const dishResult = await client.query<{
          id: string;
          name: string;
          pinyin: string;
          unit: string;
          price_fen: number;
          cost_fen: number;
          category_name: string | null;
        }>(
          `SELECT d.id, d.name, d.pinyin, d.unit, d.price_fen, d.cost_fen, c.name AS category_name
           FROM dishes d LEFT JOIN categories c ON c.id = d.category_id
           WHERE d.id = $1 AND d.on_sale = true`,
          [dishId]
        );
        const dish = dishResult.rows[0];
        if (!dish) fail("菜品不存在或已停售");
        const groups = await dishOptionGroups(client, dish.id);
        const options = optionSelections(groups, raw?.options, raw?.note);
        const item = await client.query<{ id: string }>(
          `INSERT INTO order_items
           (batch_id, order_id, dish_id, dish_name, category_name, unit, price_fen, cost_fen, quantity, note, option_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) RETURNING id`,
          [batch.rows[0].id, orderId, dish.id, dish.name, dish.category_name || "未分类", dish.unit, dish.price_fen, dish.cost_fen, quantity, options.note, JSON.stringify(options.snapshot)]
        );
        inserted.push({ id: item.rows[0].id, name: dish.name, unit: dish.unit, priceFen: dish.price_fen, quantity, note: options.note });
      }
      await client.query(`UPDATE orders SET order_version = order_version + 1, updated_at = now() WHERE id = $1`, [orderId]);
      const details = await orderDetails(client, orderId, user.role === "OWNER");
      await makePrintJobs(
        client,
        orderId,
        batch.rows[0].id,
        "KITCHEN",
        { ...printOrderPayload(details, inserted, "备菜单"), batchNo: batch.rows[0].batch_no },
        printCopies
      );
      await logOperation(client, user.id, "ADD_ITEMS", "ORDER", orderId, { batchNo: batch.rows[0].batch_no, items: inserted });
      await saveIdempotent(client, `items:${orderId}`, requestKey, user.id, details, requestPayload);
      return details;
    });
    broadcastUpdate({
      type: "order.updated",
      orderId,
      tableId: ((response as Record<string, unknown>).tableId as string | null) ?? null
    });
    res.status(201).json({ order: response });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/orders/:orderId/items/:itemId/gift", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const orderId = routeParam(req, "orderId");
    const itemId = routeParam(req, "itemId");
    const requestKey = requiredIdempotencyKey(req.body?.idempotencyKey);
    const requestPayload = idempotencyPayload(req.body);
    const quantity = requirePositiveInteger(requestPayload.quantity, "赠送数量必须是大于零的整数", 100_000);
    const response = await withTransaction(async (client) => {
      const previous = await readIdempotent(client, `gift:${orderId}:${itemId}`, requestKey, user.id, requestPayload, user.role === "OWNER");
      if (previous) return previous;
      const order = await currentOrder(client, orderId, true);
      if (order.status !== "OPEN") fail("订单不是进行中状态");
      const itemResult = await client.query<ItemRow>(
        `SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE`,
        [itemId, orderId]
      );
      const item = itemResult.rows[0];
      if (!item) fail("订单菜品不存在", 404);
      const available = item.quantity - item.returned_quantity - item.gifted_quantity;
      if (quantity > available) fail("赠送数量超过可操作数量");
      await client.query(`UPDATE order_items SET gifted_quantity = gifted_quantity + $1 WHERE id = $2`, [quantity, itemId]);
      await logOperation(client, user.id, "GIFT_ITEM", "ORDER_ITEM", itemId, { orderId, quantity, reason: text(requestPayload.reason) });
      const details = await orderDetails(client, orderId, user.role === "OWNER");
      await saveIdempotent(client, `gift:${orderId}:${itemId}`, requestKey, user.id, details, requestPayload);
      return details;
    });
    broadcastUpdate({
      type: "order.updated",
      orderId,
      tableId: ((response as Record<string, unknown>).tableId as string | null) ?? null
    });
    res.json({ order: response });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/orders/:orderId/items/:itemId/return", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const orderId = routeParam(req, "orderId");
    const itemId = routeParam(req, "itemId");
    const requestKey = requiredIdempotencyKey(req.body?.idempotencyKey);
    const requestPayload = idempotencyPayload(req.body);
    const quantity = requirePositiveInteger(requestPayload.quantity, "退菜数量必须是大于零的整数", 100_000);
    const response = await withTransaction(async (client) => {
      const previous = await readIdempotent(client, `return:${orderId}:${itemId}`, requestKey, user.id, requestPayload, user.role === "OWNER");
      if (previous) return previous;
      const order = await currentOrder(client, orderId, true);
      if (order.status !== "OPEN") fail("订单不是进行中状态");
      const itemResult = await client.query<ItemRow>(
        `SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE`,
        [itemId, orderId]
      );
      const item = itemResult.rows[0];
      if (!item) fail("订单菜品不存在", 404);
      const available = item.quantity - item.returned_quantity - item.gifted_quantity;
      if (quantity > available) fail("退菜数量超过可操作数量");
      const made = requestPayload.made === true;
      const batch = await client.query<{ id: string; batch_no: number }>(
        `INSERT INTO order_batches (order_id, batch_no, kind, created_by)
         VALUES ($1, $2, 'RETURN', $3) RETURNING id, batch_no`,
        [orderId, order.order_version + 1, user.id]
      );
      await client.query(
        `UPDATE order_items SET returned_quantity = returned_quantity + $1,
         returned_made_quantity = returned_made_quantity + $2 WHERE id = $3`,
        [quantity, made ? quantity : 0, itemId]
      );
      await client.query(`UPDATE orders SET order_version = order_version + 1, updated_at = now() WHERE id = $1`, [orderId]);
      const details = await orderDetails(client, orderId, user.role === "OWNER");
      const returnItem = {
        name: item.dish_name,
        unit: item.unit,
        priceFen: item.price_fen,
        quantity,
        note: `${made ? "已制作" : "未制作"}${text(requestPayload.reason) ? `，${text(requestPayload.reason)}` : ""}`
      };
      await makePrintJobs(
        client,
        orderId,
        batch.rows[0].id,
        "RETURN",
        { ...printOrderPayload(details, [returnItem], "退菜单"), batchNo: batch.rows[0].batch_no },
        2
      );
      await logOperation(client, user.id, "RETURN_ITEM", "ORDER_ITEM", itemId, {
        orderId,
        quantity,
        made,
        reason: text(requestPayload.reason)
      });
      await saveIdempotent(client, `return:${orderId}:${itemId}`, requestKey, user.id, details, requestPayload);
      return details;
    });
    broadcastUpdate({
      type: "order.updated",
      orderId,
      tableId: ((response as Record<string, unknown>).tableId as string | null) ?? null
    });
    res.json({ order: response });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/orders/:orderId/checkout", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const orderId = routeParam(req, "orderId");
    const requestKey = requiredIdempotencyKey(req.body?.idempotencyKey);
    const requestPayload = idempotencyPayload(req.body);
    const receiptCopies = requestPayload.receiptCopies === undefined
      ? 1
      : requirePositiveInteger(requestPayload.receiptCopies, "小票打印份数必须在1到20份之间", 20);
    const response = await withTransaction(async (client) => {
      const previous = await readIdempotent(client, `checkout:${orderId}`, requestKey, user.id, requestPayload, user.role === "OWNER");
      if (previous) return previous;
      const order = await currentOrder(client, orderId, true);
      if (order.status !== "OPEN") fail("订单已结账或已撤销，请刷新后操作");
      const items = await orderItems(client, orderId);
      const totals = calculateTotals(items);
      const settings = await getSettings(client);
      const enabled = settingBoolean(settings, "points_enabled", true);
      const earnFen = settingNumber(settings, "points_earn_fen", 100);
      const redeemPoints = settingNumber(settings, "points_redeem_points", 10);
      const redeemFen = settingNumber(settings, "points_redeem_fen", 100);
      const manualInput = req.body?.manualDiscountFen === undefined
        ? 0
        : requireNonNegativeInteger(req.body.manualDiscountFen, "人工减免金额格式不正确");
      let manualDiscountFen = Math.min(totals.subtotalFen, manualInput);
      const targetReceived = req.body?.targetReceivedFen === undefined
        ? null
        : requireNonNegativeInteger(req.body.targetReceivedFen, "目标实收金额格式不正确");
      if (targetReceived !== null) {
        if (targetReceived > totals.subtotalFen) fail("目标实收不能高于应收");
        manualDiscountFen = totals.subtotalFen - targetReceived;
      }
      if (req.body?.usePoints !== undefined && typeof req.body.usePoints !== "boolean") fail("积分抵扣选择不正确");
      const legacyPoints = req.body?.pointsToRedeem === undefined
        ? 0
        : requireNonNegativeInteger(req.body.pointsToRedeem, "积分抵扣数量格式不正确");
      const usePoints = req.body?.usePoints === undefined ? legacyPoints > 0 : req.body.usePoints;
      let customerBalance = 0;
      if (order.customer_id) {
        const customerResult = await client.query<{ points_balance: number }>(
          `SELECT points_balance FROM customers WHERE id = $1 FOR UPDATE`,
          [order.customer_id]
        );
        customerBalance = customerResult.rows[0]?.points_balance ?? 0;
      } else if (usePoints) {
        fail("散客不能使用积分");
      }
      if (usePoints && !enabled) fail("积分功能未开启");
      const maxByBalance = Math.floor(customerBalance / redeemPoints) * redeemPoints;
      const maxByAmount = Math.floor(Math.max(0, totals.subtotalFen - manualDiscountFen) / redeemFen) * redeemPoints;
      const requestedPoints = usePoints ? Math.min(maxByBalance, maxByAmount) : 0;
      const pointsDiscountFen = Math.floor(requestedPoints / redeemPoints) * redeemFen;
      const receivedFen = totals.subtotalFen - manualDiscountFen - pointsDiscountFen;
      const paidFen = req.body?.receivedFen === undefined
        ? receivedFen
        : requireNonNegativeInteger(req.body.receivedFen, "实收金额格式不正确");
      if (paidFen !== receivedFen) fail(`收款金额不匹配，应收 ${receivedFen} 分`);
      const paymentMethod = text(req.body?.paymentMethod) || "现金";
      if (!["现金", "微信", "支付宝", "银行卡", "其他"].includes(paymentMethod)) fail("收款方式不正确");
      const earnedPoints = enabled && order.customer_id ? Math.floor(receivedFen / earnFen) : 0;
      const settlement = await client.query<{ id: string }>(
        `INSERT INTO settlements
         (order_id, gross_fen, gift_fen, return_fen, manual_discount_fen, points_discount_fen,
          received_fen, payment_method, earned_points, redeemed_points, operator_id, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          orderId,
          totals.grossFen,
          totals.giftFen,
          totals.returnFen,
          manualDiscountFen,
          pointsDiscountFen,
          receivedFen,
          paymentMethod,
          earnedPoints,
          requestedPoints,
          user.id,
          text(req.body?.reason)
        ]
      );
      const newBalance = customerBalance - requestedPoints + earnedPoints;
      if (order.customer_id) {
        await client.query(`UPDATE customers SET points_balance = $1, updated_at = now() WHERE id = $2`, [newBalance, order.customer_id]);
        if (requestedPoints) {
          await client.query(
            `INSERT INTO points_ledger
             (customer_id, order_id, settlement_id, delta, kind, balance_after, operator_id, note)
             VALUES ($1, $2, $3, $4, 'REDEEM', $5, $6, '结账抵扣')`,
            [order.customer_id, orderId, settlement.rows[0].id, -requestedPoints, customerBalance - requestedPoints, user.id]
          );
        }
        if (earnedPoints) {
          await client.query(
            `INSERT INTO points_ledger
             (customer_id, order_id, settlement_id, delta, kind, balance_after, operator_id, note)
             VALUES ($1, $2, $3, $4, 'EARN', $5, $6, '结账获得')`,
            [order.customer_id, orderId, settlement.rows[0].id, earnedPoints, newBalance, user.id]
          );
        }
      }
      await client.query(`UPDATE orders SET status = 'SETTLED', settled_at = now(), updated_at = now() WHERE id = $1`, [orderId]);
      if (order.table_id) {
        await client.query(`UPDATE restaurant_tables SET status = 'AVAILABLE', updated_at = now() WHERE id = $1`, [order.table_id]);
      }
      const details = await orderDetails(client, orderId, user.role === "OWNER");
      const receiptPayload = {
        ...printOrderPayload(details, details.items as Array<Record<string, unknown>>, "结账小票"),
        storeName: text(settings.store_name, "我的餐厅"),
        totals: {
          grossFen: totals.grossFen,
          giftFen: totals.giftFen,
          returnFen: totals.returnFen,
          manualDiscountFen,
          pointsDiscountFen,
          dueFen: receivedFen,
          receivedFen
        },
        paymentMethod,
        earnedPoints,
        redeemedPoints: requestedPoints,
        pointsBalance: newBalance,
        footer: text(settings.receipt_footer, "谢谢光临")
      };
      await makePrintJobs(client, orderId, null, "RECEIPT", receiptPayload, receiptCopies);
      await logOperation(client, user.id, "CHECKOUT", "ORDER", orderId, {
        settlementId: settlement.rows[0].id,
        receivedFen,
        paymentMethod,
        earnedPoints,
        requestedPoints
      });
      const result = { order: details, settlement: { id: settlement.rows[0].id, ...receiptPayload.totals, paymentMethod, earnedPoints, redeemedPoints: requestedPoints, pointsBalance: newBalance } };
      await saveIdempotent(client, `checkout:${orderId}`, requestKey, user.id, result, requestPayload);
      return result;
    });
    broadcastUpdate({
      type: "order.settled",
      orderId,
      tableId: ((((response as Record<string, unknown>).order as Record<string, unknown>).tableId as string | null) ?? null)
    });
    res.json(response);
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/orders/:orderId/reopen", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const orderId = routeParam(req, "orderId");
    const requestKey = requiredIdempotencyKey(req.body?.idempotencyKey);
    const requestPayload = idempotencyPayload(req.body);
    const response = await withTransaction(async (client) => {
      const previous = await readIdempotent(client, `reopen:${orderId}`, requestKey, user.id, requestPayload, user.role === "OWNER");
      if (previous) return previous;
      const original = await currentOrder(client, orderId, true);
      if (original.status !== "SETTLED") fail("只有已结账订单可以撤销重结");
      const settlementResult = await client.query<{
        id: string;
        earned_points: number;
        redeemed_points: number;
        status: string;
      }>(
        `SELECT id, earned_points, redeemed_points, status FROM settlements
         WHERE order_id = $1 AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1 FOR UPDATE`,
        [orderId]
      );
      const settlement = settlementResult.rows[0];
      if (!settlement) fail("找不到有效结账记录");
      let balanceAfter = 0;
      if (original.customer_id) {
        const customer = await client.query<{ points_balance: number }>(
          `SELECT points_balance FROM customers WHERE id = $1 FOR UPDATE`,
          [original.customer_id]
        );
        const balance = customer.rows[0]?.points_balance ?? 0;
        if (balance < settlement.earned_points) fail("顾客当前积分不足以撤销本次获得的积分，请先处理关联消费");
        balanceAfter = balance;
        if (settlement.earned_points) {
          balanceAfter -= settlement.earned_points;
          await client.query(
            `INSERT INTO points_ledger
             (customer_id, order_id, settlement_id, delta, kind, balance_after, operator_id, note)
             VALUES ($1, $2, $3, $4, 'REVERSE_EARN', $5, $6, '撤销结账收回积分')`,
            [original.customer_id, orderId, settlement.id, -settlement.earned_points, balanceAfter, user.id]
          );
        }
        if (settlement.redeemed_points) {
          balanceAfter += settlement.redeemed_points;
          await client.query(
            `INSERT INTO points_ledger
             (customer_id, order_id, settlement_id, delta, kind, balance_after, operator_id, note)
             VALUES ($1, $2, $3, $4, 'REVERSE_REDEEM', $5, $6, '撤销结账返还积分')`,
            [original.customer_id, orderId, settlement.id, settlement.redeemed_points, balanceAfter, user.id]
          );
        }
        await client.query(`UPDATE customers SET points_balance = $1, updated_at = now() WHERE id = $2`, [balanceAfter, original.customer_id]);
      }
      await client.query(
        `UPDATE settlements SET status = 'REVERSED', reversed_by = $1, reversed_at = now() WHERE id = $2`,
        [user.id, settlement.id]
      );
      await client.query(`UPDATE orders SET status = 'REVERSED', updated_at = now() WHERE id = $1`, [orderId]);
      const newOrder = await client.query<{ id: string }>(
        `INSERT INTO orders
         (table_id, table_number_snapshot, table_name_snapshot, customer_id, guest_label, people_count, status,
          parent_order_id, created_by, business_date, order_note, order_version)
         SELECT NULL, COALESCE(source.table_number_snapshot, t.number), COALESCE(source.table_name_snapshot, t.name),
                source.customer_id, source.guest_label, source.people_count, 'OPEN', $1, $2,
                source.business_date, source.order_note,
                COALESCE((SELECT MAX(batch_no) FROM order_batches WHERE order_id = source.id), 0)
         FROM orders source LEFT JOIN restaurant_tables t ON t.id = source.table_id WHERE source.id = $3
         RETURNING id`,
        [orderId, user.id, orderId]
      );
      const newOrderId = newOrder.rows[0].id;
      const batches = await client.query<{ id: string; batch_no: number; kind: string }>(
        `SELECT id, batch_no, kind FROM order_batches WHERE order_id = $1 ORDER BY batch_no`,
        [orderId]
      );
      const batchIds = new Map<string, string>();
      for (const batch of batches.rows) {
        const copied = await client.query<{ id: string }>(
          `INSERT INTO order_batches (order_id, batch_no, kind, created_by)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [newOrderId, batch.batch_no, batch.kind, user.id]
        );
        batchIds.set(batch.id, copied.rows[0].id);
      }
      const oldItems = await client.query<ItemRow>(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at, id`, [orderId]);
      for (const item of oldItems.rows) {
        const copiedBatchId = batchIds.get(item.batch_id);
        if (!copiedBatchId) continue;
        await client.query(
          `INSERT INTO order_items
           (batch_id, order_id, dish_id, dish_name, category_name, unit, price_fen, cost_fen, quantity,
            gifted_quantity, returned_quantity, returned_made_quantity, note, option_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
          [copiedBatchId, newOrderId, item.dish_id, item.dish_name, item.category_name, item.unit, item.price_fen, item.cost_fen,
            item.quantity, item.gifted_quantity, item.returned_quantity, item.returned_made_quantity, item.note, JSON.stringify(item.option_snapshot || [])]
        );
      }
      await logOperation(client, user.id, "REOPEN_ORDER", "ORDER", orderId, { newOrderId, settlementId: settlement.id });
      const result = { originalOrderId: orderId, order: await orderDetails(client, newOrderId, true), pointsBalance: balanceAfter };
      await saveIdempotent(client, `reopen:${orderId}`, requestKey, user.id, result, requestPayload);
      return result;
    });
    broadcastUpdate({
      type: "order.reopened",
      orderId,
      newOrderId: String(((response as Record<string, unknown>).order as Record<string, unknown>).id),
      tableId: null
    });
    res.json(response);
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/categories", requireAuth, async (req, res) => {
  try {
    const includeInactive = text(req.query.includeInactive) === "true"
      && (req as AuthenticatedRequest).user?.role === "OWNER";
    const result = await pool.query(
      `SELECT id, name, sort_order, active FROM categories
       ${includeInactive ? "" : "WHERE active = true"}
       ORDER BY active DESC, sort_order, name`
    );
    res.json({ categories: result.rows });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/categories", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const name = text(req.body?.name);
    if (!name) fail("分类名称不能为空");
    const category = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('order-dinner-category-order'))`);
      const nextSortOrder = req.body?.sortOrder === undefined
        ? Number((await client.query<{ next_order: number }>(`SELECT COALESCE(MAX(sort_order), 0) + 10 AS next_order FROM categories`)).rows[0]?.next_order || 10)
        : requireNonNegativeInteger(req.body.sortOrder, "分类顺序必须是非负整数");
      const result = await client.query<{ id: string; name: string }>(
        `INSERT INTO categories (name, sort_order) VALUES ($1, $2) RETURNING id, name`,
        [name, nextSortOrder]
      );
      await logOperation(client, user.id, "CREATE_CATEGORY", "CATEGORY", result.rows[0].id, { name });
      return result.rows[0];
    });
    broadcastUpdate({ type: "menu.updated" });
    res.status(201).json({ category });
  } catch (error) {
    publicError(res, error);
  }
});

app.put("/api/categories/order", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const parsed = z.object({ ids: z.array(z.string().uuid()).max(500) }).safeParse(req.body);
    if (!parsed.success || new Set(parsed.data?.ids || []).size !== parsed.data?.ids.length) {
      fail("分类顺序内容不正确，请刷新后重试");
    }
    const categories = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('order-dinner-category-order'))`);
      const active = await client.query<{ id: string }>(
        `SELECT id FROM categories WHERE active = true ORDER BY sort_order, name FOR UPDATE`
      );
      const ids = parsed.data.ids;
      if (ids.length !== active.rows.length || active.rows.some((row) => !ids.includes(row.id))) {
        fail("分类列表已变化，请刷新后重新排序", 409);
      }
      for (const [index, id] of ids.entries()) {
        await client.query(`UPDATE categories SET sort_order = $1, updated_at = now() WHERE id = $2 AND active = true`, [(index + 1) * 10, id]);
      }
      await logOperation(client, user.id, "REORDER_CATEGORIES", "CATEGORY", null, { ids });
      return (await client.query(
        `SELECT id, name, sort_order, active FROM categories WHERE active = true ORDER BY sort_order, name`
      )).rows;
    });
    broadcastUpdate({ type: "menu.updated" });
    res.json({ categories });
  } catch (error) {
    publicError(res, error);
  }
});

app.patch("/api/categories/:categoryId", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const categoryId = routeParam(req, "categoryId");
    const updates: string[] = [];
    const values: unknown[] = [];
    if (req.body?.name !== undefined) {
      const name = text(req.body.name);
      if (!name) fail("分类名称不能为空");
      values.push(name);
      updates.push(`name = $${values.length}`);
    }
    if (req.body?.active !== undefined) {
      if (typeof req.body.active !== "boolean") fail("分类状态不正确");
      values.push(req.body.active);
      updates.push(`active = $${values.length}`);
    }
    if (req.body?.sortOrder !== undefined) {
      const sortOrder = requireNonNegativeInteger(req.body.sortOrder, "分类顺序必须是非负整数");
      values.push(sortOrder);
      updates.push(`sort_order = $${values.length}`);
    }
    if (!updates.length) fail("没有要修改的内容");
    values.push(categoryId);
    const category = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('order-dinner-category-order'))`);
      const result = await client.query<{ id: string; name: string; active: boolean }>(
        `UPDATE categories SET ${updates.join(", ")}, updated_at = now()
         WHERE id = $${values.length} RETURNING id, name, active`,
        values
      );
      if (!result.rows[0]) fail("分类不存在", 404);
      await logOperation(client, user.id, req.body?.active === false ? "ARCHIVE_CATEGORY" : "UPDATE_CATEGORY", "CATEGORY", categoryId, req.body);
      return result.rows[0];
    });
    broadcastUpdate({ type: "menu.updated" });
    res.json({ category });
  } catch (error) {
    publicError(res, error);
  }
});

app.delete("/api/categories/:categoryId", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const categoryId = routeParam(req, "categoryId");
    await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('order-dinner-category-order'))`);
      const result = await client.query<{ id: string }>(
        `UPDATE categories SET active = false, updated_at = now() WHERE id = $1 AND active = true RETURNING id`,
        [categoryId]
      );
      if (!result.rows[0]) fail("分类不存在", 404);
      await logOperation(client, user.id, "ARCHIVE_CATEGORY", "CATEGORY", categoryId);
    });
    broadcastUpdate({ type: "menu.updated" });
    res.json({ ok: true });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/dishes", requireAuth, async (req, res) => {
  try {
    const includeFinancialDetails = (req as AuthenticatedRequest).user?.role === "OWNER";
    const query = text(req.query.q);
    const categoryId = text(req.query.categoryId);
    const params: string[] = [];
    const conditions = ["d.on_sale = true"];
    if (categoryId) {
      params.push(categoryId);
      conditions.push(`d.category_id = $${params.length}`);
    }
    if (query) {
      params.push(`%${query}%`);
      conditions.push(`(d.name ILIKE $${params.length} OR d.pinyin ILIKE $${params.length})`);
    }
    const result = await pool.query(
      `SELECT d.id, d.category_id, c.name AS category_name, d.name, d.pinyin, d.unit,
              d.price_fen, ${includeFinancialDetails ? "d.cost_fen" : "NULL::integer"} AS cost_fen,
              d.image_url, d.on_sale, d.sort_order,
              ${includeFinancialDetails
                ? `CASE WHEN d.price_fen > 0
                       THEN ROUND(((d.price_fen - d.cost_fen)::numeric / d.price_fen) * 10000) / 100
                       ELSE 0 END`
                : "NULL::numeric"} AS gross_margin_percent,
              COALESCE((
                SELECT json_agg(json_build_object(
                  'id', g.id,
                  'name', g.name,
                  'required', g.required,
                  'allowMultiple', g.allow_multiple,
                  'options', COALESCE((
                    SELECT json_agg(json_build_object('id', o.id, 'label', o.label) ORDER BY o.sort_order, o.id)
                    FROM dish_options o
                    WHERE o.group_id = g.id AND o.active = true
                  ), '[]'::json)
                ) ORDER BY g.sort_order, g.name, g.id)
                FROM dish_option_groups g
                WHERE g.dish_id = d.id AND g.active = true
              ), '[]'::json) AS option_groups
       FROM dishes d LEFT JOIN categories c ON c.id = d.category_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY c.sort_order NULLS LAST, d.sort_order, d.name`,
      params
    );
    res.json({ dishes: result.rows.map((row) => {
      const { cost_fen, gross_margin_percent, ...safeRow } = row;
      return {
        ...safeRow,
        ...(includeFinancialDetails ? {
          cost_fen: Number(cost_fen || 0),
          gross_margin_percent: Number(gross_margin_percent || 0)
        } : {}),
        option_groups: row.option_groups || []
      };
    }) });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/dishes", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const name = text(req.body?.name);
    if (!name) fail("菜品名称不能为空");
    const categoryId = text(req.body?.categoryId) || null;
    const dishId = await withTransaction(async (client) => {
      if (categoryId) {
        const category = await client.query(`SELECT 1 FROM categories WHERE id = $1 AND active = true`, [categoryId]);
        if (!category.rows[0]) fail("所选分类不存在或已停用");
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO dishes (category_id, name, pinyin, unit, price_fen, cost_fen, image_url, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          categoryId,
          name,
          text(req.body?.pinyin),
          text(req.body?.unit) || "份",
          req.body?.priceFen === undefined ? 0 : requireNonNegativeInteger(req.body.priceFen, "售价必须是非负整数金额"),
          req.body?.costFen === undefined ? 0 : requireNonNegativeInteger(req.body.costFen, "成本必须是非负整数金额"),
          text(req.body?.imageUrl) || null,
          req.body?.sortOrder === undefined ? 0 : requireNonNegativeInteger(req.body.sortOrder, "菜品顺序必须是非负整数")
        ]
      );
      const id = result.rows[0].id;
      if (req.body?.optionGroups !== undefined) await replaceDishOptionGroups(client, id, req.body.optionGroups);
      await logOperation(client, user.id, "CREATE_DISH", "DISH", id, { name });
      return id;
    });
    broadcastUpdate({ type: "menu.updated" });
    res.status(201).json({ dishId });
  } catch (error) {
    publicError(res, error);
  }
});

app.patch("/api/dishes/:dishId", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const dishId = routeParam(req, "dishId");
    const fields: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (req.body?.name !== undefined) {
      const name = text(req.body.name);
      if (!name) fail("菜品名称不能为空");
      add("name", name);
    }
    if (req.body?.categoryId !== undefined) add("category_id", text(req.body.categoryId) || null);
    if (req.body?.pinyin !== undefined) add("pinyin", text(req.body.pinyin));
    if (req.body?.unit !== undefined) add("unit", text(req.body.unit) || "份");
    if (req.body?.priceFen !== undefined) add("price_fen", requireNonNegativeInteger(req.body.priceFen, "售价必须是非负整数金额"));
    if (req.body?.costFen !== undefined) add("cost_fen", requireNonNegativeInteger(req.body.costFen, "成本必须是非负整数金额"));
    if (req.body?.onSale !== undefined) {
      if (typeof req.body.onSale !== "boolean") fail("菜品销售状态不正确");
      add("on_sale", req.body.onSale);
    }
    if (req.body?.sortOrder !== undefined) {
      const sortOrder = requireNonNegativeInteger(req.body.sortOrder, "菜品顺序必须是非负整数");
      add("sort_order", sortOrder);
    }
    const hasOptionGroups = req.body?.optionGroups !== undefined;
    if (!fields.length && !hasOptionGroups) fail("没有要修改的内容");
    await withTransaction(async (client) => {
      const found = await client.query(`SELECT id FROM dishes WHERE id = $1 FOR UPDATE`, [dishId]);
      if (!found.rows[0]) fail("菜品不存在", 404);
      if (req.body?.categoryId) {
        const category = await client.query(`SELECT 1 FROM categories WHERE id = $1 AND active = true`, [text(req.body.categoryId)]);
        if (!category.rows[0]) fail("所选分类不存在或已停用");
      }
      if (fields.length) {
        values.push(dishId);
        const result = await client.query(
          `UPDATE dishes SET ${fields.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING id`,
          values
        );
        if (!result.rows[0]) fail("菜品不存在", 404);
      }
      if (hasOptionGroups) await replaceDishOptionGroups(client, dishId, req.body.optionGroups);
      await logOperation(client, user.id, "UPDATE_DISH", "DISH", dishId, req.body);
    });
    broadcastUpdate({ type: "menu.updated" });
    res.json({ ok: true });
  } catch (error) {
    publicError(res, error);
  }
});

app.delete("/api/dishes/:dishId", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const dishId = routeParam(req, "dishId");
    await withTransaction(async (client) => {
      const result = await client.query(`UPDATE dishes SET on_sale = false, updated_at = now() WHERE id = $1 RETURNING id`, [dishId]);
      if (!result.rows[0]) fail("菜品不存在", 404);
      await logOperation(client, user.id, "ARCHIVE_DISH", "DISH", dishId);
    });
    broadcastUpdate({ type: "menu.updated" });
    res.json({ ok: true });
  } catch (error) {
    publicError(res, error);
  }
});

app.put("/api/dishes/:dishId/options", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const dishId = routeParam(req, "dishId");
    await withTransaction(async (client) => {
      const dish = await client.query(`SELECT id FROM dishes WHERE id = $1 FOR UPDATE`, [dishId]);
      if (!dish.rows[0]) fail("菜品不存在", 404);
      await replaceDishOptionGroups(client, dishId, req.body?.groups ?? req.body?.optionGroups);
      await client.query(`UPDATE dishes SET updated_at = now() WHERE id = $1`, [dishId]);
      await logOperation(client, user.id, "UPDATE_DISH_OPTIONS", "DISH", dishId, { groups: req.body?.groups ?? req.body?.optionGroups ?? [] });
    });
    broadcastUpdate({ type: "menu.updated" });
    res.json({ ok: true, groups: await dishOptionGroups(pool, dishId) });
  } catch (error) {
    publicError(res, error);
  }
});

app.patch("/api/tables/:tableId", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const tableId = routeParam(req, "tableId");
    const fields: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (req.body?.number !== undefined) add("number", requirePositiveInteger(req.body.number, "桌号必须是大于零的整数", 10_000));
    if (req.body?.name !== undefined) {
      const tableName = text(req.body.name);
      if (!tableName) fail("桌台名称不能为空");
      add("name", tableName);
    }
    if (req.body?.seats !== undefined) add("seats", requirePositiveInteger(req.body.seats, "座位数必须是大于零的整数", 500));
    if (req.body?.status !== undefined) {
      const status = text(req.body.status);
      if (!["AVAILABLE", "DISABLED"].includes(status)) fail("桌台状态不正确");
      add("status", status);
    }
    if (!fields.length) fail("没有要修改的内容");
    await withTransaction(async (client) => {
      const table = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM restaurant_tables WHERE id = $1 FOR UPDATE`,
        [tableId]
      );
      if (!table.rows[0]) fail("桌台不存在", 404);
      const openOrder = await client.query(`SELECT 1 FROM orders WHERE table_id = $1 AND status = 'OPEN' LIMIT 1`, [tableId]);
      if (openOrder.rows[0] || table.rows[0].status === "OCCUPIED") fail("使用中的桌台不能修改，请先处理当前账单");
      values.push(tableId);
      const result = await client.query(
        `UPDATE restaurant_tables SET ${fields.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING id`,
        values
      );
      if (!result.rows[0]) fail("桌台不存在", 404);
      await logOperation(client, user.id, "UPDATE_TABLE", "TABLE", tableId, req.body);
    });
    broadcastUpdate({ type: "table.updated", tableId });
    res.json({ ok: true });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/customers/search", requireAuth, async (req, res) => {
  try {
    const q = text(req.query.q);
    if (!q) {
      res.json({ customers: [] });
      return;
    }
    const result = await pool.query(
      `SELECT c.id, c.phone, c.name, c.points_balance, c.created_at,
              COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'SETTLED') AS order_count,
              MAX(o.settled_at) FILTER (WHERE o.status = 'SETTLED') AS last_visit
       FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
       WHERE c.phone ILIKE $1 OR COALESCE(c.name, '') ILIKE $1
       GROUP BY c.id ORDER BY c.updated_at DESC LIMIT 30`,
      [`%${q}%`]
    );
    res.json({ customers: result.rows.map((row) => ({ ...row, phone: maskPhone(row.phone) })) });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/customers/:customerId", requireAuth, async (req, res) => {
  try {
    const customerId = routeParam(req, "customerId");
    const customer = await pool.query(`SELECT id, phone, name, points_balance, created_at FROM customers WHERE id = $1`, [customerId]);
    if (!customer.rows[0]) fail("顾客不存在", 404);
    const ledger = await pool.query(
      `SELECT id, delta, kind, balance_after, note, created_at FROM points_ledger
       WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [customerId]
    );
    const visits = await pool.query(
      `SELECT o.id, o.business_date, o.people_count, s.received_fen, s.payment_method, s.settled_at
       FROM orders o JOIN settlements s ON s.order_id = o.id AND s.status = 'ACTIVE'
       WHERE o.customer_id = $1 ORDER BY s.settled_at DESC LIMIT 50`,
      [customerId]
    );
    res.json({ customer: { ...customer.rows[0], phone: maskPhone(customer.rows[0].phone), ledger: ledger.rows, visits: visits.rows } });
  } catch (error) {
    publicError(res, error);
  }
});

function validateDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("日期格式不正确");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail("日期格式不正确");
  }
}

function validateDateRange(from: string, to: string): void {
  validateDate(from);
  validateDate(to);
  if (from > to) fail("开始日期不能晚于结束日期");
}

async function statsData(client: DbClient, from: string, to: string) {
  const summary = await client.query(
    `WITH active AS (
       SELECT s.*, o.business_date, o.people_count, o.customer_id, o.table_id,
              o.table_number_snapshot, o.table_name_snapshot
       FROM settlements s JOIN orders o ON o.id = s.order_id
       WHERE s.status = 'ACTIVE' AND o.business_date BETWEEN $1::date AND $2::date
     ), costs AS (
       SELECT a.order_id,
              COALESCE(SUM((oi.quantity - oi.returned_quantity + oi.returned_made_quantity) * oi.cost_fen), 0) AS cost_fen,
              COALESCE(SUM(oi.returned_made_quantity * oi.cost_fen), 0) AS loss_fen
       FROM active a JOIN order_items oi ON oi.order_id = a.order_id GROUP BY a.order_id
     )
     SELECT COALESCE(SUM(a.gross_fen - a.gift_fen - a.return_fen - a.manual_discount_fen - a.points_discount_fen), 0) AS revenue_fen,
            COUNT(*)::int AS order_count,
            COALESCE(SUM(a.people_count), 0)::int AS people_count,
            COALESCE(SUM(a.gross_fen - a.gift_fen - a.return_fen - a.manual_discount_fen - a.points_discount_fen), 0) AS due_fen,
            COALESCE(SUM(a.gift_fen + a.manual_discount_fen + a.points_discount_fen), 0) AS discount_fen,
            COALESCE(SUM(c.cost_fen), 0) AS cost_fen,
            COALESCE(SUM(c.loss_fen), 0) AS loss_fen,
            COUNT(*) FILTER (WHERE a.table_number_snapshot IS NOT NULL)::int AS table_order_count,
            COUNT(DISTINCT a.table_number_snapshot)::int AS used_table_count,
            COUNT(*) FILTER (WHERE a.customer_id IS NULL)::int AS guest_orders
     FROM active a LEFT JOIN costs c ON c.order_id = a.order_id`,
    [from, to]
  );
  const sales = await client.query(
    `SELECT oi.dish_name,
            SUM(GREATEST(0, oi.quantity - oi.returned_quantity - LEAST(oi.gifted_quantity, oi.quantity - oi.returned_quantity)))::int AS sold_quantity,
            SUM(oi.gifted_quantity)::int AS gifted_quantity,
            SUM(oi.returned_quantity)::int AS returned_quantity,
            SUM(GREATEST(0, oi.quantity - oi.returned_quantity - LEAST(oi.gifted_quantity, oi.quantity - oi.returned_quantity)) * oi.price_fen) AS amount_fen
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     JOIN settlements s ON s.order_id = o.id AND s.status = 'ACTIVE'
     WHERE o.business_date BETWEEN $1::date AND $2::date
     GROUP BY oi.dish_name ORDER BY sold_quantity DESC, oi.dish_name`,
    [from, to]
  );
  const customers = await client.query(
    `WITH first_visit AS (
       SELECT customer_id, MIN(business_date) AS first_date
       FROM orders o JOIN settlements s ON s.order_id = o.id AND s.status = 'ACTIVE'
       WHERE customer_id IS NOT NULL GROUP BY customer_id
     ), current_visit AS (
       SELECT DISTINCT o.customer_id, f.first_date
       FROM orders o JOIN settlements s ON s.order_id = o.id AND s.status = 'ACTIVE'
       JOIN first_visit f ON f.customer_id = o.customer_id
       WHERE o.business_date BETWEEN $1::date AND $2::date
     )
     SELECT COUNT(*) FILTER (WHERE first_date BETWEEN $1::date AND $2::date)::int AS new_customers,
            COUNT(*) FILTER (WHERE first_date < $1::date)::int AS returning_customers
     FROM current_visit`,
    [from, to]
  );
  const row = summary.rows[0];
  const revenueFen = Number(row.revenue_fen || 0);
  const peopleCount = Number(row.people_count || 0);
  const costFen = Number(row.cost_fen || 0);
  return {
    range: { from, to },
    summary: {
      revenueFen,
      orderCount: Number(row.order_count || 0),
      peopleCount,
      averageOrderFen: averageFen(revenueFen, Number(row.order_count || 0)),
      tableOrderCount: Number(row.table_order_count || 0),
      averageTableFen: averageFen(revenueFen, Number(row.table_order_count || 0)),
      averagePersonFen: peopleCount ? Math.round(revenueFen / peopleCount) : 0,
      grossProfitFen: revenueFen - costFen,
      grossMarginPercent: revenueFen ? Math.round(((revenueFen - costFen) / revenueFen) * 10000) / 100 : 0,
      discountFen: Number(row.discount_fen || 0),
      lossFen: Number(row.loss_fen || 0),
      usedTableCount: Number(row.used_table_count || 0),
      newCustomers: Number(customers.rows[0]?.new_customers || 0),
      returningCustomers: Number(customers.rows[0]?.returning_customers || 0),
      guestOrders: Number(row.guest_orders || 0),
      guestOrderPercent: ratioPercent(Number(row.guest_orders || 0), Number(row.order_count || 0))
    },
    sales: sales.rows
  };
}

app.get("/api/stats", requireAuth, requireRole("OWNER"), async (req, res) => {
  try {
    const today = businessDate();
    const from = text(req.query.from) || today;
    const to = text(req.query.to) || today;
    validateDateRange(from, to);
    res.json(await withReadOnlySnapshot((client) => statsData(client, from, to)));
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/stats/export.csv", requireAuth, requireRole("OWNER"), async (req, res) => {
  try {
    const today = businessDate();
    const from = text(req.query.from) || today;
    const to = text(req.query.to) || today;
    validateDateRange(from, to);
    const data = await withReadOnlySnapshot((client) => statsData(client, from, to));
    const summary = data.summary;
    const rows: unknown[][] = [
      ["营业报表"],
      ["开始日期", from],
      ["结束日期", to],
      [],
      ["核心指标"],
      ["指标", "数值", "单位"],
      ["营业额", fenAsYuan(summary.revenueFen), "元"],
      ["订单数", summary.orderCount, "单"],
      ["有桌台订单数", summary.tableOrderCount, "单"],
      ["使用桌台数", summary.usedTableCount, "张"],
      ["每桌平均消费", fenAsYuan(summary.averageTableFen), "元/桌台订单"],
      ["每单平均消费", fenAsYuan(summary.averageOrderFen), "元/单"],
      ["用餐人数", summary.peopleCount, "人"],
      ["人均消费", fenAsYuan(summary.averagePersonFen), "元/人"],
      ["新客", summary.newCustomers, "人"],
      ["老客", summary.returningCustomers, "人"],
      ["散客订单", summary.guestOrders, "单"],
      ["散客订单占比", summary.guestOrderPercent, "%"],
      ["毛利润", fenAsYuan(summary.grossProfitFen), "元"],
      ["毛利率", summary.grossMarginPercent, "%"],
      ["优惠金额", fenAsYuan(summary.discountFen), "元"],
      ["退菜损耗", fenAsYuan(summary.lossFen), "元"],
      [],
      ["菜品销量"],
      ["菜品", "销售数量", "赠送数量", "退菜数量", "销售金额（元）"],
      ...data.sales.map((row) => [row.dish_name, row.sold_quantity, row.gifted_quantity, row.returned_quantity, fenAsYuan(Number(row.amount_fen))])
    ];
    const csv = csvDocument(rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="business-stats.csv"; filename*=UTF-8''${encodeURIComponent("营业统计.csv")}`);
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/settings", requireAuth, async (_req, res) => {
  try {
    res.json({ settings: await getSettings(pool) });
  } catch (error) {
    publicError(res, error);
  }
});

app.put("/api/settings", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success || !Object.keys(parsed.data || {}).length) fail("设置内容不正确，请检查后重试");
    await withTransaction(async (client) => {
      if (parsed.data.printer_device_id) {
        const activeDevice = await client.query(
          `SELECT 1 FROM printer_devices WHERE id = $1 AND active = true`,
          [parsed.data.printer_device_id]
        );
        if (!activeDevice.rows[0]) fail("所选打印设备不存在或已停用");
      }
      for (const [key, value] of Object.entries(parsed.data)) {
        await client.query(
          `INSERT INTO store_settings (key, value, updated_by, updated_at)
           VALUES ($1, $2::jsonb, $3, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [key, JSON.stringify(value), user.id]
        );
      }
      await logOperation(client, user.id, "UPDATE_SETTINGS", "SETTING", null, parsed.data);
    });
    broadcastUpdate({ type: "printer.updated" });
    res.json({ settings: await getSettings(pool) });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/employees", requireAuth, requireRole("OWNER"), async (_req, res) => {
  try {
    const result = await pool.query(`SELECT id, username, name, role, active, created_at FROM employees ORDER BY created_at`);
    res.json({ employees: result.rows });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/employees", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const username = text(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const name = text(req.body?.name) || username;
    if (!username || username.length > 120 || password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
      fail("收银员账号必填，密码须为 8 个字符以上且不超过 72 字节");
    }
    const employeeId = await withTransaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO employees (username, name, password_hash, role) VALUES ($1, $2, $3, 'CASHIER') RETURNING id`,
        [username, name, await bcrypt.hash(password, 12)]
      );
      await logOperation(client, user.id, "CREATE_EMPLOYEE", "EMPLOYEE", result.rows[0].id, { username, name });
      return result.rows[0].id;
    });
    res.status(201).json({ employeeId });
  } catch (error) {
    publicError(res, error);
  }
});

app.patch("/api/employees/:employeeId", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const employeeId = routeParam(req, "employeeId");
    if (req.body?.active === undefined && req.body?.password === undefined) fail("没有要修改的内容");
    if (req.body?.active !== undefined && typeof req.body.active !== "boolean") fail("员工状态不正确");
    const password = req.body?.password;
    if (password !== undefined && (typeof password !== "string" || password.length < 8 || Buffer.byteLength(password, "utf8") > 72)) {
      fail("密码须为 8 个字符以上且不超过 72 字节");
    }
    await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('order-dinner-owner-account-state'))`);
      const target = await client.query<{ id: string; role: string; active: boolean }>(
        `SELECT id, role, active FROM employees WHERE id = $1 FOR UPDATE`,
        [employeeId]
      );
      const employee = target.rows[0];
      if (!employee) fail("员工不存在", 404);
      if (employee.role === "OWNER" && req.body?.active === false && employee.active) {
        if (employeeId === user.id) fail("不能停用当前登录的老板账号");
        const owners = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM employees WHERE role = 'OWNER' AND active = true`
        );
        if (Number(owners.rows[0]?.count || 0) <= 1) fail("至少保留一名启用的老板账号");
      }
      const updates: string[] = [];
      const values: unknown[] = [];
      if (req.body?.active !== undefined) {
        values.push(req.body.active);
        updates.push(`active = $${values.length}`);
      }
      if (password !== undefined) {
        values.push(await bcrypt.hash(password, 12));
        updates.push(`password_hash = $${values.length}`);
      }
      updates.push("auth_version = auth_version + 1");
      values.push(employeeId);
      const updated = await client.query(
        `UPDATE employees SET ${updates.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING id`,
        values
      );
      if (!updated.rows[0]) fail("员工不存在", 404);
      await logOperation(client, user.id, "UPDATE_EMPLOYEE", "EMPLOYEE", employeeId, {
        active: req.body?.active,
        passwordChanged: password !== undefined
      });
    });
    res.json({ ok: true });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/print-jobs", requireAuth, async (req, res) => {
  try {
    const requestedStatus = text(req.query.status);
    const status = requestedStatus === "ALL"
      ? "ALL"
      : ["PENDING", "CLAIMED", "SENT", "FAILED", "NEEDS_CHECK"].includes(requestedStatus)
        ? requestedStatus
        : "PENDING";
    const limit = req.query.limit === undefined ? 50 : requirePositiveInteger(req.query.limit, "每页条数格式不正确", 100);
    const offset = req.query.offset === undefined ? 0 : requireNonNegativeInteger(req.query.offset, "查询页码格式不正确");
    const params: unknown[] = [];
    const conditions = [] as string[];
    if (status !== "ALL") {
      params.push(status);
      conditions.push(`pj.status = $${params.length}`);
    }
    const from = text(req.query.from);
    const to = text(req.query.to);
    if (from) {
      validateDate(from);
      params.push(from);
      conditions.push(`pj.created_at >= ($${params.length}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`);
    }
    if (to) {
      validateDate(to);
      if (from && from > to) fail("开始日期不能晚于结束日期");
      params.push(to);
      conditions.push(`pj.created_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')`);
    }
    const tableQuery = text(req.query.table);
    if (tableQuery) {
      params.push(`%${tableQuery}%`);
      const tableParam = params.length;
      conditions.push(`COALESCE(NULLIF(pj.payload->>'tableName', ''), NULLIF(pj.payload->>'tableNumber', '') || '号桌', '无桌台') ILIKE $${tableParam}`);
    }
    params.push(limit + 1, offset);
    const result = await pool.query(
      `SELECT pj.id, pj.order_id, pj.batch_id, pj.kind, pj.copy_no, pj.payload, pj.status, pj.device_id, pj.attempts,
              pj.last_error, pj.manual_requested_at, pj.claimed_at, pj.sent_at, pj.created_at
       FROM print_jobs pj ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY pj.created_at DESC, pj.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const hasMore = result.rows.length > limit;
    const jobs = result.rows.slice(0, limit).map((job) => ({
      ...job,
      payload: preparePrintPayload(job.kind, job.payload)
    }));
    res.json({ jobs, hasMore, nextOffset: offset + jobs.length });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/print-devices/register", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const deviceId = text(req.body?.deviceId).slice(0, 120);
    const name = text(req.body?.name).slice(0, 120) || "安卓打印设备";
    if (!deviceId) fail("请选择打印设备");
    const printerToken = crypto.randomBytes(32).toString("hex");
    await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('order-dinner-printer-selection'))`);
      await client.query(
        `UPDATE printer_devices SET active = false, updated_at = now() WHERE active = true AND id <> $1`,
        [deviceId]
      );
      await client.query(
        `INSERT INTO printer_devices (id, name, token_hash, active, created_by)
         VALUES ($1, $2, $3, true, $4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, token_hash = EXCLUDED.token_hash,
           active = true, last_seen_at = NULL, created_by = EXCLUDED.created_by, updated_at = now()`,
        [deviceId, name, printerTokenHash(printerToken), user.id]
      );
      for (const [key, value] of [["printer_device_id", deviceId], ["printer_device_name", name]] as const) {
        await client.query(
          `INSERT INTO store_settings (key, value, updated_by, updated_at)
           VALUES ($1, $2::jsonb, $3, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [key, JSON.stringify(value), user.id]
        );
      }
      await logOperation(client, user.id, "REGISTER_PRINTER_DEVICE", "PRINTER_DEVICE", null, { deviceId, name });
    });
    broadcastUpdate({ type: "printer.updated" });
    res.json({ deviceId, name, printerToken });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/print-devices", requireAuth, requireRole("OWNER"), async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, active, last_seen_at, created_at, updated_at
       FROM printer_devices ORDER BY active DESC, updated_at DESC, id`
    );
    res.json({ devices: result.rows });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/print-devices/:deviceId/rotate-token", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const deviceId = routeParam(req, "deviceId");
    const printerToken = crypto.randomBytes(32).toString("hex");
    const device = await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('order-dinner-printer-selection'))`);
      const found = await client.query<{ id: string; name: string; active: boolean }>(
        `SELECT id, name, active FROM printer_devices WHERE id = $1 FOR UPDATE`,
        [deviceId]
      );
      if (!found.rows[0]) fail("打印设备不存在", 404);
      await client.query(
        `UPDATE printer_devices SET token_hash = $1, last_seen_at = NULL, updated_at = now() WHERE id = $2`,
        [printerTokenHash(printerToken), deviceId]
      );
      await logOperation(client, user.id, "ROTATE_PRINTER_TOKEN", "PRINTER_DEVICE", null, { deviceId });
      return found.rows[0];
    });
    broadcastUpdate({ type: "printer.updated" });
    res.json({ deviceId, name: device.name, active: device.active, printerToken });
  } catch (error) {
    publicError(res, error);
  }
});

app.patch("/api/print-devices/:deviceId", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    if (typeof req.body?.active !== "boolean") fail("打印设备状态不正确");
    const deviceId = routeParam(req, "deviceId");
    await withTransaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('order-dinner-printer-selection'))`);
      const device = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM printer_devices WHERE id = $1 FOR UPDATE`,
        [deviceId]
      );
      if (!device.rows[0]) fail("打印设备不存在", 404);
      if (req.body.active) {
        await client.query(`UPDATE printer_devices SET active = false, updated_at = now() WHERE active = true AND id <> $1`, [deviceId]);
      }
      await client.query(`UPDATE printer_devices SET active = $1, updated_at = now() WHERE id = $2`, [req.body.active, deviceId]);
      const current = await client.query<{ id: string | null }>(
        `SELECT value #>> '{}' AS id FROM store_settings WHERE key = 'printer_device_id' FOR UPDATE`
      );
      if (req.body.active) {
        for (const [key, value] of [["printer_device_id", deviceId], ["printer_device_name", device.rows[0].name]] as const) {
          await client.query(
            `INSERT INTO store_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [key, JSON.stringify(value), user.id]
          );
        }
      } else if (current.rows[0]?.id === deviceId) {
        for (const [key, value] of [["printer_device_id", ""], ["printer_device_name", "未配置打印设备"]] as const) {
          await client.query(
            `INSERT INTO store_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [key, JSON.stringify(value), user.id]
          );
        }
      }
      await logOperation(client, user.id, req.body.active ? "ENABLE_PRINTER_DEVICE" : "DISABLE_PRINTER_DEVICE", "PRINTER_DEVICE", null, { deviceId });
    });
    broadcastUpdate({ type: "printer.updated" });
    res.json({ ok: true });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/print-jobs/claim", requirePrinterDevice, async (req, res) => {
  try {
    const deviceId = text(req.header("x-printer-device-id"));
    const sessionStartedAt = text(req.body?.sessionStartedAt);
    const sessionDate = new Date(sessionStartedAt);
    if (!sessionStartedAt || Number.isNaN(sessionDate.getTime())) fail("打印连接时间不正确");
    const result = await withTransaction(async (client) => {
      const selected = await client.query<{ device_id: string | null }>(
        `SELECT value #>> '{}' AS device_id FROM store_settings WHERE key = 'printer_device_id'`
      );
      if (!selected.rows[0]?.device_id || selected.rows[0].device_id !== deviceId) {
        fail("此设备不是当前指定的打印主机", 403);
      }
      await expireStalePrintClaims(client);
      const job = await client.query(
        `SELECT id FROM print_jobs
         WHERE status = 'PENDING'
           AND (manual_requested_at IS NOT NULL OR created_at >= $1::timestamptz)
         ORDER BY CASE WHEN manual_requested_at IS NOT NULL THEN 0 ELSE 1 END,
                  COALESCE(manual_requested_at, created_at), created_at
         LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [sessionDate.toISOString()]
      );
      if (!job.rows[0]) return null;
      const updated = await client.query(
        `UPDATE print_jobs SET status = 'CLAIMED', device_id = $1, attempts = attempts + 1,
           claimed_at = now(), manual_requested_at = NULL
         WHERE id = $2 RETURNING id, order_id, batch_id, kind, copy_no, payload, attempts`,
        [deviceId, job.rows[0].id]
      );
      return updated.rows[0];
    });
    const job = result ? {
      ...result,
      payload: preparePrintPayload(result.kind, result.payload)
    } : null;
    res.json({ job });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/print-jobs/:jobId/ack", requirePrinterDevice, async (req, res) => {
  try {
    const status = text(req.body?.status);
    if (!["SENT", "FAILED", "NEEDS_CHECK"].includes(status)) fail("打印回执状态不正确");
    const deviceId = text(req.header("x-printer-device-id"));
    const jobId = routeParam(req, "jobId");
    const result = await pool.query(
      `UPDATE print_jobs SET status = $1, last_error = $2,
         sent_at = CASE WHEN $1 = 'SENT' THEN now() ELSE sent_at END
       WHERE id = $3 AND device_id = $4 AND status = 'CLAIMED' RETURNING id, status`,
      [status, text(req.body?.error) || null, jobId, deviceId]
    );
    if (result.rows[0]) {
      res.json({ job: result.rows[0] });
      return;
    }
    const finalized = await pool.query(
      `SELECT id, status FROM print_jobs
       WHERE id = $1 AND device_id = $2 AND status IN ('SENT', 'FAILED', 'NEEDS_CHECK')`,
      [jobId, deviceId]
    );
    if (!finalized.rows[0]) fail("打印任务不存在", 404);
    res.json({ job: finalized.rows[0] });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/print-jobs/:jobId/retry", requireAuth, async (req, res) => {
  try {
    const user = currentUser(req);
    const jobId = routeParam(req, "jobId");
    await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE print_jobs SET status = 'PENDING', device_id = NULL, last_error = NULL,
           claimed_at = NULL, manual_requested_at = now()
         WHERE id = $1 AND status IN ('FAILED', 'NEEDS_CHECK') RETURNING id`,
        [jobId]
      );
      if (!result.rows[0]) fail("当前打印任务不可重试");
      await logOperation(client, user.id, "RETRY_PRINT_JOB", "PRINT_JOB", jobId);
    });
    res.json({ ok: true });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/print-jobs/:jobId/dispatch", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const jobId = routeParam(req, "jobId");
    await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE print_jobs SET status = 'PENDING', device_id = NULL, last_error = NULL,
           claimed_at = NULL, manual_requested_at = now()
         WHERE id = $1 AND status IN ('PENDING', 'FAILED', 'NEEDS_CHECK') RETURNING id`,
        [jobId]
      );
      if (!result.rows[0]) fail("当前打印任务不能手动打印");
      await logOperation(client, user.id, "DISPATCH_PRINT_JOB", "PRINT_JOB", jobId);
    });
    res.json({ ok: true });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/print-jobs/:jobId/reprint", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const jobId = routeParam(req, "jobId");
    const copies = req.body?.copies === undefined
      ? 1
      : requirePositiveInteger(req.body.copies, "补打份数必须在1到20份之间", 20);
    const result = await withTransaction(async (client) => {
      const originalResult = await client.query<{
        id: string;
        order_id: string | null;
        batch_id: string | null;
        kind: "KITCHEN" | "RETURN" | "RECEIPT";
        copy_no: number;
        payload: Record<string, unknown>;
        status: string;
      }>(
        `SELECT id, order_id, batch_id, kind, copy_no, payload, status
         FROM print_jobs WHERE id = $1 FOR UPDATE`,
        [jobId]
      );
      const original = originalResult.rows[0];
      if (!original) fail("打印任务不存在", 404);
      if (!["SENT", "FAILED", "NEEDS_CHECK"].includes(original.status)) fail("当前打印任务还不能补打");
      const basePayload = {
        ...original.payload,
        title: normalizeReprintTitle(original.payload?.title),
        reprintOf: original.id,
        createdAt: new Date().toISOString()
      };
      const jobIds: string[] = [];
      for (let copyNo = 1; copyNo <= copies; copyNo += 1) {
        const payload = preparePrintPayload(original.kind, { ...basePayload, copyNo }, true);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO print_jobs (order_id, batch_id, kind, copy_no, payload, manual_requested_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, now()) RETURNING id`,
          [original.order_id, original.batch_id, original.kind, copyNo, JSON.stringify(payload)]
        );
        jobIds.push(inserted.rows[0].id);
      }
      await logOperation(client, user.id, "REPRINT_JOB", "PRINT_JOB", jobIds[0], { originalJobId: original.id, copies });
      return { jobId: jobIds[0], jobIds, copies };
    });
    res.status(201).json(result);
  } catch (error) {
    publicError(res, error);
  }
});

app.use(express.static(webDist));
app.get("*", (req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api/") || req.path === "/healthz") {
    next();
    return;
  }
  res.sendFile(path.join(webDist, "index.html"), (error) => {
    if (error) next(error);
  });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  publicError(res, error);
});

async function start(): Promise<void> {
  await migrateAndSeed();
  const idempotencyCleanup = setInterval(() => {
    void pruneExpiredIdempotencyKeys().catch((error) => console.error("幂等记录清理失败", error));
  }, 24 * 60 * 60 * 1000);
  idempotencyCleanup.unref();
  const printClaimCleanup = setInterval(() => {
    void expireStalePrintClaims().catch((error) => console.error("打印任务超时核对失败", error));
  }, process.env.NODE_ENV === "test" ? 250 : 60 * 1000);
  printClaimCleanup.unref();
  void expireStalePrintClaims().catch((error) => console.error("打印任务超时核对失败", error));
  app.listen(port, () => {
    console.log(`餐厅点单系统已启动：http://0.0.0.0:${port}`);
  });
}

start().catch((error) => {
  console.error("系统启动失败", error);
  process.exitCode = 1;
});

export { app };
