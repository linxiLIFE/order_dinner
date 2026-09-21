import bcrypt from "bcryptjs";
import { pool } from "./db.js";
import { OTHER_CATEGORY_DISHES } from "./menu.js";

const schema = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('OWNER', 'CASHIER')),
  auth_version integer NOT NULL DEFAULT 0 CHECK (auth_version >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer NOT NULL UNIQUE CHECK (number > 0),
  name text NOT NULL,
  seats integer NOT NULL DEFAULT 4 CHECK (seats > 0),
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'OCCUPIED', 'DISABLED')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text UNIQUE,
  name text,
  points_balance integer NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dishes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid REFERENCES categories(id),
  name text NOT NULL,
  pinyin text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT '份',
  price_fen integer NOT NULL CHECK (price_fen >= 0),
  cost_fen integer NOT NULL DEFAULT 0 CHECK (cost_fen >= 0),
  image_url text,
  on_sale boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dishes_search_idx ON dishes (name, pinyin);

CREATE TABLE IF NOT EXISTS dish_option_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dish_id uuid NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  name text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  allow_multiple boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dish_option_groups_dish_idx ON dish_option_groups (dish_id, sort_order);

CREATE TABLE IF NOT EXISTS dish_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES dish_option_groups(id) ON DELETE CASCADE,
  label text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dish_options_group_idx ON dish_options (group_id, sort_order);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid REFERENCES restaurant_tables(id),
  table_number_snapshot integer,
  table_name_snapshot text,
  customer_id uuid REFERENCES customers(id),
  guest_label text,
  people_count integer NOT NULL DEFAULT 2 CHECK (people_count > 0),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'SETTLED', 'REVERSED', 'VOID')),
  order_version integer NOT NULL DEFAULT 0,
  business_date date NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,
  parent_order_id uuid REFERENCES orders(id),
  created_by uuid REFERENCES employees(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  ended_at timestamptz,
  ended_by uuid REFERENCES employees(id),
  end_reason text NOT NULL DEFAULT '',
  order_note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_open_table_idx ON orders (table_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS orders_business_date_idx ON orders (business_date, status);

CREATE TABLE IF NOT EXISTS order_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  batch_no integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('INITIAL', 'ADD', 'RETURN', 'REPRINT')),
  created_by uuid REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, batch_no)
);

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES order_batches(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  dish_id uuid REFERENCES dishes(id),
  dish_name text NOT NULL,
  category_name text NOT NULL DEFAULT '未分类',
  unit text NOT NULL DEFAULT '份',
  price_fen integer NOT NULL CHECK (price_fen >= 0),
  cost_fen integer NOT NULL DEFAULT 0 CHECK (cost_fen >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  gifted_quantity integer NOT NULL DEFAULT 0 CHECK (gifted_quantity >= 0),
  returned_quantity integer NOT NULL DEFAULT 0 CHECK (returned_quantity >= 0),
  returned_made_quantity integer NOT NULL DEFAULT 0 CHECK (returned_made_quantity >= 0),
  note text NOT NULL DEFAULT '',
  option_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (gifted_quantity <= quantity),
  CHECK (returned_quantity <= quantity),
  CHECK (returned_made_quantity <= returned_quantity)
);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id, created_at);

CREATE TABLE IF NOT EXISTS settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  version integer NOT NULL DEFAULT 1,
  gross_fen integer NOT NULL,
  gift_fen integer NOT NULL DEFAULT 0,
  return_fen integer NOT NULL DEFAULT 0,
  manual_discount_fen integer NOT NULL DEFAULT 0,
  points_discount_fen integer NOT NULL DEFAULT 0,
  received_fen integer NOT NULL,
  payment_method text NOT NULL,
  earned_points integer NOT NULL DEFAULT 0,
  redeemed_points integer NOT NULL DEFAULT 0,
  operator_id uuid REFERENCES employees(id),
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVERSED')),
  reversed_by uuid REFERENCES employees(id),
  reversed_at timestamptz,
  settled_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, version)
);

CREATE INDEX IF NOT EXISTS settlements_active_date_idx ON settlements (settled_at) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS points_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  order_id uuid REFERENCES orders(id),
  settlement_id uuid REFERENCES settlements(id),
  delta integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('EARN', 'REDEEM', 'REVERSE_EARN', 'REVERSE_REDEEM', 'ADJUST')),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  operator_id uuid REFERENCES employees(id),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS points_ledger_customer_idx ON points_ledger (customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES orders(id),
  batch_id uuid REFERENCES order_batches(id),
  kind text NOT NULL CHECK (kind IN ('KITCHEN', 'RETURN', 'RECEIPT')),
  copy_no integer NOT NULL DEFAULT 1 CHECK (copy_no BETWEEN 1 AND 20),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CLAIMED', 'SENT', 'FAILED', 'NEEDS_CHECK')),
  device_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  manual_requested_at timestamptz,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  current_copy_check text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO current_copy_check
    FROM pg_constraint
   WHERE conrelid = 'print_jobs'::regclass
     AND conname = 'print_jobs_copy_no_check';

  IF current_copy_check IS NULL
     OR current_copy_check NOT ILIKE '%copy_no >= 1%'
     OR current_copy_check NOT ILIKE '%copy_no <= 20%' THEN
    ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_copy_no_check;
    ALTER TABLE print_jobs
      ADD CONSTRAINT print_jobs_copy_no_check
      CHECK (copy_no BETWEEN 1 AND 20);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS print_jobs_queue_idx ON print_jobs (status, created_at);

CREATE TABLE IF NOT EXISTS printer_devices (
  id text PRIMARY KEY,
  name text NOT NULL,
  token_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  created_by uuid REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid REFERENCES employees(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS store_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES employees(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope text NOT NULL,
  request_key text NOT NULL,
  employee_id uuid REFERENCES employees(id),
  response jsonb NOT NULL,
  payload_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, request_key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx ON idempotency_keys (created_at);
CREATE INDEX IF NOT EXISTS print_jobs_claimed_at_idx ON print_jobs (claimed_at) WHERE status = 'CLAIMED';

CREATE TABLE IF NOT EXISTS app_migrations (
  name text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now()
);
`;

const settings = {
  store_name: "我的餐厅",
  receipt_footer: "谢谢光临",
  points_enabled: true,
  points_earn_fen: 100,
  points_redeem_points: 10,
  points_redeem_fen: 100,
  printer_device_id: "",
  printer_device_name: "未配置打印设备"
};

export async function migrateAndSeed(): Promise<void> {
  await pool.query(schema);

  // 这些列同时兼容已部署的旧版本数据库；CREATE TABLE IF NOT EXISTS
  // 不会给已有表补列，所以这里必须使用可重复执行的增量迁移。
  await pool.query(`ALTER TABLE restaurant_tables ADD COLUMN IF NOT EXISTS name text`);
  await pool.query(`UPDATE restaurant_tables SET name = number::text || '号桌' WHERE name IS NULL OR btrim(name) = ''`);
  await pool.query(`ALTER TABLE restaurant_tables ALTER COLUMN name SET NOT NULL`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ended_at timestamptz`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ended_by uuid REFERENCES employees(id)`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS end_reason text NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_note text NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_number_snapshot integer`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_name_snapshot text`);
  await pool.query(
    `UPDATE orders o SET table_number_snapshot = t.number, table_name_snapshot = t.name
     FROM restaurant_tables t WHERE t.id = o.table_id
       AND (o.table_number_snapshot IS NULL OR o.table_name_snapshot IS NULL)`
  );
  await pool.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS option_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS manual_requested_at timestamptz`);
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS payload_hash text`);

  await pool.query(
    `UPDATE restaurant_tables t
     SET status = CASE
       WHEN EXISTS (SELECT 1 FROM orders o WHERE o.table_id = t.id AND o.status = 'OPEN') THEN 'OCCUPIED'
       WHEN t.status = 'OCCUPIED' THEN 'AVAILABLE'
       ELSE t.status
     END
     WHERE t.status <> CASE
       WHEN EXISTS (SELECT 1 FROM orders o WHERE o.table_id = t.id AND o.status = 'OPEN') THEN 'OCCUPIED'
       WHEN t.status = 'OCCUPIED' THEN 'AVAILABLE'
       ELSE t.status
     END`
  );
  const duplicateOpenTables = await pool.query<{ table_id: string; count: string }>(
    `SELECT table_id, COUNT(*)::text AS count FROM orders
     WHERE status = 'OPEN' AND table_id IS NOT NULL
     GROUP BY table_id HAVING COUNT(*) > 1`
  );
  if (duplicateOpenTables.rows.length) {
    throw new Error(`发现 ${duplicateOpenTables.rows.length} 张桌台存在多笔进行中订单；请先人工核对订单后再启动`);
  }
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS orders_one_open_per_table_idx
     ON orders (table_id) WHERE status = 'OPEN' AND table_id IS NOT NULL`
  );

  for (let number = 1; number <= 12; number += 1) {
    await pool.query(
      `INSERT INTO restaurant_tables (number, name, seats, sort_order)
       VALUES ($1, $2, 4, $1)
       ON CONFLICT (number) DO NOTHING`,
      [number, `${number}号桌`]
    );
  }
  await pool.query(
    `INSERT INTO categories (name, sort_order) VALUES ('待配置', 0)
     ON CONFLICT (name) DO NOTHING`
  );

  for (const [key, value] of Object.entries(settings)) {
    await pool.query(
      `INSERT INTO store_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
  }

  const username = process.env.BOOTSTRAP_ADMIN_USERNAME || "admin";
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!password) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD 未设置，拒绝启动以避免使用不安全的默认密码");
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO employees (username, name, password_hash, role)
     VALUES ($1, '老板', $2, 'OWNER')
     ON CONFLICT (username) DO NOTHING`,
    [username, passwordHash]
  );

  await seedProductionMenu();
  if (process.env.SEED_DEMO_DATA === "true") await seedDemoDishes();

  await pruneExpiredIdempotencyKeys();
}

export async function pruneExpiredIdempotencyKeys(): Promise<void> {
  await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '90 days'`);
}

async function seedProductionMenu(): Promise<void> {
  const migrationName = "20260921_initial_53_production_menu";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [migrationName]);
    const applied = await client.query(`SELECT 1 FROM app_migrations WHERE name = $1`, [migrationName]);
    if (applied.rows.length) {
      await client.query("COMMIT");
      return;
    }

    await client.query(
      `INSERT INTO categories (name, sort_order, active) VALUES ('其他', 999, true)
       ON CONFLICT (name) DO NOTHING`
    );
    const categoryResult = await client.query<{ id: string; active: boolean }>(
      `SELECT id, active FROM categories WHERE name = '其他'`
    );
    const categoryId = categoryResult.rows[0]?.id;
    if (!categoryId) throw new Error("创建其他分类失败");
    if (!categoryResult.rows[0].active) {
      await client.query(`UPDATE categories SET active = true, updated_at = now() WHERE id = $1`, [categoryId]);
    }

    for (const [name, priceFen, costFen] of OTHER_CATEGORY_DISHES) {
      await client.query(
        `INSERT INTO dishes (category_id, name, price_fen, cost_fen)
         SELECT $1, $2, $3, $4
         WHERE NOT EXISTS (SELECT 1 FROM dishes WHERE name = $2)`,
        [categoryId, name, priceFen, costFen]
      );
    }

    await client.query(`INSERT INTO app_migrations (name) VALUES ($1)`, [migrationName]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedDemoDishes(): Promise<void> {
  await pool.query(
    `INSERT INTO categories (name, sort_order) VALUES ('示例菜品', 10)
     ON CONFLICT (name) DO NOTHING`
  );
  const category = await pool.query<{ id: string; active: boolean }>(
    `SELECT id, active FROM categories WHERE name = '示例菜品'`
  );
  const categoryId = category.rows[0]?.id;
  if (!categoryId || !category.rows[0].active) return;
  const dishes = [
    ["示例套餐", "shilitaocan", 3800, 1600],
    ["清炒时蔬", "qingchaoshishu", 1800, 600],
    ["米饭", "mifan", 300, 80]
  ];
  for (const [name, pinyin, price, cost] of dishes) {
    await pool.query(
      `INSERT INTO dishes (category_id, name, pinyin, price_fen, cost_fen)
       SELECT $1, $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM dishes WHERE name = $2)`,
      [categoryId, name, pinyin, price, cost]
    );
  }
}
