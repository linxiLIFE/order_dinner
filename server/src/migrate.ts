import bcrypt from "bcryptjs";
import { pool } from "./db.js";

const schema = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('OWNER', 'CASHIER')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer NOT NULL UNIQUE CHECK (number > 0),
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

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid REFERENCES restaurant_tables(id),
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
  copy_no integer NOT NULL DEFAULT 1 CHECK (copy_no IN (1, 2)),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CLAIMED', 'SENT', 'FAILED', 'NEEDS_CHECK')),
  device_id text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS print_jobs_queue_idx ON print_jobs (status, created_at);

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
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, request_key)
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

  for (let number = 1; number <= 12; number += 1) {
    await pool.query(
      `INSERT INTO restaurant_tables (number, seats, sort_order)
       VALUES ($1, 4, $1)
       ON CONFLICT (number) DO NOTHING`,
      [number]
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

  if (process.env.SEED_DEMO_DATA === "true") {
    await seedDemoDishes();
  }
}

async function seedDemoDishes(): Promise<void> {
  const category = await pool.query<{ id: string }>(
    `INSERT INTO categories (name, sort_order) VALUES ('示例菜品', 10)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`
  );
  const categoryId = category.rows[0]?.id;
  if (!categoryId) return;
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
