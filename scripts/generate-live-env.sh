#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
env_dir="$project_root/.deploy"
env_file="$env_dir/order-dinner.env"
mkdir -p "$env_dir"
chmod 700 "$env_dir"
if [[ -e "$env_file" ]]; then
  echo "已存在 ${env_file}，不覆盖现有凭据。"
  exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "需要 openssl 生成部署密钥。" >&2
  exit 1
fi
postgres_password="$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-28)"
jwt_secret="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-64)"
admin_password="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | cut -c1-18)"
umask 077
{
  echo "NODE_ENV=production"
  echo "PORT=3000"
  echo "POSTGRES_DB=order_dinner"
  echo "POSTGRES_USER=order_dinner"
  echo "POSTGRES_PASSWORD=$postgres_password"
  echo "DATABASE_URL=postgres://order_dinner:$postgres_password@db:5432/order_dinner"
  echo "JWT_SECRET=$jwt_secret"
  echo "BOOTSTRAP_ADMIN_USERNAME=admin"
  echo "BOOTSTRAP_ADMIN_PASSWORD=$admin_password"
  echo "PRINT_DEVICE_NAME=未配置打印设备"
  echo "PUBLIC_APP_URL=https://43.142.138.108:1316"
  echo "SEED_DEMO_DATA=false"
} > "$env_file"
echo "已生成 $env_file"
echo "管理员账号：admin"
echo "管理员初始密码：$admin_password"
echo "请把上述密码保存在安全位置；部署后不要把该文件提交到 Git。"
