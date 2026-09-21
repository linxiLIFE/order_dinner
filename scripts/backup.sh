#!/usr/bin/env bash
set -euo pipefail
umask 077

script_root="$(cd "$(dirname "$0")/.." && pwd)"
project_root="${ORDER_DINNER_ROOT:-$script_root}"
cd "$project_root"
backup_dir="$project_root/backups"
if [[ ! -w "$backup_dir" ]]; then
  sudo install -d -m 0750 -o "$(id -un)" -g "$(id -gn)" "$backup_dir"
fi
backup_file="$backup_dir/order-dinner-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
sudo docker compose --project-directory "$project_root" --env-file "$project_root/.env" -f "$script_root/docker-compose.yml" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip > "$backup_file"
chmod 600 "$backup_file"
echo "已生成数据库备份：$backup_file"

retention_days="${BACKUP_RETENTION_DAYS:-30}"
if [[ ! "$retention_days" =~ ^[1-9][0-9]*$ ]]; then
  echo "BACKUP_RETENTION_DAYS 必须是正整数" >&2
  exit 1
fi
trash_root="${XDG_DATA_HOME:-$HOME/.local/share}/Trash"
trash_files="$trash_root/files"
trash_info="$trash_root/info"
mkdir -p "$trash_files" "$trash_info"
chmod 700 "$trash_root" "$trash_files" "$trash_info"

move_to_trash() {
  local source="$1"
  local trash_name
  trash_name="$(basename "$source")"
  if [[ -e "$trash_files/$trash_name" ]]; then
    trash_name="${trash_name}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  fi
  mv "$source" "$trash_files/$trash_name"
  chmod 600 "$trash_files/$trash_name"
  printf '[Trash Info]\nPath=%s\nDeletionDate=%s\n' \
    "$source" "$(date +%Y-%m-%dT%H:%M:%S)" > "$trash_info/$trash_name.trashinfo"
}

log_file="$backup_dir/backup.log"
if [[ -f "$log_file" ]] && (( $(wc -c < "$log_file") > 5242880 )); then
  move_to_trash "$log_file"
fi

while IFS= read -r -d '' old_backup; do
  move_to_trash "$old_backup"
done < <(find "$backup_dir" -maxdepth 1 -type f -name 'order-dinner-*.sql.gz' -mtime "+$retention_days" -print0)
