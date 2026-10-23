// Run inside the application container. Defaults to a read-only preview.
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const apply = process.argv.includes('--apply');
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('LOCK TABLE customers IN SHARE ROW EXCLUSIVE MODE');
  const invalid = await client.query(`SELECT count(*)::int AS n FROM customers
    WHERE phone IS NOT NULL AND (length(regexp_replace(phone,'[^0-9]','','g')) < 4)`);
  if (invalid.rows[0].n) throw new Error(`存在 ${invalid.rows[0].n} 条不足4位的顾客手机号，未修改`);
  const conflicts = await client.query(`SELECT count(*)::int AS n FROM (
    SELECT right(regexp_replace(phone,'[^0-9]','','g'),4) FROM customers WHERE phone IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1) duplicates`);
  if (conflicts.rows[0].n) throw new Error(`存在 ${conflicts.rows[0].n} 组重复尾号，未合并或修改顾客`);
  const before = await client.query(`SELECT count(*)::int AS customers,
    count(*) FILTER (WHERE length(phone)>4)::int AS full_numbers,
    COALESCE(sum(points_balance),0)::text AS total_points FROM customers`);
  let changed = 0;
  if (apply) {
    await client.query(`CREATE TEMP TABLE customer_tail_snapshot ON COMMIT DROP AS SELECT * FROM customers`);
    const updated = await client.query(`UPDATE customers SET phone=right(regexp_replace(phone,'[^0-9]','','g'),4)
      WHERE phone IS NOT NULL AND phone IS DISTINCT FROM right(regexp_replace(phone,'[^0-9]','','g'),4)`);
    changed = updated.rowCount;
    const check = await client.query(`SELECT count(*)::int AS n FROM customer_tail_snapshot b
      FULL JOIN customers c USING(id) WHERE b.id IS NULL OR c.id IS NULL
      OR (to_jsonb(b)-'phone') IS DISTINCT FROM (to_jsonb(c)-'phone')`);
    if (check.rows[0].n) throw new Error('顾客关联或非手机字段发生变化，已回滚');
  }
  const after = await client.query(`SELECT count(*)::int AS customers,
    count(*) FILTER (WHERE length(phone)>4)::int AS full_numbers,
    COALESCE(sum(points_balance),0)::text AS total_points FROM customers`);
  await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'preview', before: before.rows[0], changed, after: after.rows[0], other_customer_fields_unchanged: true }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { await client.end(); }
