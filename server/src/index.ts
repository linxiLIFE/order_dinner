import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool, withTransaction, type DbClient } from "./db.js";
import { migrateAndSeed } from "./migrate.js";
import { createToken, requireAuth, requireRole } from "./auth.js";
import type { AuthenticatedRequest, AuthUser } from "./types.js";
import {
  businessDate,
  cents,
  getSettings,
  maskPhone,
  positiveInt,
  publicError,
  randomKey,
  settingBoolean,
  settingNumber
} from "./utils.js";

const app = express();
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

function normalizedPhone(value: unknown): string | null {
  const phone = text(value).replace(/\s+/g, "");
  if (!phone || phone === "散客") return null;
  if (!/^[0-9+\-()]{6,24}$/.test(phone)) fail("手机号格式不正确");
  return phone;
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

async function orderDetails(client: DbClient, orderId: string): Promise<Record<string, unknown>> {
  const orderResult = await client.query<{
    id: string;
    table_id: string | null;
    table_number: number | null;
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
  }>(
    `SELECT o.*, t.number AS table_number, c.name AS customer_name, c.phone AS customer_phone,
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
  return {
    id: order.id,
    tableId: order.table_id,
    tableNumber: order.table_number,
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
      batchNo: item.batch_no,
      batchKind: item.batch_kind,
      createdAt: item.created_at
    })),
    totals
  };
}

async function readIdempotent(client: DbClient, scope: string, requestKey: string): Promise<unknown | null> {
  if (!requestKey) return null;
  const result = await client.query<{ response: unknown }>(
    `SELECT response FROM idempotency_keys WHERE scope = $1 AND request_key = $2 FOR UPDATE`,
    [scope, requestKey]
  );
  return result.rows[0]?.response ?? null;
}

async function saveIdempotent(
  client: DbClient,
  scope: string,
  requestKey: string,
  employeeId: string,
  response: unknown
): Promise<void> {
  if (!requestKey) return;
  await client.query(
    `INSERT INTO idempotency_keys (scope, request_key, employee_id, response)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (scope, request_key) DO NOTHING`,
    [scope, requestKey, employeeId, JSON.stringify(response)]
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
    await client.query(
      `INSERT INTO print_jobs (order_id, batch_id, kind, copy_no, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [orderId, batchId, kind, copyNo, JSON.stringify({ ...(payload as object), copyNo })]
    );
  }
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
  return {
    title,
    orderId: order.id,
    tableNumber: order.tableNumber,
    peopleCount: order.peopleCount,
    customer: (order.customer as { name?: string; phone?: string | null } | undefined)?.name || "散客",
    phone: (order.customer as { phone?: string | null } | undefined)?.phone || null,
    createdAt: new Date().toISOString(),
    items: items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      note: item.note || ""
    }))
  };
}

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) });

app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "order-dinner", time: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) fail("请输入账号和密码");
    const result = await pool.query<{
      id: string;
      username: string;
      name: string;
      role: "OWNER" | "CASHIER";
      password_hash: string;
    }>(
      `SELECT id, username, name, role, password_hash FROM employees
       WHERE username = $1 AND active = true`,
      [parsed.data.username.trim()]
    );
    const employee = result.rows[0];
    if (!employee || !(await bcrypt.compare(parsed.data.password, employee.password_hash))) {
      res.status(401).json({ error: "账号或密码不正确" });
      return;
    }
    const user: AuthUser = {
      id: employee.id,
      username: employee.username,
      name: employee.name,
      role: employee.role
    };
    res.json({ token: createToken(user), user });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/auth/me", requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: currentUser(req) });
});

app.get("/api/tables", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.number, t.seats, t.status, t.sort_order,
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

app.post("/api/tables/:tableId/open", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const tableId = routeParam(req, "tableId");
    const requestKey = text(req.body?.idempotencyKey) || randomKey();
    const response = await withTransaction(async (client) => {
      const previous = await readIdempotent(client, `open:${tableId}`, requestKey);
      if (previous) return previous;
      const tableResult = await client.query<{ id: string; number: number; status: string }>(
        `SELECT id, number, status FROM restaurant_tables WHERE id = $1 FOR UPDATE`,
        [tableId]
      );
      const table = tableResult.rows[0];
      if (!table) fail("桌台不存在", 404);
      if (table.status !== "AVAILABLE") fail("桌台已被占用或停用，请刷新桌台状态");
      const phone = normalizedPhone(req.body?.phone);
      const customerName = text(req.body?.customerName) || null;
      let customerId: string | null = null;
      if (phone) {
        const customer = await client.query<{ id: string }>(
          `INSERT INTO customers (phone, name) VALUES ($1, $2)
           ON CONFLICT (phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name), updated_at = now()
           RETURNING id`,
          [phone, customerName]
        );
        customerId = customer.rows[0].id;
      }
      const order = await client.query<{ id: string }>(
        `INSERT INTO orders (table_id, customer_id, guest_label, people_count, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tableId, customerId, customerId ? null : "散客", positiveInt(req.body?.people, 2), user.id]
      );
      await client.query(`UPDATE restaurant_tables SET status = 'OCCUPIED', updated_at = now() WHERE id = $1`, [tableId]);
      await logOperation(client, user.id, "OPEN_TABLE", "ORDER", order.rows[0].id, { tableId, tableNumber: table.number });
      const result = await orderDetails(client, order.rows[0].id);
      await saveIdempotent(client, `open:${tableId}`, requestKey, user.id, result);
      return result;
    });
    res.status(201).json({ order: response });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/orders/:orderId", requireAuth, async (req, res) => {
  try {
    res.json({ order: await orderDetails(pool, routeParam(req, "orderId")) });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/orders/:orderId/items", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const orderId = routeParam(req, "orderId");
    const requestKey = text(req.body?.idempotencyKey) || randomKey();
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!rawItems.length) fail("请选择至少一道菜品");
    const response = await withTransaction(async (client) => {
      const previous = await readIdempotent(client, `items:${orderId}`, requestKey);
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
        const quantity = positiveInt(raw?.quantity, 0);
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
        const note = text(raw?.note);
        const item = await client.query<{ id: string }>(
          `INSERT INTO order_items
           (batch_id, order_id, dish_id, dish_name, category_name, unit, price_fen, cost_fen, quantity, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [batch.rows[0].id, orderId, dish.id, dish.name, dish.category_name || "未分类", dish.unit, dish.price_fen, dish.cost_fen, quantity, note]
        );
        inserted.push({ id: item.rows[0].id, name: dish.name, unit: dish.unit, quantity, note });
      }
      await client.query(`UPDATE orders SET order_version = order_version + 1, updated_at = now() WHERE id = $1`, [orderId]);
      const details = await orderDetails(client, orderId);
      await makePrintJobs(
        client,
        orderId,
        batch.rows[0].id,
        "KITCHEN",
        printOrderPayload(details, inserted, "备菜单"),
        2
      );
      await logOperation(client, user.id, "ADD_ITEMS", "ORDER", orderId, { batchNo: batch.rows[0].batch_no, items: inserted });
      await saveIdempotent(client, `items:${orderId}`, requestKey, user.id, details);
      return details;
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
    const quantity = positiveInt(req.body?.quantity, 0);
    if (!quantity) fail("赠送数量必须大于零");
    const response = await withTransaction(async (client) => {
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
      await logOperation(client, user.id, "GIFT_ITEM", "ORDER_ITEM", itemId, { orderId, quantity, reason: text(req.body?.reason) });
      return orderDetails(client, orderId);
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
    const quantity = positiveInt(req.body?.quantity, 0);
    if (!quantity) fail("退菜数量必须大于零");
    const response = await withTransaction(async (client) => {
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
      const made = Boolean(req.body?.made);
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
      const details = await orderDetails(client, orderId);
      const returnItem = {
        name: item.dish_name,
        unit: item.unit,
        quantity,
        note: `${made ? "已制作" : "未制作"}${text(req.body?.reason) ? `，${text(req.body.reason)}` : ""}`
      };
      await makePrintJobs(client, orderId, batch.rows[0].id, "RETURN", printOrderPayload(details, [returnItem], "退菜单"), 2);
      await logOperation(client, user.id, "RETURN_ITEM", "ORDER_ITEM", itemId, {
        orderId,
        quantity,
        made,
        reason: text(req.body?.reason)
      });
      return details;
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
    const requestKey = text(req.body?.idempotencyKey) || randomKey();
    const response = await withTransaction(async (client) => {
      const previous = await readIdempotent(client, `checkout:${orderId}`, requestKey);
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
      const manualInput = cents(req.body?.manualDiscountFen);
      let manualDiscountFen = Math.min(totals.subtotalFen, manualInput);
      const targetReceived = req.body?.targetReceivedFen === undefined ? null : cents(req.body.targetReceivedFen);
      if (targetReceived !== null) {
        if (targetReceived > totals.subtotalFen) fail("目标实收不能高于应收");
        manualDiscountFen = totals.subtotalFen - targetReceived;
      }
      const requestedPoints = cents(req.body?.pointsToRedeem);
      let customerBalance = 0;
      if (order.customer_id) {
        const customerResult = await client.query<{ points_balance: number }>(
          `SELECT points_balance FROM customers WHERE id = $1 FOR UPDATE`,
          [order.customer_id]
        );
        customerBalance = customerResult.rows[0]?.points_balance ?? 0;
      } else if (requestedPoints > 0) {
        fail("散客不能使用积分");
      }
      if (requestedPoints % redeemPoints !== 0) fail(`积分抵扣必须按 ${redeemPoints} 分使用`);
      const maxPoints = Math.floor(Math.max(0, totals.subtotalFen - manualDiscountFen) / redeemFen) * redeemPoints;
      if (requestedPoints > customerBalance) fail("可用积分不足");
      if (requestedPoints > maxPoints) fail("积分抵扣不能超过当前应收");
      const pointsDiscountFen = Math.floor(requestedPoints / redeemPoints) * redeemFen;
      const receivedFen = totals.subtotalFen - manualDiscountFen - pointsDiscountFen;
      const paidFen = cents(req.body?.receivedFen, receivedFen);
      if (paidFen !== receivedFen) fail(`收款金额不匹配，应收 ${receivedFen} 分`);
      const paymentMethod = text(req.body?.paymentMethod) || "现金";
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
      const details = await orderDetails(client, orderId);
      const receiptPayload = {
        ...printOrderPayload(details, details.items as Array<Record<string, unknown>>, "结账小票"),
        totals: {
          grossFen: totals.grossFen,
          giftFen: totals.giftFen,
          returnFen: totals.returnFen,
          manualDiscountFen,
          pointsDiscountFen,
          receivedFen
        },
        paymentMethod,
        earnedPoints,
        redeemedPoints: requestedPoints,
        pointsBalance: newBalance,
        footer: text(settings.receipt_footer, "谢谢光临")
      };
      await makePrintJobs(client, orderId, null, "RECEIPT", receiptPayload, 1);
      await logOperation(client, user.id, "CHECKOUT", "ORDER", orderId, {
        settlementId: settlement.rows[0].id,
        receivedFen,
        paymentMethod,
        earnedPoints,
        requestedPoints
      });
      const result = { order: details, settlement: { id: settlement.rows[0].id, ...receiptPayload.totals, paymentMethod, earnedPoints, redeemedPoints: requestedPoints, pointsBalance: newBalance } };
      await saveIdempotent(client, `checkout:${orderId}`, requestKey, user.id, result);
      return result;
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
    const response = await withTransaction(async (client) => {
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
        balanceAfter = balance - settlement.earned_points + settlement.redeemed_points;
        await client.query(`UPDATE customers SET points_balance = $1, updated_at = now() WHERE id = $2`, [balanceAfter, original.customer_id]);
        if (settlement.earned_points) {
          await client.query(
            `INSERT INTO points_ledger
             (customer_id, order_id, settlement_id, delta, kind, balance_after, operator_id, note)
             VALUES ($1, $2, $3, $4, 'REVERSE_EARN', $5, $6, '撤销结账收回积分')`,
            [original.customer_id, orderId, settlement.id, -settlement.earned_points, balanceAfter, user.id]
          );
        }
        if (settlement.redeemed_points) {
          await client.query(
            `INSERT INTO points_ledger
             (customer_id, order_id, settlement_id, delta, kind, balance_after, operator_id, note)
             VALUES ($1, $2, $3, $4, 'REVERSE_REDEEM', $5, $6, '撤销结账返还积分')`,
            [original.customer_id, orderId, settlement.id, settlement.redeemed_points, balanceAfter, user.id]
          );
        }
      }
      await client.query(
        `UPDATE settlements SET status = 'REVERSED', reversed_by = $1, reversed_at = now() WHERE id = $2`,
        [user.id, settlement.id]
      );
      await client.query(`UPDATE orders SET status = 'REVERSED', updated_at = now() WHERE id = $1`, [orderId]);
      if (original.table_id) {
        const table = await client.query<{ status: string }>(
          `SELECT status FROM restaurant_tables WHERE id = $1 FOR UPDATE`,
          [original.table_id]
        );
        if (table.rows[0]?.status !== "AVAILABLE") fail("原桌台已经开了新账单，请先处理当前账单");
      }
      const newOrder = await client.query<{ id: string }>(
        `INSERT INTO orders
         (table_id, customer_id, guest_label, people_count, status, parent_order_id, created_by, business_date)
         VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, $7) RETURNING id`,
        [original.table_id, original.customer_id, original.guest_label, original.people_count, orderId, user.id, original.business_date]
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
            gifted_quantity, returned_quantity, returned_made_quantity, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [copiedBatchId, newOrderId, item.dish_id, item.dish_name, item.category_name, item.unit, item.price_fen, item.cost_fen,
            item.quantity, item.gifted_quantity, item.returned_quantity, item.returned_made_quantity, item.note]
        );
      }
      if (original.table_id) {
        await client.query(`UPDATE restaurant_tables SET status = 'OCCUPIED', updated_at = now() WHERE id = $1`, [original.table_id]);
      }
      await logOperation(client, user.id, "REOPEN_ORDER", "ORDER", orderId, { newOrderId, settlementId: settlement.id });
      return { originalOrderId: orderId, order: await orderDetails(client, newOrderId), pointsBalance: balanceAfter };
    });
    res.json(response);
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/categories", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query(`SELECT id, name, sort_order, active FROM categories WHERE active = true ORDER BY sort_order, name`);
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
    const result = await pool.query<{ id: string; name: string }>(
      `INSERT INTO categories (name, sort_order) VALUES ($1, $2) RETURNING id, name`,
      [name, cents(req.body?.sortOrder)]
    );
    await logOperation(pool, user.id, "CREATE_CATEGORY", "CATEGORY", result.rows[0].id, { name });
    res.status(201).json({ category: result.rows[0] });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/dishes", requireAuth, async (req, res) => {
  try {
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
              d.price_fen, d.cost_fen, d.image_url, d.on_sale, d.sort_order
       FROM dishes d LEFT JOIN categories c ON c.id = d.category_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY c.sort_order NULLS LAST, d.sort_order, d.name`,
      params
    );
    res.json({ dishes: result.rows });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/dishes", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const name = text(req.body?.name);
    if (!name) fail("菜品名称不能为空");
    const result = await pool.query<{ id: string }>(
      `INSERT INTO dishes (category_id, name, pinyin, unit, price_fen, cost_fen, image_url, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        text(req.body?.categoryId) || null,
        name,
        text(req.body?.pinyin),
        text(req.body?.unit) || "份",
        cents(req.body?.priceFen),
        cents(req.body?.costFen),
        text(req.body?.imageUrl) || null,
        cents(req.body?.sortOrder)
      ]
    );
    await logOperation(pool, user.id, "CREATE_DISH", "DISH", result.rows[0].id, { name });
    res.status(201).json({ dishId: result.rows[0].id });
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
    if (req.body?.name !== undefined) add("name", text(req.body.name));
    if (req.body?.categoryId !== undefined) add("category_id", text(req.body.categoryId) || null);
    if (req.body?.pinyin !== undefined) add("pinyin", text(req.body.pinyin));
    if (req.body?.unit !== undefined) add("unit", text(req.body.unit) || "份");
    if (req.body?.priceFen !== undefined) add("price_fen", cents(req.body.priceFen));
    if (req.body?.costFen !== undefined) add("cost_fen", cents(req.body.costFen));
    if (req.body?.onSale !== undefined) add("on_sale", Boolean(req.body.onSale));
    if (req.body?.sortOrder !== undefined) add("sort_order", cents(req.body.sortOrder));
    if (!fields.length) fail("没有要修改的内容");
    values.push(dishId);
    const result = await pool.query(`UPDATE dishes SET ${fields.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING id`, values);
    if (!result.rows[0]) fail("菜品不存在", 404);
    await logOperation(pool, user.id, "UPDATE_DISH", "DISH", dishId, req.body);
    res.json({ ok: true });
  } catch (error) {
    publicError(res, error);
  }
});

app.delete("/api/dishes/:dishId", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const dishId = routeParam(req, "dishId");
    const result = await pool.query(`UPDATE dishes SET on_sale = false, updated_at = now() WHERE id = $1 RETURNING id`, [dishId]);
    if (!result.rows[0]) fail("菜品不存在", 404);
    await logOperation(pool, user.id, "ARCHIVE_DISH", "DISH", dishId);
    res.json({ ok: true });
  } catch (error) {
    publicError(res, error);
  }
});

app.patch("/api/tables/:tableId", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const fields: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (req.body?.number !== undefined) add("number", positiveInt(req.body.number));
    if (req.body?.seats !== undefined) add("seats", positiveInt(req.body.seats, 4));
    if (req.body?.status !== undefined && ["AVAILABLE", "DISABLED"].includes(text(req.body.status))) add("status", text(req.body.status));
    if (!fields.length) fail("没有要修改的内容");
    const tableId = routeParam(req, "tableId");
    values.push(tableId);
    const result = await pool.query(`UPDATE restaurant_tables SET ${fields.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING id`, values);
    if (!result.rows[0]) fail("桌台不存在", 404);
    await logOperation(pool, user.id, "UPDATE_TABLE", "TABLE", tableId, req.body);
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

async function statsData(from: string, to: string) {
  const summary = await pool.query(
    `WITH active AS (
       SELECT s.*, o.business_date, o.people_count, o.customer_id, o.table_id
       FROM settlements s JOIN orders o ON o.id = s.order_id
       WHERE s.status = 'ACTIVE' AND o.business_date BETWEEN $1::date AND $2::date
     ), costs AS (
       SELECT a.order_id,
              COALESCE(SUM((oi.quantity - oi.returned_quantity + oi.returned_made_quantity) * oi.cost_fen), 0) AS cost_fen,
              COALESCE(SUM(oi.returned_made_quantity * oi.cost_fen), 0) AS loss_fen
       FROM active a JOIN order_items oi ON oi.order_id = a.order_id GROUP BY a.order_id
     )
     SELECT COALESCE(SUM(a.received_fen), 0) AS revenue_fen,
            COUNT(*)::int AS order_count,
            COALESCE(SUM(a.people_count), 0)::int AS people_count,
            COALESCE(SUM(a.gross_fen - a.gift_fen - a.return_fen - a.manual_discount_fen - a.points_discount_fen), 0) AS due_fen,
            COALESCE(SUM(a.gift_fen + a.manual_discount_fen + a.points_discount_fen), 0) AS discount_fen,
            COALESCE(SUM(c.cost_fen), 0) AS cost_fen,
            COALESCE(SUM(c.loss_fen), 0) AS loss_fen,
            COUNT(DISTINCT a.table_id)::int AS used_table_count,
            COUNT(*) FILTER (WHERE a.customer_id IS NULL)::int AS guest_orders
     FROM active a LEFT JOIN costs c ON c.order_id = a.order_id`,
    [from, to]
  );
  const sales = await pool.query(
    `SELECT oi.dish_name, SUM(oi.quantity - oi.returned_quantity)::int AS sold_quantity,
            SUM(oi.gifted_quantity)::int AS gifted_quantity,
            SUM(oi.returned_quantity)::int AS returned_quantity,
            SUM((oi.quantity - oi.returned_quantity) * oi.price_fen) AS amount_fen
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     JOIN settlements s ON s.order_id = o.id AND s.status = 'ACTIVE'
     WHERE o.business_date BETWEEN $1::date AND $2::date
     GROUP BY oi.dish_name ORDER BY sold_quantity DESC, oi.dish_name`,
    [from, to]
  );
  const customers = await pool.query(
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
      averageOrderFen: Number(row.order_count || 0) ? Math.round(revenueFen / Number(row.order_count)) : 0,
      averagePersonFen: peopleCount ? Math.round(revenueFen / peopleCount) : 0,
      grossProfitFen: revenueFen - costFen,
      grossMarginPercent: revenueFen ? Math.round(((revenueFen - costFen) / revenueFen) * 10000) / 100 : 0,
      discountFen: Number(row.discount_fen || 0),
      lossFen: Number(row.loss_fen || 0),
      usedTableCount: Number(row.used_table_count || 0),
      newCustomers: Number(customers.rows[0]?.new_customers || 0),
      returningCustomers: Number(customers.rows[0]?.returning_customers || 0),
      guestOrders: Number(row.guest_orders || 0)
    },
    sales: sales.rows
  };
}

app.get("/api/stats", requireAuth, requireRole("OWNER"), async (req, res) => {
  try {
    const today = businessDate();
    const from = text(req.query.from) || today;
    const to = text(req.query.to) || today;
    res.json(await statsData(from, to));
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/stats/export.csv", requireAuth, requireRole("OWNER"), async (req, res) => {
  try {
    const today = businessDate();
    const data = await statsData(text(req.query.from) || today, text(req.query.to) || today);
    const rows = [
      ["菜品", "售出数量", "赠送数量", "退菜数量", "销售金额（分）"],
      ...data.sales.map((row) => [row.dish_name, row.sold_quantity, row.gifted_quantity, row.returned_quantity, row.amount_fen])
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=营业统计.csv");
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
    const allowed = new Set([
      "store_name",
      "receipt_footer",
      "points_enabled",
      "points_earn_fen",
      "points_redeem_points",
      "points_redeem_fen",
      "printer_device_id",
      "printer_device_name"
    ]);
    await withTransaction(async (client) => {
      for (const [key, value] of Object.entries(req.body || {})) {
        if (!allowed.has(key)) continue;
        await client.query(
          `INSERT INTO store_settings (key, value, updated_by, updated_at)
           VALUES ($1, $2::jsonb, $3, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [key, JSON.stringify(value), user.id]
        );
      }
      await logOperation(client, user.id, "UPDATE_SETTINGS", "SETTING", null, req.body);
    });
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
    const password = text(req.body?.password);
    const name = text(req.body?.name) || username;
    if (!username || password.length < 8) fail("收银员账号和至少 8 位密码不能为空");
    const result = await pool.query<{ id: string }>(
      `INSERT INTO employees (username, name, password_hash, role) VALUES ($1, $2, $3, 'CASHIER') RETURNING id`,
      [username, name, await bcrypt.hash(password, 12)]
    );
    await logOperation(pool, user.id, "CREATE_EMPLOYEE", "EMPLOYEE", result.rows[0].id, { username, name });
    res.status(201).json({ employeeId: result.rows[0].id });
  } catch (error) {
    publicError(res, error);
  }
});

app.patch("/api/employees/:employeeId", requireAuth, requireRole("OWNER"), async (req: AuthenticatedRequest, res) => {
  try {
    const user = currentUser(req);
    const updates: string[] = [];
    const values: unknown[] = [];
    if (req.body?.active !== undefined) {
      values.push(Boolean(req.body.active));
      updates.push(`active = $${values.length}`);
    }
    if (req.body?.password) {
      if (text(req.body.password).length < 8) fail("密码至少 8 位");
      values.push(await bcrypt.hash(text(req.body.password), 12));
      updates.push(`password_hash = $${values.length}`);
    }
    if (!updates.length) fail("没有要修改的内容");
    const employeeId = routeParam(req, "employeeId");
    values.push(employeeId);
    const result = await pool.query(`UPDATE employees SET ${updates.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING id`, values);
    if (!result.rows[0]) fail("员工不存在", 404);
    await logOperation(pool, user.id, "UPDATE_EMPLOYEE", "EMPLOYEE", employeeId, { active: req.body?.active });
    res.json({ ok: true });
  } catch (error) {
    publicError(res, error);
  }
});

app.get("/api/print-jobs", requireAuth, async (req, res) => {
  try {
    const status = ["PENDING", "CLAIMED", "SENT", "FAILED", "NEEDS_CHECK"].includes(text(req.query.status))
      ? text(req.query.status)
      : "PENDING";
    const limit = Math.min(100, Math.max(1, positiveInt(req.query.limit, 30)));
    const result = await pool.query(
      `SELECT id, order_id, batch_id, kind, copy_no, payload, status, device_id, attempts,
              last_error, claimed_at, sent_at, created_at
       FROM print_jobs WHERE status = $1 ORDER BY created_at LIMIT $2`,
      [status, limit]
    );
    res.json({ jobs: result.rows });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/print-jobs/claim", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const deviceId = text(req.body?.deviceId);
    if (!deviceId) fail("打印设备编号不能为空");
    const result = await withTransaction(async (client) => {
      const job = await client.query(
        `SELECT id FROM print_jobs WHERE status IN ('PENDING', 'FAILED')
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`
      );
      if (!job.rows[0]) return null;
      const updated = await client.query(
        `UPDATE print_jobs SET status = 'CLAIMED', device_id = $1, attempts = attempts + 1, claimed_at = now()
         WHERE id = $2 RETURNING id, order_id, batch_id, kind, copy_no, payload, attempts`,
        [deviceId, job.rows[0].id]
      );
      return updated.rows[0];
    });
    res.json({ job: result });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/print-jobs/:jobId/ack", requireAuth, async (req, res) => {
  try {
    const status = text(req.body?.status);
    if (!["SENT", "FAILED", "NEEDS_CHECK"].includes(status)) fail("打印回执状态不正确");
    const result = await pool.query(
      `UPDATE print_jobs SET status = $1, last_error = $2, sent_at = CASE WHEN $1 = 'SENT' THEN now() ELSE sent_at END
       WHERE id = $3 RETURNING id, status`,
      [status, text(req.body?.error) || null, routeParam(req, "jobId")]
    );
    if (!result.rows[0]) fail("打印任务不存在", 404);
    res.json({ job: result.rows[0] });
  } catch (error) {
    publicError(res, error);
  }
});

app.post("/api/print-jobs/:jobId/retry", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE print_jobs SET status = 'PENDING', device_id = NULL, last_error = NULL, claimed_at = NULL
       WHERE id = $1 AND status IN ('FAILED', 'NEEDS_CHECK') RETURNING id`,
      [routeParam(req, "jobId")]
    );
    if (!result.rows[0]) fail("当前打印任务不可重试");
    res.json({ ok: true });
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
  app.listen(port, () => {
    console.log(`餐厅点单系统已启动：http://0.0.0.0:${port}`);
  });
}

start().catch((error) => {
  console.error("系统启动失败", error);
  process.exitCode = 1;
});

export { app };
