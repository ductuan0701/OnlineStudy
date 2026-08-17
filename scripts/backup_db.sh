#!/bin/bash
# Script sao lưu Database dự phòng cho Rollback-safe/Forward-only migrations
DB_CONTAINER="online-study-db"
DB_USER="root"
DB_PASS="online-study"
DB_NAME="online-study-db"
BACKUP_DIR="/root/online-study/backups"

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.sql"

echo "[Backup DB] Đang tiến hành sao lưu cơ sở dữ liệu..."
docker exec "$DB_CONTAINER" /usr/bin/mysqldump -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" > "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    echo "[Backup DB] Sao lưu thành công: $BACKUP_FILE"
else
    echo "[Backup DB] Sao lưu thất bại!"
    exit 1
fi