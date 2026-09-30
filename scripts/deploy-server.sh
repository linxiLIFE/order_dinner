#!/usr/bin/env bash
# Server/web only: reuse published client packages; preserve all previous releases.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
release_id="$(date -u +%Y%m%dT%H%M%SZ)-ai-$$"
remote_release="/opt/order-dinner/.deploy/releases/$release_id"
ssh tencloud "install -d -m 750 '$remote_release'"
COPYFILE_DISABLE=1 tar --exclude='./.git' --exclude='./node_modules' --exclude='./.deploy' --exclude='./web/dist' --exclude='./server/dist' --exclude='./updates' --exclude='./release' --exclude='./data' --exclude='./backups' --exclude='./android' --exclude='./ios' --exclude='./.env' --exclude='./.env.*' --exclude='[Aa][Pp][Ii][Kk][Ee][Yy].md' -czf - . | ssh tencloud "tar -xzf - -C '$remote_release'"
ssh tencloud "install -d -m 750 '$remote_release/image'"
COPYFILE_DISABLE=1 tar -czf - web/dist server/dist package.json test | ssh tencloud "tar -xzf - -C '$remote_release/image'"
ssh tencloud "CANDIDATE='$remote_release' bash -s" <<'REMOTE'
set -euo pipefail
root=/opt/order-dinner
old_config=$(sudo docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' order-dinner-app)
old_updates=$(sudo docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/updates"}}{{.Source}}{{end}}{{end}}' order-dinner-app)
[[ "$old_updates" == "$root"/* && -f "$old_updates/latest.json" && -f "$old_config" ]]
ORDER_DINNER_ROOT="$root" "$CANDIDATE/scripts/backup.sh" </dev/null
rollback="order-dinner:before-$(basename "$CANDIDATE")"
sudo docker tag order-dinner:local "$rollback"
printf 'previous_config=%s\nprevious_updates=%s\nrollback_image=%s\n' "$old_config" "$old_updates" "$rollback" > "$CANDIDATE/rollback.txt"
# Use the validated local build with the existing server runtime dependencies.
sudo docker build -f "$CANDIDATE/Dockerfile.server" -t order-dinner:ai-candidate "$CANDIDATE/image"
# All regression data lives in a separate test database, never the business database.
sudo docker exec -i order-dinner-app node --input-type=module - <<'NODE'
import pg from 'pg';
const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
if(!(await client.query("SELECT 1 FROM pg_database WHERE datname='order_dinner_test_ai'")).rowCount)await client.query('CREATE DATABASE order_dinner_test_ai');
await client.end();
NODE
sudo docker run --rm -i --network container:order-dinner-db --env-file "$root/.env" --entrypoint node order-dinner:ai-candidate --input-type=module - <<'NODE'
import {spawnSync} from 'node:child_process';
const url=new URL(process.env.DATABASE_URL || `postgres://${process.env.POSTGRES_USER || 'order_dinner'}:${process.env.POSTGRES_PASSWORD}@db:5432/order_dinner`);
url.hostname='127.0.0.1';url.pathname='/order_dinner_test_ai';
// Integration guard requires localhost: use the DB container network namespace instead.
const r=spawnSync(process.execPath,['--test','/app/test/integration.test.mjs'],{stdio:'inherit',env:{...process.env,ORDER_DINNER_TEST_DATABASE_URL:url.toString(),DEEPSEEK_API_KEY:''}});
process.exit(r.status ?? 1);
NODE
sudo docker tag order-dinner:ai-candidate order-dinner:local
sudo env ORDER_DINNER_BUILD_CONTEXT="$CANDIDATE" ORDER_DINNER_UPDATES_PATH="$old_updates" docker compose --project-directory "$root" --env-file "$root/.env" -f "$CANDIDATE/docker-compose.yml" up -d --no-build app
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error https://43.142.138.108:1316/healthz; then
    printf '\nServer release: %s\n' "$CANDIDATE"
    exit 0
  fi
  sleep 2
done
sudo docker tag "$rollback" order-dinner:local
sudo env ORDER_DINNER_BUILD_CONTEXT="$(dirname "$old_config")" ORDER_DINNER_UPDATES_PATH="$old_updates" docker compose --project-directory "$root" --env-file "$root/.env" -f "$old_config" up -d --no-build app
printf 'Health check failed; previous application restored.\n' >&2
exit 1
REMOTE
