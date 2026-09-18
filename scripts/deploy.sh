#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"
ssh_key="${SSH_KEY:-/Users/linxi/Downloads/google/astro-vm_key.pem}"
ssh_user="${SSH_USER:-azureuser}"
ssh_host="${SSH_HOST:-20.48.27.179}"
ssh_interface="${SSH_INTERFACE:-en0}"
remote_root="/opt/order-dinner"
public_host="dinner.20-48-27-179.sslip.io"
ssh_args=(-B "$ssh_interface" -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o IdentitiesOnly=yes -o ConnectTimeout=20 -i "$ssh_key")
scp_args=(-o BindInterface="$ssh_interface" -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o IdentitiesOnly=yes -o ConnectTimeout=20 -i "$ssh_key")

./scripts/generate-live-env.sh
source .deploy/order-dinner.env

archive="$(mktemp -t order-dinner-deploy).tar.gz"
COPYFILE_DISABLE=1 tar --exclude='./.git' --exclude='./node_modules' --exclude='./release' --exclude='./.deploy' --exclude='./android' --exclude='./ios' -czf "$archive" .

echo "上传项目到 $ssh_user@$ssh_host:$remote_root"
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "sudo mkdir -p '$remote_root' && sudo chown '$ssh_user':'$ssh_user' '$remote_root' && sudo find '$remote_root' -maxdepth 1 -mindepth 1 ! -name data ! -name backups -exec chown -R '$ssh_user':'$ssh_user' {} +"
remote_archive="/tmp/order-dinner-deploy-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
scp "${scp_args[@]}" "$archive" "$ssh_user@$ssh_host:$remote_archive"
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "tar -xzf '$remote_archive' -C '$remote_root'"
if ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "test -f '$remote_root/.env'"; then
  echo "远端已有 .env，保留现有数据库与登录凭据"
else
  scp "${scp_args[@]}" .deploy/order-dinner.env "$ssh_user@$ssh_host:$remote_root/.env"
fi
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "chmod 600 '$remote_root/.env'"

echo "启动数据库与应用容器"
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "cd '$remote_root' && sudo docker network inspect love-web_love-network >/dev/null && sudo docker compose --env-file .env up -d --build"

echo "备份并增加 Caddy 路由"
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" 'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail
caddyfile=/opt/love-web/Caddyfile
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/opt/love-web/Caddyfile.before-order-dinner-$stamp"
sudo cp -a "$caddyfile" "$backup"
if ! sudo grep -q 'dinner\.20-48-27-179\.sslip\.io:1314' "$caddyfile"; then
  sudo tee -a "$caddyfile" >/dev/null <<'CADDY_BLOCK'

https://dinner.20-48-27-179.sslip.io:1314 {
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
0 3 * * * $ssh_user cd $remote_root && $remote_root/scripts/backup.sh >> $remote_root/backups/backup.log 2>&1
CRON
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "sudo chmod 644 /etc/cron.d/order-dinner-backup && sudo chown '$ssh_user':'$ssh_user' '$remote_root' && sudo find '$remote_root' -maxdepth 1 -mindepth 1 ! -name data ! -name backups -exec chown -R '$ssh_user':'$ssh_user' {} +"

echo "线上健康检查"
ssh "${ssh_args[@]}" "$ssh_user@$ssh_host" "curl --fail --silent --show-error --resolve '$public_host:1314:127.0.0.1' 'https://$public_host:1314/healthz'"
echo
echo "部署完成：https://$public_host:1314"
