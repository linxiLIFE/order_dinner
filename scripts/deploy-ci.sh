#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${SSH_KEY:?缺少 SSH_KEY}" "${SSH_HOST:?缺少 SSH_HOST}" "${SSH_USER:?缺少 SSH_USER}"
: "${GITHUB_RUN_ID:?缺少 GITHUB_RUN_ID}" "${GITHUB_RUN_ATTEMPT:?缺少 GITHUB_RUN_ATTEMPT}"
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
root=/opt/order-dinner
candidate="$root/.deploy/releases/ci-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
version="$(node -p 'require("./package.json").version')"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
ssh_args=(-o BatchMode=yes -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -i "$SSH_KEY")
target="$SSH_USER@$SSH_HOST"
ssh "${ssh_args[@]}" "$target" "test -f '$root/.env' && test ! -e '$candidate' && install -d -m 750 '$candidate'"
tar -czf - Dockerfile.ci docker-compose.yml scripts/backup.sh package.json package-lock.json server/dist web/dist updates/latest.json release.json \
  | ssh "${ssh_args[@]}" "$target" "tar -xzf - -C '$candidate'"
# Use separate TCP connections for chunks: a single cross-border connection is
# too slow for the ~90 MB Windows installer. Every byte is verified before use.
transfer_dir=".deploy/ci-transfer/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
mkdir -p "$transfer_dir/parts"
bundle="$transfer_dir/installers.tar.gz"
tar -czf "$bundle" "updates/$version"
bundle_sha="$(sha256sum "$bundle" | cut -d ' ' -f 1)"
split -b 3145728 -d -a 3 "$bundle" "$transfer_dir/parts/part-"
ssh "${ssh_args[@]}" "$target" "install -d -m 750 '$candidate/.transfer'"
pids=()
wait_transfers() {
  local failed=false pid
  for pid in "${pids[@]}"; do
    wait "$pid" || failed=true
  done
  pids=()
  [[ "$failed" == false ]]
}
for part in "$transfer_dir/parts"/part-*; do
  (
    for attempt in 1 2 3; do
      if scp "${ssh_args[@]}" "$part" "$target:$candidate/.transfer/"; then exit 0; fi
      sleep 2
    done
    exit 1
  ) &
  pids+=("$!")
  # Stagger handshakes to avoid sshd's unauthenticated-connection limit.
  sleep 0.2
  if (( ${#pids[@]} >= 16 )); then wait_transfers; fi
done
wait_transfers
ssh "${ssh_args[@]}" "$target" "CANDIDATE='$candidate' BUNDLE_SHA='$bundle_sha' bash -s" <<'REMOTE_UNPACK'
set -euo pipefail
cd "$CANDIDATE"
actual_sha="$(cat .transfer/part-* | sha256sum | cut -d ' ' -f 1)"
[[ "$actual_sha" == "$BUNDLE_SHA" ]] || { echo '安装包分块校验失败' >&2; exit 1; }
cat .transfer/part-* | tar -xzf -
trash_root="${XDG_DATA_HOME:-$HOME/.local/share}/Trash"
sudo install -d -m 700 "$trash_root" "$trash_root/files" "$trash_root/info"
name="order-dinner-transfer-$(basename "$CANDIDATE")-$$"
sudo mv "$CANDIDATE/.transfer" "$trash_root/files/$name"
printf '[Trash Info]\nPath=%s\nDeletionDate=%s\n' "$CANDIDATE/.transfer" "$(date +%Y-%m-%dT%H:%M:%S)" \
  | sudo tee "$trash_root/info/$name.trashinfo" >/dev/null
echo '安装包分块传输与完整哈希校验通过'
REMOTE_UNPACK
ssh "${ssh_args[@]}" "$target" "CANDIDATE='$candidate' bash -s" <<'REMOTE'
set -euo pipefail
root=/opt/order-dinner
exec 9> "$root/.deploy/ci-deploy.lock"
flock -w 600 9
old_updates=$(sudo docker inspect -f '{{range .Mounts}}{{if eq .Destination "/app/updates"}}{{.Source}}{{end}}{{end}}' order-dinner-app)
[[ "$old_updates" == "$root/.deploy/releases/"* && -f "$old_updates/latest.json" ]]
# Refuse stale/repeated releases before touching the running application.
python3 - "$CANDIDATE/updates/latest.json" "$old_updates/latest.json" <<'PY'
import json, re, sys
def version_code(filename):
    value = json.load(open(filename))['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', value): raise ValueError('Invalid version')
    major, minor, patch = map(int, value.split('.'))
    return major * 1_000_000 + minor * 1_000 + patch
if version_code(sys.argv[1]) <= version_code(sys.argv[2]):
    raise ValueError('拒绝发布旧版本或重复版本')
PY
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
python3 - "$CANDIDATE" <<'PY_VERIFY'
import hashlib, json, pathlib, re, subprocess, sys, urllib.parse
root = pathlib.Path(sys.argv[1])
base = 'https://43.142.138.108:1316'
def command(path):
    url = urllib.parse.urljoin(base + '/', path)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != '43.142.138.108:1316':
        raise ValueError('Unexpected public artifact origin')
    return ['curl', '--fail', '--silent', '--show-error', '--max-time', '120',
            '--resolve', '43.142.138.108:1316:127.0.0.1', url]
def get(path):
    return subprocess.check_output(command(path))
def remote_digest(path):
    with subprocess.Popen(command(path), stdout=subprocess.PIPE) as process:
        digest = hashlib.sha256()
        while True:
            block = process.stdout.read(1024 * 1024)
            if not block: break
            digest.update(block)
        if process.wait() != 0: raise RuntimeError('HTTPS download failed')
        return digest.hexdigest()
expected = json.loads((root / 'updates/latest.json').read_text())
if json.loads(get('/updates/latest.json')) != expected:
    raise ValueError('线上更新清单不一致')
for platform in ('android', 'windows'):
    if remote_digest(expected[platform]['url']) != expected[platform]['sha256']:
        raise ValueError(f'{platform} 线上安装包哈希不一致')
index = (root / 'web/dist/index.html').read_bytes()
if get('/') != index: raise ValueError('线上网页不一致')
for asset in re.findall(r'(?:src|href)="(/assets/[^"?#]+)"', index.decode()):
    if remote_digest(asset) != hashlib.sha256((root / 'web/dist' / asset.lstrip('/')).read_bytes()).hexdigest():
        raise ValueError(f'线上资源哈希不一致：{asset}')
print(f"已验证 HTTPS 入口的网页、APK、EXE 与更新清单：{expected['version']}")
PY_VERIFY
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
