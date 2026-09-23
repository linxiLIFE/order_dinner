-- One-time reset requested on 2026-09-23. Run only after a verified pg_dump backup
-- and while order-dinner-app is stopped. Keep catalog, tables, configuration,
-- employee accounts, printer pairing and migration history.
BEGIN;
SET LOCAL lock_timeout = '15s';
TRUNCATE TABLE
  banquet_deposit_ledger,
  banquet_reservations,
  points_ledger,
  print_jobs,
  settlements,
  order_items,
  order_batches,
  orders,
  customers,
  operation_logs,
  idempotency_keys;
UPDATE restaurant_tables
SET status = 'AVAILABLE', updated_at = now()
WHERE status = 'OCCUPIED';
COMMIT;
