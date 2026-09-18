#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"
mkdir -p backups
backup_file="backups/order-dinner-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
sudo docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > "$backup_file"
chmod 600 "$backup_file"
echo "已生成数据库备份：$backup_file"
