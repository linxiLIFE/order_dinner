#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SSH_KEY:?缺少 SSH_KEY}" "${SSH_HOST:?缺少 SSH_HOST}" "${SSH_USER:?缺少 SSH_USER}"
: "${GITHUB_RUN_ID:?缺少 GITHUB_RUN_ID}" "${GITHUB_RUN_ATTEMPT:?缺少 GITHUB_RUN_ATTEMPT}"
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
root=/opt/order-dinner
candidate="$root/.deploy/releases/ci-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
ssh_args=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -i "$SSH_KEY")
target="$SSH_USER@$SSH_HOST"
ssh "${ssh_args[@]}" "$target" "test -f '$root/.env' && test ! -e '$candidate' && install -d -m 750 '$candidate'"
tar -czf - Dockerfile.ci docker-compose.yml scripts/backup.sh package.json package-lock.json server/dist web/dist updates release.json \
  | ssh "${ssh_args[@]}" "$target" "tar -xzf - -C '$candidate'"
ssh "${ssh_args[@]}" "$target" "CANDIDATE='$candidate' bash -s" <<'REMOTE'
set -euo pipefail
root=/opt/order-dinner
exec 9> "$root/.deploy/ci-deploy.lock"
flock -w 600 9
old_updates=$(sudo docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/updates"}}{{.Source}}{{end}}{{end}}' order-dinner-app)
[[ "$old_updates" == "$root/.deploy/releases/"* && -f "$old_updates/latest.json" ]]
# Refuse stale/repeated releases before touching the running application.
sudo docker run --rm -i -v "$CANDIDATE/updates:/candidate:ro" -v "$old_updates:/published:ro" --entrypoint node node:22-bookworm-slim - <<'NODE'
const fs = require('fs');
const version = (directory) => JSON.parse(fs.readFileSync(`${directory}/latest.json`, 'utf8')).version;
const code = (value) => {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error('Invalid version');
  const [a,b,c] = value.split('.').map(Number); return a * 1_000_000 + b * 1_000 + c;
};
if (code(version('/candidate')) <= code(version('/published'))) throw new Error('拒绝发布旧版本或重复版本');
NODE
sudo docker build -f "$CANDIDATE/Dockerfile.ci" -t order-dinner:ci-candidate "$CANDIDATE"
# Deployment and daily backups share the same lock (the CI backup already holds it).
ORDER_DINNER_BACKUP_LOCK_HELD=1 ORDER_DINNER_ROOT="$root" bash "$CANDIDATE/scripts/backup.sh" </dev/null
sudo docker tag order-dinner:ci-candidate order-dinner:local
sudo env ORDER_DINNER_BUILD_CONTEXT="$CANDIDATE" ORDER_DINNER_DOCKERFILE=Dockerfile.ci \
  docker compose --project-directory "$root" --env-file "$root/.env" -f "$CANDIDATE/docker-compose.yml" up -d --no-build app
healthy=false
for attempt in $(seq 1 30); do
  if curl -fsS --resolve '43.142.138.108:1316:127.0.0.1' https://43.142.138.108:1316/healthz; then
    healthy=true; break
  fi
  sleep 2
done
if [[ "$healthy" != true ]]; then
  echo '线上健康检查失败，停止发布；按要求不自动恢复应用。' >&2
  exit 1
fi
# Verify actual public downloads and browser assets, not just HTTP 200.
sudo docker exec -i order-dinner-app node --input-type=module - <<'NODE'
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const base = 'https://43.142.138.108:1316';
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
async function get(path) {
  const response = await fetch(new URL(path, base), {signal:AbortSignal.timeout(120_000),cache:'no-store'});
  assert(response.ok, `HTTP ${response.status}: ${path}`);
  return Buffer.from(await response.arrayBuffer());
}
const expected = JSON.parse(fs.readFileSync('/app/updates/latest.json', 'utf8'));
assert.deepEqual(JSON.parse((await get('/updates/latest.json')).toString()), expected);
for (const platform of ['android','windows']) {
  assert.equal(digest(await get(expected[platform].url)), expected[platform].sha256);
}
const index = fs.readFileSync('/app/web/dist/index.html');
assert.equal(digest(await get('/')), digest(index));
for (const match of index.toString().matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) {
  assert.equal(digest(await get(match[1])), digest(fs.readFileSync(`/app/web/dist${match[1]}`)));
}
console.log(`已验证网页、APK、EXE 与更新清单：${expected.version}`);
NODE
# Point the daily backup at the current script before moving old releases.
sudo tee /etc/cron.d/order-dinner-backup >/dev/null <<CRON
0 3 * * * $(id -un) ORDER_DINNER_ROOT=$root bash $CANDIDATE/scripts/backup.sh >> $root/backups/backup.log 2>&1
CRON
sudo chmod 644 /etc/cron.d/order-dinner-backup
trash_root="${XDG_DATA_HOME:-$HOME/.local/share}/Trash"
sudo install -d -m 700 "$trash_root" "$trash_root/files" "$trash_root/info"
for old_release in "$root/.deploy/releases"/*; do
  [[ -d "$old_release" && "$old_release" != "$CANDIDATE" ]] || continue
  name="order-dinner-release-$(basename "$old_release")-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  sudo mv "$old_release" "$trash_root/files/$name"
  printf '[Trash Info]\nPath=%s\nDeletionDate=%s\n' "$old_release" "$(date +%Y-%m-%dT%H:%M:%S)" \
    | sudo tee "$trash_root/info/$name.trashinfo" >/dev/null
done
echo "发布完成：$CANDIDATE"
REMOTE
