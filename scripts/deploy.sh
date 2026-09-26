#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"
ssh_key="${SSH_KEY:-/Users/linxi/Downloads/edge/tencloud.pem}"
ssh_user="${SSH_USER:-ubuntu}"
ssh_host="${SSH_HOST:-43.142.138.108}"
remote_root="/opt/order-dinner"
public_host="43.142.138.108"
public_port="1316"
release_version="$(node -p 'require("./package.json").version')"
[[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本号格式不正确" >&2; exit 1; }
[[ -f updates/latest.json && -d "updates/$release_version" ]] || { echo "缺少当前版本更新文件" >&2; exit 1; }
manifest_version="$(node -p 'require("./updates/latest.json").version')"
[[ "$manifest_version" == "$release_version" ]] || { echo "更新清单与项目版本不一致" >&2; exit 1; }
ssh_args=(-o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o IdentitiesOnly=yes -o ConnectTimeout=20 -i "$ssh_key")
scp_args=(-o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o IdentitiesOnly=yes -o ConnectTimeout=20 -i "$ssh_key")

./scripts/generate-live-env.sh
source .deploy/order-dinner.env

echo "上传项目到 $ssh_user@$ssh_host:$remote_root"
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
remote_release="$remote_root/.deploy/releases/$release_id"
remote_group="$(ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "id -gn '$ssh_user'")"
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "sudo install -d -m 0750 -o '$ssh_user' -g '$remote_group' '$remote_root' '$remote_root/.deploy' '$remote_root/.deploy/releases' '$remote_release' '$remote_root/backups' && sudo chown '$ssh_user':'$remote_group' '$remote_root'"
COPYFILE_DISABLE=1 tar \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./release' \
  --exclude='./.deploy' \
  --exclude='./web/dist' \
  --exclude='./server/dist' \
  --exclude='*.log' \
  --exclude='./android' \
  --exclude='./ios' \
  --exclude='./data' \
  --exclude='./backups' \
  --exclude='./updates' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  -czf - . | ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "tar -xzf - -C '$remote_release'"
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "mkdir -p '$remote_release/updates'"
COPYFILE_DISABLE=1 tar -C updates -czf - latest.json "$release_version" | ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "tar -xzf - -C '$remote_release/updates'"
if ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "test -f '$remote_root/.env'"; then
  echo "远端已有 .env，保留现有数据库与登录凭据"
else
  scp "${scp_args[@]}" .deploy/order-dinner.env "$ssh_user@$ssh_host:$remote_root/.env"
fi
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "chmod 600 '$remote_root/.env'"

echo "检查现有数据库并按需备份"
remote_db_check='set -euo pipefail; sudo docker info >/dev/null; names="$(sudo docker container ls --all --format "{{.Names}}")"; if printf "%s\n" "$names" | grep -Fxq "order-dinner-db"; then sudo docker inspect -f "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" order-dinner-db; else printf "%s\n" "__NO_ORDER_DINNER_DB__"; fi'
if ! db_state="$(ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "$remote_db_check")"; then
  echo "无法可靠检查远端 Docker/数据库状态，为保护数据已中止部署" >&2
  exit 1
fi
if [[ "$db_state" == "__NO_ORDER_DINNER_DB__" ]]; then
  echo "首次部署：未发现数据库容器，跳过备份"
elif [[ "$db_state" != "running|healthy" ]]; then
  echo "数据库容器状态异常（$db_state），为保护数据已中止部署" >&2
  exit 1
else
  echo "数据库健康，开始部署前备份"
  ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "ORDER_DINNER_ROOT='$remote_root' '$remote_release/scripts/backup.sh'"
fi

echo "启动数据库与应用容器"
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "sudo docker network inspect love-web_love-network >/dev/null && sudo env ORDER_DINNER_BUILD_CONTEXT='$remote_release' docker compose --project-directory '$remote_root' --env-file '$remote_root/.env' -f '$remote_release/docker-compose.yml' up -d --build"

echo "备份并增加 Caddy 路由"
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" 'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail
caddyfile=/opt/love-web/Caddyfile
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/opt/love-web/Caddyfile.before-order-dinner-$stamp"
sudo cp -a "$caddyfile" "$backup"
if ! sudo grep -q 'https://43\.142\.138\.108:1316' "$caddyfile"; then
  sudo tee -a "$caddyfile" >/dev/null <<'CADDY_BLOCK'

https://43.142.138.108:1316 {
  import common_security
  reverse_proxy order-dinner-app:3000
}
CADDY_BLOCK
fi
sudo docker restart love-caddy
if ! sudo docker exec love-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; then
  sudo cp -a "$backup" "$caddyfile"
  sudo docker restart love-caddy
  echo "Caddy 配置校验失败，已恢复备份并重启：$backup" >&2
  exit 1
fi
echo "Caddy 备份：$backup"
REMOTE_SCRIPT

echo "安装每日备份任务"
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "sudo tee /etc/cron.d/order-dinner-backup >/dev/null" <<CRON
0 3 * * * $ssh_user ORDER_DINNER_ROOT=$remote_root $remote_release/scripts/backup.sh >> $remote_root/backups/backup.log 2>&1
CRON
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "sudo chmod 644 /etc/cron.d/order-dinner-backup && sudo touch '$remote_root/backups/backup.log' && sudo chown '$ssh_user':'$remote_group' '$remote_root' '$remote_root/backups' '$remote_root/backups/backup.log' && sudo chmod 600 '$remote_root/backups/backup.log'"

echo "线上健康检查"
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "curl --fail --silent --show-error --resolve '$public_host:$public_port:127.0.0.1' 'https://$public_host:$public_port/healthz'"
echo
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "CURRENT_RELEASE='$remote_release' REMOTE_ROOT='$remote_root' bash -s" <<'REMOTE_CLEANUP'
set -euo pipefail
mounted_updates="$(sudo docker inspect -f '{{range .Mounts}}{{println .Source}}{{end}}' order-dinner-app)"
printf '%s\n' "$mounted_updates" | grep -Fxq "$CURRENT_RELEASE/updates"
grep -Fq "$CURRENT_RELEASE/scripts/backup.sh" /etc/cron.d/order-dinner-backup
trash_root="${XDG_DATA_HOME:-$HOME/.local/share}/Trash"
mkdir -p "$trash_root/files" "$trash_root/info"
chmod 700 "$trash_root" "$trash_root/files" "$trash_root/info"
for old_release in "$REMOTE_ROOT/.deploy/releases"/*; do
  [[ -d "$old_release" && "$old_release" != "$CURRENT_RELEASE" ]] || continue
  trash_name="order-dinner-release-$(basename "$old_release")"
  if [[ -e "$trash_root/files/$trash_name" ]]; then
    trash_name="$trash_name-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  fi
  mv "$old_release" "$trash_root/files/$trash_name"
  printf '[Trash Info]\nPath=%s\nDeletionDate=%s\n' "$old_release" "$(date +%Y-%m-%dT%H:%M:%S)" > "$trash_root/info/$trash_name.trashinfo"
done
REMOTE_CLEANUP
echo "部署完成：https://$public_host:$public_port"
