import express, { type Request, type Response } from "express";
import crypto from "node:crypto";
import { pool, withReadOnlySnapshot, withTransaction, type DbClient } from "./db.js";
import { requireAuth } from "./auth.js";
import type { AuthenticatedRequest } from "./types.js";
import { normalizeCustomerPhone, requirePositiveInteger } from "./domain.js";
import { publicError } from "./utils.js";

type BanquetState = "RESERVED" | "CANCELLED" | "CONVERTED" | "EXPIRED";
// A converted reservation keeps its slot only while the linked order is still open.
// Once the early-opened banquet is checked out (or otherwise ended), the table time is free again.
const slotBlockingReservationCondition = `(status = 'RESERVED' OR (status = 'CONVERTED' AND ends_at > now() AND EXISTS (SELECT 1 FROM orders linked_order WHERE linked_order.id = banquet_reservations.order_id AND linked_order.status = 'OPEN'))) `;
type Reservation = {
  id: string;
  hall_id: string | null;
  hall_name: string | null;
  table_id: string | null;
  table_name: string;
  table_number: number | null;
  table_seats: number | null;
  starts_at: string;
  ends_at: string;
  customer_name: string;
  customer_phone: string | null;
  people_count: number;
  points_earning_enabled: boolean;
  status: BanquetState;
  preorder: Array<Record<string, unknown>>;
  order_id: string | null;
  order_status?: string | null;
  note: string;
  created_by: string;
  created_at: string;
  deposit_balance_fen: number;
};

function reject(message: string, status = 400): never {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  throw error;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function userOf(req: AuthenticatedRequest) {
  if (!req.user) reject("请先登录", 401);
  return req.user;
}

function routeId(req: Request, name: string): string {
  return text(req.params[name]);
}

function positiveInt(value: unknown, label: string, max = 100_000): number {
  return requirePositiveInteger(value, `${label}必须是大于零的整数`, max);
}

function nonNegativeInt(value: unknown, label: string, max = 1_000_000_000): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) reject(`${label}格式不正确`);
  return parsed;
}

function assertPreorderFitsPostgresInteger(items: Array<Record<string, unknown>>): void {
  let totalFen = 0;
  for (const item of items) {
    const quantity = Number(item.quantity);
    const priceFen = Number(item.priceFen);
    const lineFen = quantity * priceFen;
    if (!Number.isSafeInteger(lineFen) || lineFen < 0 || lineFen > 2_147_483_647) {
      reject("单项宴席预点金额超过系统支持范围，请调整数量或菜价");
    }
    totalFen += lineFen;
    if (!Number.isSafeInteger(totalFen) || totalFen > 2_147_483_647) {
      reject("宴席预点总额超过系统支持范围，请拆分预点菜");
    }
  }
}

function validDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim())) reject(`${label}必须包含时区信息`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) reject(`${label}不正确`);
  return parsed.toISOString();
}

function payloadWithoutKey(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const { idempotencyKey: _key, ...payload } = body as Record<string, unknown>;
  return payload;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function payloadHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function requestKey(body: unknown): string {
  const key = text((body as { idempotencyKey?: unknown } | null)?.idempotencyKey);
  if (!key || key.length > 200) reject("请求编号缺失，请刷新后重试");
  return key;
}

async function idempotent<T>(
  client: DbClient,
  scope: string,
  key: string,
  employeeId: string,
  payload: unknown,
  work: () => Promise<T>
): Promise<T> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`banquet:${scope}:${key}`]);
  const previous = await client.query<{ response: T; employee_id: string | null; payload_hash: string | null }>(
    `SELECT response, employee_id, payload_hash FROM idempotency_keys WHERE scope = $1 AND request_key = $2`,
    [`banquet:${scope}`, key]
  );
  const row = previous.rows[0];
  if (row) {
    if (row.employee_id && row.employee_id !== employeeId) reject("请求编号已被其他账号使用", 409);
    if (row.payload_hash && row.payload_hash !== payloadHash(payload)) reject("上次请求尚未确认且内容已变化，请刷新后核对宴席状态", 409);
    return row.response;
  }
  const result = await work();
  await client.query(
    `INSERT INTO idempotency_keys (scope, request_key, employee_id, response, payload_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [`banquet:${scope}`, key, employeeId, JSON.stringify(result), payloadHash(payload)]
  );
  return result;
}

async function logOperation(client: DbClient, employeeId: string, action: string, entityId: string, detail: unknown = {}): Promise<void> {
  await client.query(
    `INSERT INTO operation_logs (employee_id, action, entity_type, entity_id, detail)
     VALUES ($1, $2, 'BANQUET', $3, $4::jsonb)`,
    [employeeId, action, entityId, JSON.stringify(detail)]
  );
}

async function depositBalance(client: DbClient, reservationId: string, lock = false): Promise<number> {
  if (lock) await client.query(`SELECT id FROM banquet_reservations WHERE id = $1 FOR UPDATE`, [reservationId]);
  const result = await client.query<{ balance: string | number }>(
    `SELECT COALESCE(SUM(CASE kind
       WHEN 'RECEIVE' THEN amount_fen
       WHEN 'RESTORE' THEN amount_fen
       WHEN 'REFUND' THEN -amount_fen
       WHEN 'APPLY' THEN -amount_fen
       ELSE 0 END), 0)::bigint AS balance
     FROM banquet_deposit_ledger WHERE reservation_id = $1`,
    [reservationId]
  );
  return Math.max(0, Number(result.rows[0]?.balance || 0));
}

async function reservationDetails(client: DbClient, reservationId: string): Promise<Record<string, unknown>> {
  const result = await client.query<Reservation>(
    `SELECT r.*, h.name AS hall_name, linked_order.status AS order_status,
            COALESCE(t.name, h.name, '未指定桌台') AS table_name,
            t.number AS table_number, t.seats AS table_seats,
            COALESCE(d.balance, 0)::bigint AS deposit_balance_fen
     FROM banquet_reservations r
     LEFT JOIN banquet_halls h ON h.id = r.hall_id
     LEFT JOIN restaurant_tables t ON t.id = r.table_id
     LEFT JOIN orders linked_order ON linked_order.id = r.order_id
     LEFT JOIN LATERAL (
       SELECT SUM(CASE kind WHEN 'RECEIVE' THEN amount_fen WHEN 'RESTORE' THEN amount_fen
                            WHEN 'REFUND' THEN -amount_fen WHEN 'APPLY' THEN -amount_fen ELSE 0 END) AS balance
       FROM banquet_deposit_ledger WHERE reservation_id = r.id
     ) d ON true
     WHERE r.id = $1`,
    [reservationId]
  );
  const row = result.rows[0];
  if (!row) reject("宴席预定不存在", 404);
  const ledger = await client.query(
    `SELECT id, kind, amount_fen, payment_method, settlement_id, note, created_at
     FROM banquet_deposit_ledger WHERE reservation_id = $1 ORDER BY created_at DESC, id DESC`,
    [reservationId]
  );
  return { ...row, deposit_balance_fen: Number(row.deposit_balance_fen || 0), deposit_ledger: ledger.rows };
}

async function findOrCreateCustomer(client: DbClient, phone: string, name: string | null): Promise<string> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`customer-phone:${phone}`]);
  const digits = `regexp_replace(phone, '[^0-9]', '', 'g')`;
  const matches = await client.query<{ id: string }>(
    `SELECT id FROM customers
     WHERE CASE
       WHEN ${digits} LIKE '0086%' THEN substring(${digits} FROM 5)
       WHEN length(${digits}) = 13 AND ${digits} LIKE '86%' THEN substring(${digits} FROM 3)
       ELSE ${digits}
     END = $1 FOR UPDATE`,
    [phone]
  );
  if (matches.rows.length > 1) reject("该手机号存在多条旧顾客档案，请先核对后再开宴席", 409);
  if (matches.rows[0]) {
    const updated = await client.query<{ id: string }>(
      `UPDATE customers SET phone = $1, name = COALESCE($2, name), updated_at = now() WHERE id = $3 RETURNING id`,
      [phone, name, matches.rows[0].id]
    );
    return updated.rows[0].id;
  }
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO customers (phone, name) VALUES ($1, $2) RETURNING id`, [phone, name]
  );
  return inserted.rows[0].id;
}

type OptionGroup = { id: string; name: string; required: boolean; allow_multiple: boolean; options: Array<{ id: string; label: string }> };

async function snapshotOptions(client: DbClient, dishId: string, rawSelections: unknown, customNote: unknown) {
  const groupsResult = await client.query<OptionGroup>(
    `SELECT g.id, g.name, g.required, g.allow_multiple,
            COALESCE((SELECT json_agg(json_build_object('id', o.id, 'label', o.label) ORDER BY o.sort_order, o.id)
                      FROM dish_options o WHERE o.group_id = g.id AND o.active = true), '[]'::json) AS options
     FROM dish_option_groups g WHERE g.dish_id = $1 AND g.active = true ORDER BY g.sort_order, g.name, g.id`,
    [dishId]
  );
  const requested = Array.isArray(rawSelections) ? rawSelections : [];
  const snapshot: Array<Record<string, unknown>> = [];
  const noteParts: string[] = [];
  for (const group of groupsResult.rows) {
    const row = requested.find((value) => text((value as { groupId?: unknown })?.groupId) === group.id) as { optionIds?: unknown } | undefined;
    const optionIds = Array.from(new Set(Array.isArray(row?.optionIds) ? row.optionIds.map((id) => text(id)).filter(Boolean) : []));
    if (group.required && !optionIds.length) reject(`菜品备注选项已更新，请重新选择${group.name}`, 409);
    if (!group.allow_multiple && optionIds.length > 1) reject(`菜品备注选项已更新，请重新选择${group.name}`, 409);
    const selected = optionIds.map((id) => group.options.find((option) => option.id === id)).filter(Boolean) as Array<{ id: string; label: string }>;
    if (selected.length !== optionIds.length) reject(`菜品备注选项已更新，请重新选择${group.name}`, 409);
    if (selected.length) {
      noteParts.push(`${group.name}：${selected.map((option) => option.label).join("、")}`);
      snapshot.push({ groupId: group.id, groupName: group.name, optionIds, labels: selected.map((option) => option.label) });
    }
  }
  const note = text(customNote).slice(0, 300);
  if (note) noteParts.push(snapshot.length ? `备注：${note}` : note);
  return { note: noteParts.join("，").slice(0, 500), snapshot };
}

function assertExpectedDishSnapshot(dish: { name: string; unit: string; price_fen: number; cost_fen: number }, raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const expected = raw as Record<string, unknown>;
  if (expected.expectedDishName !== undefined && expected.expectedDishName !== dish.name) reject("菜单已更新，请重新确认待提交菜品", 409);
  if (expected.expectedUnit !== undefined && expected.expectedUnit !== dish.unit) reject("菜单已更新，请重新确认待提交菜品", 409);
  if (expected.expectedPriceFen !== undefined
    && (!Number.isSafeInteger(expected.expectedPriceFen) || expected.expectedPriceFen !== dish.price_fen)) {
    reject("菜单已更新，请重新确认待提交菜品", 409);
  }
  if (expected.expectedCostFen !== undefined
    && (!Number.isSafeInteger(expected.expectedCostFen) || Number(expected.expectedCostFen) !== Number(dish.cost_fen))) {
    reject("菜单已更新，请重新确认待提交菜品", 409);
  }
}


/** Create the banquet tables after the base POS schema has been migrated. Safe to run on every start. */
export async function runBanquetMigrations(db: DbClient = pool): Promise<void> {
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS points_earning_enabled boolean NOT NULL DEFAULT true`);
  await db.query(`ALTER TABLE settlements ADD COLUMN IF NOT EXISTS deposit_applied_fen integer NOT NULL DEFAULT 0 CHECK (deposit_applied_fen >= 0)`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS banquet_halls (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      seats integer NOT NULL DEFAULT 1 CHECK (seats > 0),
      active boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS banquet_reservations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      hall_id uuid NOT NULL REFERENCES banquet_halls(id),
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      customer_name text NOT NULL DEFAULT '',
      customer_phone text,
      people_count integer NOT NULL CHECK (people_count > 0),
      points_earning_enabled boolean NOT NULL DEFAULT true,
      status text NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'CANCELLED', 'CONVERTED')),
      preorder jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(preorder) = 'array'),
      order_id uuid UNIQUE REFERENCES orders(id),
      note text NOT NULL DEFAULT '',
      created_by uuid REFERENCES employees(id),
      updated_by uuid REFERENCES employees(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (ends_at > starts_at)
    )`);
  // Older releases used banquet_halls. New reservations bind to an existing POS table.
  // Keep the old column nullable so historical reservations can still be read and settled.
  await db.query(`ALTER TABLE banquet_reservations ADD COLUMN IF NOT EXISTS table_id uuid REFERENCES restaurant_tables(id)`);
  await db.query(`ALTER TABLE banquet_reservations ADD COLUMN IF NOT EXISTS preorder_printed_at timestamptz`);
  await db.query(`ALTER TABLE banquet_reservations ALTER COLUMN hall_id DROP NOT NULL`);
  await db.query(`DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'banquet_reservations'::regclass
          AND conname = 'banquet_reservations_status_check'
          AND pg_get_constraintdef(oid) LIKE '%EXPIRED%'
      ) THEN
        ALTER TABLE banquet_reservations DROP CONSTRAINT IF EXISTS banquet_reservations_status_check;
        ALTER TABLE banquet_reservations
          ADD CONSTRAINT banquet_reservations_status_check
          CHECK (status IN ('RESERVED', 'CANCELLED', 'CONVERTED', 'EXPIRED'));
      END IF;
    END;
  $migration$`);
  await db.query(`CREATE INDEX IF NOT EXISTS banquet_reservations_hall_time_idx ON banquet_reservations (hall_id, starts_at, ends_at) WHERE status = 'RESERVED'`);
  await db.query(`CREATE INDEX IF NOT EXISTS banquet_reservations_table_time_idx ON banquet_reservations (table_id, starts_at, ends_at) WHERE status = 'RESERVED'`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS banquet_deposit_ledger (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      reservation_id uuid NOT NULL REFERENCES banquet_reservations(id),
      settlement_id uuid REFERENCES settlements(id),
      kind text NOT NULL CHECK (kind IN ('RECEIVE', 'REFUND', 'APPLY', 'RESTORE')),
      amount_fen integer NOT NULL CHECK (amount_fen > 0),
      payment_method text NOT NULL DEFAULT '现金',
      request_key text,
      reverses_ledger_id uuid REFERENCES banquet_deposit_ledger(id),
      operator_id uuid REFERENCES employees(id),
      note text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((kind IN ('APPLY', 'RESTORE') AND settlement_id IS NOT NULL) OR kind IN ('RECEIVE', 'REFUND'))
    )`);
  await db.query(`ALTER TABLE banquet_deposit_ledger ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT '现金'`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS banquet_deposit_apply_settlement_idx ON banquet_deposit_ledger (settlement_id) WHERE kind = 'APPLY'`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS banquet_deposit_restore_source_idx ON banquet_deposit_ledger (reverses_ledger_id) WHERE kind = 'RESTORE'`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS banquet_deposit_request_key_idx ON banquet_deposit_ledger (reservation_id, request_key) WHERE request_key IS NOT NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS banquet_deposit_reservation_idx ON banquet_deposit_ledger (reservation_id, created_at DESC)`);
  await db.query(`
    UPDATE banquet_reservations reservation
    SET preorder_printed_at = COALESCE(reservation.updated_at, now())
    WHERE reservation.status = 'CONVERTED'
      AND jsonb_array_length(COALESCE(reservation.preorder, '[]'::jsonb)) > 0
      AND reservation.preorder_printed_at IS NULL
      AND EXISTS (SELECT 1 FROM print_jobs job WHERE job.order_id = reservation.order_id AND job.kind = 'KITCHEN')
  `);
}

export const banquetRouter = express.Router();
banquetRouter.use(requireAuth);

banquetRouter.get("/halls", async (_req, res) => {
  try {
    const result = await pool.query(`SELECT id, name, seats, active, sort_order FROM banquet_halls ORDER BY sort_order, name, id`);
    res.json({ halls: result.rows });
  } catch (error) { publicError(res, error); }
});

banquetRouter.post("/halls", async (req: AuthenticatedRequest, res) => {
  try {
    const user = userOf(req);
    if (user.role !== "OWNER") reject("只有老板可以管理宴会厅", 403);
    const name = text(req.body?.name).slice(0, 100);
    if (!name) reject("请填写厅名");
    const seats = req.body?.seats === undefined ? 1 : positiveInt(req.body.seats, "座位数", 10_000);
    const hallId = await withTransaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO banquet_halls (name, seats, sort_order) VALUES ($1, $2, COALESCE((SELECT max(sort_order) + 1 FROM banquet_halls), 0)) RETURNING id`,
        [name, seats]
      );
      await logOperation(client, user.id, "CREATE_BANQUET_HALL", result.rows[0].id, { name, seats });
      return result.rows[0].id;
    });
    res.status(201).json({ hallId });
  } catch (error) { publicError(res, error); }
});

banquetRouter.patch("/halls/:hallId", async (req: AuthenticatedRequest, res) => {
  try {
    const user = userOf(req);
    if (user.role !== "OWNER") reject("只有老板可以管理宴会厅", 403);
    const hallId = routeId(req, "hallId");
    const updates: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown) => { values.push(value); updates.push(`${sql} = $${values.length}`); };
    if (req.body?.name !== undefined) {
      const name = text(req.body.name).slice(0, 100);
      if (!name) reject("请填写厅名");
      add("name", name);
    }
    if (req.body?.seats !== undefined) add("seats", positiveInt(req.body.seats, "座位数", 10_000));
    if (req.body?.active !== undefined) {
      if (typeof req.body.active !== "boolean") reject("启用状态不正确");
      add("active", req.body.active);
    }
    if (!updates.length) reject("没有需要保存的内容");
    await withTransaction(async (client) => {
      values.push(hallId);
      const result = await client.query(`UPDATE banquet_halls SET ${updates.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING id` , values);
      if (!result.rows[0]) reject("宴会厅不存在", 404);
      await logOperation(client, user.id, "UPDATE_BANQUET_HALL", hallId, req.body);
    });
    res.json({ ok: true });
  } catch (error) { publicError(res, error); }
});

banquetRouter.get("/reservations", async (req, res) => {
  try {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (text(req.query.from)) { values.push(validDate(req.query.from, "开始时间")); conditions.push(`r.ends_at > $${values.length}::timestamptz`); }
    if (text(req.query.to)) { values.push(validDate(req.query.to, "结束时间")); conditions.push(`r.starts_at < $${values.length}::timestamptz`); }
    if (["RESERVED", "CANCELLED", "CONVERTED", "EXPIRED"].includes(text(req.query.status))) { values.push(text(req.query.status)); conditions.push(`r.status = $${values.length}`); }
    const result = await pool.query(
      `SELECT r.id, r.hall_id, h.name AS hall_name, r.table_id,
              COALESCE(t.name, h.name, '未指定桌台') AS table_name,
              t.number AS table_number, t.seats AS table_seats,
              r.starts_at, r.ends_at, r.customer_name, r.customer_phone,
              r.people_count, r.points_earning_enabled, r.status, r.preorder, r.order_id, r.note,
              COALESCE(d.balance, 0)::bigint AS deposit_balance_fen
       FROM banquet_reservations r
       LEFT JOIN banquet_halls h ON h.id = r.hall_id
       LEFT JOIN restaurant_tables t ON t.id = r.table_id
       LEFT JOIN LATERAL (
         SELECT SUM(CASE kind WHEN 'RECEIVE' THEN amount_fen WHEN 'RESTORE' THEN amount_fen
                              WHEN 'REFUND' THEN -amount_fen WHEN 'APPLY' THEN -amount_fen ELSE 0 END) AS balance
         FROM banquet_deposit_ledger WHERE reservation_id = r.id
       ) d ON true
       ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY r.starts_at DESC, COALESCE(t.number, 0), COALESCE(t.name, h.name) LIMIT 500`, values
    );
    res.json({ reservations: result.rows.map((row) => ({ ...row, deposit_balance_fen: Number(row.deposit_balance_fen || 0) })) });
  } catch (error) { publicError(res, error); }
});

banquetRouter.post("/reservations", async (req: AuthenticatedRequest, res) => {
  try {
    const user = userOf(req);
    const key = requestKey(req.body);
    const payload = payloadWithoutKey(req.body);
    const tableId = text(payload.tableId);
    const hallId = text(payload.hallId);
    if (!tableId && !hallId) reject("请选择已有桌台");
    const startsAt = validDate(payload.startsAt, "开始时间");
    const endsAt = validDate(payload.endsAt, "结束时间");
    if (Date.parse(endsAt) <= Date.parse(startsAt)) reject("结束时间必须晚于开始时间");
    const people = positiveInt(payload.peopleCount, "用餐人数", 100_000);
    const customerName = text(payload.customerName).slice(0, 120);
    const customerPhone = normalizeCustomerPhone(payload.customerPhone);
    const pointsEarningEnabled = payload.pointsEarningEnabled === undefined ? true : payload.pointsEarningEnabled;
    if (typeof pointsEarningEnabled !== "boolean") reject("积分累计选择不正确");
    const note = text(payload.note).slice(0, 500);
    const result = await withTransaction(async (client) => idempotent(client, "reservation:create", key, user.id, payload, async () => {
      if (Date.parse(startsAt) <= Date.now()) reject("宴席开始时间必须晚于当前时间");
      let table: { id: string; number: number; name: string; status: string } | undefined;
      if (tableId) {
        const tableResult = await client.query<{ id: string; number: number; name: string; status: string }>(
          `SELECT id, number, name, status FROM restaurant_tables WHERE id = $1 FOR UPDATE`, [tableId]
        );
        table = tableResult.rows[0];
        if (!table) reject("桌台不存在", 404);
        if (table.status === "DISABLED") reject("该桌台已停用", 409);
        const overlap = await client.query(
          `SELECT id FROM banquet_reservations
           WHERE table_id = $1 AND ${slotBlockingReservationCondition}
             AND starts_at < $3::timestamptz AND ends_at > $2::timestamptz
           LIMIT 1`, [tableId, startsAt, endsAt]
        );
        if (overlap.rows[0]) reject("该桌台在此时间段已有宴席预定", 409);
      } else {
        // Accept the old hall payload for one release so older installed clients can finish a booking.
        const hallResult = await client.query<{ id: string; name: string; active: boolean }>(
          `SELECT id, name, active FROM banquet_halls WHERE id = $1 FOR UPDATE`, [hallId]
        );
        const hall = hallResult.rows[0];
        if (!hall) reject("宴会厅不存在", 404);
        if (!hall.active) reject("宴会厅已停用", 409);
        const overlap = await client.query(
          `SELECT id FROM banquet_reservations
           WHERE hall_id = $1 AND ${slotBlockingReservationCondition}
             AND starts_at < $3::timestamptz AND ends_at > $2::timestamptz
           LIMIT 1`, [hallId, startsAt, endsAt]
        );
        if (overlap.rows[0]) reject("该厅在此时间段已有预定", 409);
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO banquet_reservations
         (table_id, hall_id, starts_at, ends_at, customer_name, customer_phone, people_count, points_earning_enabled, note, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
        [tableId || null, tableId ? null : hallId, startsAt, endsAt, customerName, customerPhone, people, pointsEarningEnabled, note, user.id]
      );
      await logOperation(client, user.id, "CREATE_BANQUET_RESERVATION", inserted.rows[0].id, { tableId: tableId || null, hallId: hallId || null, startsAt, endsAt, peopleCount: people });
      return { reservation: await reservationDetails(client, inserted.rows[0].id) };
    }));
    res.status(201).json(result);
  } catch (error) { publicError(res, error); }
});

banquetRouter.get("/reservations/:reservationId", async (req, res) => {
  try {
    const result = await withReadOnlySnapshot((client) => reservationDetails(client, routeId(req, "reservationId")));
    res.json({ reservation: result });
  } catch (error) { publicError(res, error); }
});

banquetRouter.patch("/reservations/:reservationId", async (req: AuthenticatedRequest, res) => {
  try {
    const user = userOf(req);
    const reservationId = routeId(req, "reservationId");
    const startsAt = req.body?.startsAt === undefined ? undefined : validDate(req.body.startsAt, "开始时间");
    const endsAt = req.body?.endsAt === undefined ? undefined : validDate(req.body.endsAt, "结束时间");
    if (startsAt && Date.parse(startsAt) <= Date.now()) reject("改期后的开始时间必须晚于当前时间");
    const hasNote = req.body?.note !== undefined;
    if (hasNote && (typeof req.body.note !== "string" || req.body.note.length > 500)) reject("备注不能超过500字");
    const note = hasNote ? text(req.body.note) : undefined;
    if ((startsAt === undefined) !== (endsAt === undefined)) reject("改期时请同时填写开始和结束时间");
    if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) reject("结束时间必须晚于开始时间");
    const cancel = req.body?.status === "CANCELLED";
    if (req.body?.status !== undefined && !cancel) reject("预定状态不正确");
    if (!cancel && !startsAt && !hasNote) reject("请填写改期时间、宴席备注或取消预定");
    const response = await withTransaction(async (client) => {
      const current = await client.query<{ id: string; hall_id: string | null; table_id: string | null; status: BanquetState }>(
        `SELECT id, hall_id, table_id, status FROM banquet_reservations WHERE id = $1 FOR UPDATE`, [reservationId]
      );
      const reservation = current.rows[0];
      if (!reservation) reject("宴席预定不存在", 404);
      if (reservation.status !== "RESERVED") reject("只有待办预定可以改期或取消", 409);
      if (cancel) {
        await client.query(`UPDATE banquet_reservations SET status = 'CANCELLED', updated_by = $1, updated_at = now() WHERE id = $2`, [user.id, reservationId]);
        await logOperation(client, user.id, "CANCEL_BANQUET_RESERVATION", reservationId, { note: text(req.body?.note) });
      } else {
        if (startsAt && reservation.table_id) {
          await client.query(`SELECT id FROM restaurant_tables WHERE id = $1 FOR UPDATE`, [reservation.table_id]);
          const overlap = await client.query(
            `SELECT id FROM banquet_reservations
             WHERE table_id = $1 AND id <> $2 AND ${slotBlockingReservationCondition}
               AND starts_at < $4::timestamptz AND ends_at > $3::timestamptz
             LIMIT 1`, [reservation.table_id, reservationId, startsAt, endsAt]
          );
          if (overlap.rows[0]) reject("该桌台在此时间段已有宴席预定", 409);
        } else if (startsAt && reservation.hall_id) {
          await client.query(`SELECT id FROM banquet_halls WHERE id = $1 FOR UPDATE`, [reservation.hall_id]);
          const overlap = await client.query(
            `SELECT id FROM banquet_reservations
             WHERE hall_id = $1 AND id <> $2 AND ${slotBlockingReservationCondition}
               AND starts_at < $4::timestamptz AND ends_at > $3::timestamptz
             LIMIT 1`, [reservation.hall_id, reservationId, startsAt, endsAt]
          );
          if (overlap.rows[0]) reject("该厅在此时间段已有预定", 409);
        } else if (startsAt) {
          reject("该宴席没有绑定桌台，无法改期", 409);
        }
        if (startsAt) {
          await client.query(
            `UPDATE banquet_reservations SET starts_at = $1, ends_at = $2, note = COALESCE($3, note), updated_by = $4, updated_at = now() WHERE id = $5`,
            [startsAt, endsAt, note ?? null, user.id, reservationId]
          );
        } else {
          await client.query(
            `UPDATE banquet_reservations SET note = $1, updated_by = $2, updated_at = now() WHERE id = $3`,
            [note, user.id, reservationId]
          );
        }
        const action = startsAt && hasNote ? "UPDATE_BANQUET_RESERVATION" : startsAt ? "RESCHEDULE_BANQUET_RESERVATION" : "UPDATE_BANQUET_NOTE";
        await logOperation(client, user.id, action, reservationId, { ...(startsAt ? { startsAt, endsAt } : {}), ...(hasNote ? { note } : {}) });
      }
      return { reservation: await reservationDetails(client, reservationId) };
    });
    res.json(response);
  } catch (error) { publicError(res, error); }
});

banquetRouter.put("/reservations/:reservationId/preorder", async (req: AuthenticatedRequest, res) => {
  try {
    const user = userOf(req);
    const reservationId = routeId(req, "reservationId");
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (rawItems.length > 300) reject("预点菜数量过多");
    const reservation = await withTransaction(async (client) => {
      const current = await client.query<{ status: BanquetState }>(`SELECT status FROM banquet_reservations WHERE id = $1 FOR UPDATE`, [reservationId]);
      if (!current.rows[0]) reject("宴席预定不存在", 404);
      if (current.rows[0].status !== "RESERVED") reject("只有待办预定可以修改预点菜", 409);
      const snapshot: Array<Record<string, unknown>> = [];
      for (const raw of rawItems) {
        const dishId = text(raw?.dishId);
        const quantity = positiveInt(raw?.quantity, "菜品数量", 100_000);
        const dishResult = await client.query<{
          id: string; name: string; category_name: string | null; unit: string; price_fen: number; cost_fen: number; points_earning_enabled: boolean | null;
        }>(
          `SELECT d.id, d.name, c.name AS category_name, d.unit, d.price_fen, d.cost_fen, c.points_earning_enabled
           FROM dishes d LEFT JOIN categories c ON c.id = d.category_id WHERE d.id = $1 AND d.on_sale = true
           FOR SHARE OF d`, [dishId]
        );
        const dish = dishResult.rows[0];
        if (!dish) reject("菜品不存在或已停售", 409);
        assertExpectedDishSnapshot(dish, raw);
        const options = await snapshotOptions(client, dish.id, raw?.options, raw?.note);
        snapshot.push({
          dishId: dish.id, name: dish.name, categoryName: dish.category_name || "未分类", unit: dish.unit,
          priceFen: dish.price_fen, costFen: dish.cost_fen, pointsEarningEnabled: dish.points_earning_enabled !== false,
          quantity, note: options.note, optionSnapshot: options.snapshot
        });
        assertPreorderFitsPostgresInteger(snapshot);
      }
      await client.query(`UPDATE banquet_reservations SET preorder = $1::jsonb, preorder_printed_at = NULL, updated_by = $2, updated_at = now() WHERE id = $3`, [JSON.stringify(snapshot), user.id, reservationId]);
      await logOperation(client, user.id, "SAVE_BANQUET_PREORDER", reservationId, { itemCount: snapshot.length });
      return reservationDetails(client, reservationId);
    });
    res.json({ reservation });
  } catch (error) { publicError(res, error); }
});

banquetRouter.post("/reservations/:reservationId/preorder/items", async (req: AuthenticatedRequest, res) => {
  try {
    const user = userOf(req);
    const reservationId = routeId(req, "reservationId");
    const key = requestKey(req.body);
    const payload = payloadWithoutKey(req.body);
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    if (!rawItems.length) reject("请先选择菜品");
    if (rawItems.length > 300) reject("本次预点菜数量过多");
    const result = await withTransaction(async (client) => idempotent(client, `preorder-add:${reservationId}`, key, user.id, payload, async () => {
      const current = await client.query<{ status: BanquetState; preorder: Array<Record<string, unknown>> }>(
        `SELECT status, preorder FROM banquet_reservations WHERE id = $1 FOR UPDATE`, [reservationId]
      );
      if (!current.rows[0]) reject("宴席预定不存在", 404);
      if (current.rows[0].status !== "RESERVED") reject("该宴席已经开台或取消，不能继续预点菜", 409);
      const snapshot = Array.isArray(current.rows[0].preorder) ? [...current.rows[0].preorder] : [];
      for (const raw of rawItems) {
        const dishId = text(raw?.dishId);
        const quantity = positiveInt(raw?.quantity, "菜品数量", 100_000);
        const dishResult = await client.query<{
          id: string; name: string; category_name: string | null; unit: string; price_fen: number; cost_fen: number; points_earning_enabled: boolean | null;
        }>(
          `SELECT d.id, d.name, c.name AS category_name, d.unit, d.price_fen, d.cost_fen, c.points_earning_enabled
           FROM dishes d LEFT JOIN categories c ON c.id = d.category_id WHERE d.id = $1 AND d.on_sale = true
           FOR SHARE OF d`, [dishId]
        );
        const dish = dishResult.rows[0];
        if (!dish) reject("菜品不存在或已停售", 409);
        assertExpectedDishSnapshot(dish, raw);
        const options = await snapshotOptions(client, dish.id, raw?.options, raw?.note);
        snapshot.push({
          dishId: dish.id, name: dish.name, categoryName: dish.category_name || "未分类", unit: dish.unit,
          priceFen: dish.price_fen, costFen: dish.cost_fen, pointsEarningEnabled: dish.points_earning_enabled !== false,
          quantity, note: options.note, optionSnapshot: options.snapshot
        });
        assertPreorderFitsPostgresInteger(snapshot);
      }
      await client.query(
        `UPDATE banquet_reservations SET preorder = $1::jsonb, preorder_printed_at = NULL, updated_by = $2, updated_at = now() WHERE id = $3`,
        [JSON.stringify(snapshot), user.id, reservationId]
      );
      await logOperation(client, user.id, "ADD_BANQUET_PREORDER_ITEMS", reservationId, { itemCount: rawItems.length });
      return { reservation: await reservationDetails(client, reservationId) };
    }));
    res.status(201).json(result);
  } catch (error) { publicError(res, error); }
});

banquetRouter.post("/reservations/:reservationId/deposits/receive", async (req: AuthenticatedRequest, res) => {
  try {
    const user = userOf(req);
    const reservationId = routeId(req, "reservationId");
    const key = requestKey(req.body);
    const payload = payloadWithoutKey(req.body);
    const amount = positiveInt(payload.amountFen, "定金金额", 2_147_483_647);
    const paymentMethod = text(payload.paymentMethod) || "现金";
    if (!["现金", "微信", "支付宝", "银行卡", "其他"].includes(paymentMethod)) reject("收款方式不正确");
    const result = await withTransaction(async (client) => idempotent(client, `deposit-receive:${reservationId}`, key, user.id, payload, async () => {
      const reservation = await client.query<{ status: BanquetState; order_status: string | null; ends_at: string }>(
        `SELECT r.status, r.ends_at, o.status AS order_status
         FROM banquet_reservations r LEFT JOIN orders o ON o.id = r.order_id
         WHERE r.id = $1 FOR UPDATE OF r`, [reservationId]
      );
      if (!reservation.rows[0]) reject("宴席预定不存在", 404);
      if (reservation.rows[0].status === "CANCELLED" || reservation.rows[0].status === "EXPIRED") reject("已取消或过期的宴席不能再收定金", 409);
      if (reservation.rows[0].status === "RESERVED" && Date.parse(reservation.rows[0].ends_at) <= Date.now()) reject("宴席时间已过，不能再收定金", 409);
      if (reservation.rows[0].status === "CONVERTED" && reservation.rows[0].order_status !== "OPEN") reject("关联账单已结束，不能再收定金", 409);
      await client.query(
        `INSERT INTO banquet_deposit_ledger (reservation_id, kind, amount_fen, payment_method, request_key, operator_id, note)
         VALUES ($1, 'RECEIVE', $2, $3, $4, $5, $6)`,
        [reservationId, amount, paymentMethod, key, user.id, text(payload.note).slice(0, 300)]
      );
      await logOperation(client, user.id, "RECEIVE_BANQUET_DEPOSIT", reservationId, { amountFen: amount });
      return { reservation: await reservationDetails(client, reservationId) };
    }));
    res.status(201).json(result);
  } catch (error) { publicError(res, error); }
});

banquetRouter.post("/reservations/:reservationId/deposits/refund", async (req: AuthenticatedRequest, res) => {
  try {
    const user = userOf(req);
    if (user.role !== "OWNER") reject("只有老板可以办理定金退款", 403);
    const reservationId = routeId(req, "reservationId");
    const key = requestKey(req.body);
    const payload = payloadWithoutKey(req.body);
    const amount = positiveInt(payload.amountFen, "退款金额", 1_000_000_000);
    const paymentMethod = text(payload.paymentMethod) || "现金";
    if (!["现金", "微信", "支付宝", "银行卡", "其他"].includes(paymentMethod)) reject("退款方式不正确");
    const result = await withTransaction(async (client) => idempotent(client, `deposit-refund:${reservationId}`, key, user.id, payload, async () => {
      const reservation = await client.query(`SELECT id FROM banquet_reservations WHERE id = $1 FOR UPDATE`, [reservationId]);
      if (!reservation.rows[0]) reject("宴席预定不存在", 404);
      const available = await depositBalance(client, reservationId);
      if (amount > available) reject(`可退定金只有 ${available} 分`, 409);
      await client.query(
        `INSERT INTO banquet_deposit_ledger (reservation_id, kind, amount_fen, payment_method, request_key, operator_id, note)
         VALUES ($1, 'REFUND', $2, $3, $4, $5, $6)`,
        [reservationId, amount, paymentMethod, key, user.id, text(payload.note).slice(0, 300)]
      );
      await logOperation(client, user.id, "REFUND_BANQUET_DEPOSIT", reservationId, { amountFen: amount });
      return { reservation: await reservationDetails(client, reservationId) };
    }));
    res.status(201).json(result);
  } catch (error) { publicError(res, error); }
});

async function convertReservationToOrder(client: DbClient, reservationId: string, employeeId: string, automatic = false) {
      const selected = await client.query<Reservation & { table_status: string | null }>(
        `SELECT r.*, h.name AS hall_name,
                COALESCE(t.name, h.name, '未指定桌台') AS table_name,
                t.number AS table_number, t.seats AS table_seats, t.status AS table_status
         FROM banquet_reservations r
         LEFT JOIN banquet_halls h ON h.id = r.hall_id
         LEFT JOIN restaurant_tables t ON t.id = r.table_id
         WHERE r.id = $1 FOR UPDATE OF r`,
        [reservationId]
      );
      const reservation = selected.rows[0];
      if (!reservation) reject("宴席预定不存在", 404);
      if (reservation.status === "CONVERTED" && reservation.order_id) return { orderId: reservation.order_id, reservationId };
      if (reservation.status !== "RESERVED") reject("该宴席已取消或过期，不能开台", 409);
      if (Date.parse(reservation.ends_at) <= Date.now()) reject("宴席时间已过，未开台预定已过期", 409);
      if (reservation.table_id) {
        const tableResult = await client.query<{ id: string; number: number; name: string; status: string }>(
          `SELECT id, number, name, status FROM restaurant_tables WHERE id = $1 FOR UPDATE`, [reservation.table_id]
        );
        const table = tableResult.rows[0];
        if (!table) reject("关联桌台不存在，请重新建立预定", 409);
        if (table.status === "DISABLED") reject("关联桌台已停用，不能开立账单", 409);
        const openOrder = await client.query(`SELECT id FROM orders WHERE table_id = $1 AND status = 'OPEN' LIMIT 1`, [table.id]);
        if (openOrder.rows[0]) reject("该桌台当前已有进行中的账单，请先处理桌台状态", 409);
      } else if (!reservation.hall_id) {
        reject("该宴席没有绑定桌台，请重新建立预定", 409);
      }
      const phone = normalizeCustomerPhone(reservation.customer_phone);
      const customerId = phone ? await findOrCreateCustomer(client, phone, reservation.customer_name || null) : null;
      const orderResult = await client.query<{ id: string }>(
        `INSERT INTO orders
         (table_id, table_number_snapshot, table_name_snapshot, customer_id, guest_label, people_count, created_by, order_note, points_earning_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [reservation.table_id, reservation.table_number, reservation.table_name, customerId,
          customerId ? null : (reservation.customer_name || "宴席客人"), reservation.people_count, employeeId,
          `宴席预定 ${reservationId}`, reservation.points_earning_enabled]
      );
      const orderId = orderResult.rows[0].id;
      if (reservation.table_id) {
        await client.query(`UPDATE restaurant_tables SET status = 'OCCUPIED', updated_at = now() WHERE id = $1`, [reservation.table_id]);
      }
      const preorder = Array.isArray(reservation.preorder) ? reservation.preorder : [];
      assertPreorderFitsPostgresInteger(preorder);
      if (preorder.length) {
        const batch = await client.query<{ id: string }>(
          `INSERT INTO order_batches (order_id, batch_no, kind, created_by) VALUES ($1, 1, 'INITIAL', $2) RETURNING id`, [orderId, employeeId]
        );
        for (const item of preorder) {
          await client.query(
            `INSERT INTO order_items
             (batch_id, order_id, dish_id, dish_name, category_name, unit, price_fen, cost_fen, points_earning_enabled, quantity, note, option_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
            [batch.rows[0].id, orderId, item.dishId, item.name, item.categoryName || "未分类", item.unit || "份", item.priceFen,
              item.costFen || 0, item.pointsEarningEnabled !== false, item.quantity, item.note || "", JSON.stringify(item.optionSnapshot || [])]
          );
        }
        await client.query(`UPDATE orders SET order_version = 1, updated_at = now() WHERE id = $1`, [orderId]);
      }
      await client.query(
        `UPDATE banquet_reservations SET status = 'CONVERTED', order_id = $1, updated_by = $2, updated_at = now() WHERE id = $3`,
        [orderId, employeeId, reservationId]
      );
      await logOperation(client, employeeId, automatic ? "AUTO_OPEN_BANQUET_ORDER" : "CONVERT_BANQUET_TO_ORDER", reservationId, { orderId, itemCount: preorder.length });
      return { orderId, reservationId };
}

banquetRouter.post("/reservations/:reservationId/convert", async (req: AuthenticatedRequest, res) => {
  try {
    const user = userOf(req);
    const reservationId = routeId(req, "reservationId");
    const key = requestKey(req.body);
    const payload = payloadWithoutKey(req.body);
    const response = await withTransaction(async (client) => idempotent(client, `reservation-convert:${reservationId}`, key, user.id, payload, () => convertReservationToOrder(client, reservationId, user.id)));
    res.status(201).json(response);
  } catch (error) { publicError(res, error); }
});

/** Open due banquets without displacing an active table order. Occupied tables remain reserved and are retried. */
export async function autoOpenDueBanquets(): Promise<number> {
  await pool.query(
    `UPDATE banquet_reservations
     SET status = 'EXPIRED', updated_at = now()
     WHERE status = 'RESERVED' AND ends_at <= now()`
  );
  const due = await pool.query<{ id: string; created_by: string }>(
    `SELECT id, created_by FROM banquet_reservations
     WHERE status = 'RESERVED' AND starts_at <= now() AND ends_at > now()
     ORDER BY starts_at, id LIMIT 50`
  );
  let opened = 0;
  for (const reservation of due.rows) {
    try {
      await withTransaction((client) => convertReservationToOrder(client, reservation.id, reservation.created_by, true));
      opened += 1;
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      if (status !== 409) console.error(`宴席自动开台失败：${reservation.id}`, error);
    }
  }
  return opened;
}

/** Apply some or all available banquet deposit inside the checkout's transaction. */
export async function applyBanquetDepositForCheckout(
  client: DbClient,
  orderId: string,
  settlementId: string,
  operatorId: string,
  desiredFen: number
): Promise<number> {
  const desired = nonNegativeInt(desiredFen, "定金抵扣金额");
  if (!desired) return 0;
  const result = await client.query<{ id: string }>(
    `SELECT id FROM banquet_reservations WHERE order_id = $1 FOR UPDATE`, [orderId]
  );
  const reservation = result.rows[0];
  if (!reservation) return 0;
  const previous = await client.query<{ amount_fen: number }>(
    `SELECT amount_fen FROM banquet_deposit_ledger WHERE settlement_id = $1 AND kind = 'APPLY'`, [settlementId]
  );
  if (previous.rows[0]) return Number(previous.rows[0].amount_fen);
  const available = await depositBalance(client, reservation.id);
  const applied = Math.min(desired, available);
  if (!applied) return 0;
  await client.query(
    `INSERT INTO banquet_deposit_ledger (reservation_id, settlement_id, kind, amount_fen, operator_id, note)
     VALUES ($1, $2, 'APPLY', $3, $4, '结账抵扣宴席定金')`,
    [reservation.id, settlementId, applied, operatorId]
  );
  return applied;
}

/** Restore a previously applied deposit by appending a compensating ledger entry. */
export async function reverseBanquetDepositForSettlement(
  client: DbClient,
  settlementId: string,
  operatorId: string
): Promise<void> {
  const applied = await client.query<{ id: string; reservation_id: string; amount_fen: number }>(
    `SELECT id, reservation_id, amount_fen FROM banquet_deposit_ledger WHERE settlement_id = $1 AND kind = 'APPLY'`,
    [settlementId]
  );
  const source = applied.rows[0];
  if (!source) return;
  await client.query(`SELECT id FROM banquet_reservations WHERE id = $1 FOR UPDATE`, [source.reservation_id]);
  const restored = await client.query(`SELECT id FROM banquet_deposit_ledger WHERE reverses_ledger_id = $1 AND kind = 'RESTORE'`, [source.id]);
  if (restored.rows[0]) return;
  await client.query(
    `INSERT INTO banquet_deposit_ledger (reservation_id, settlement_id, kind, amount_fen, reverses_ledger_id, operator_id, note)
     VALUES ($1, $2, 'RESTORE', $3, $4, $5, '撤销结账恢复宴席定金')`,
    [source.reservation_id, settlementId, source.amount_fen, source.id, operatorId]
  );
}
