#!/bin/bash

# proxy_manager.sh
# Usage: ./proxy_manager.sh <UPSTREAM_NAME> <NEW_SERVER:PORT>
# Example: ./proxy_manager.sh backend_service backend-green:8080

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <UPSTREAM_NAME> <NEW_SERVER:PORT>"
    echo "Example: $0 backend_service backend-green:8080"
    exit 1
fi

UPSTREAM_NAME=$1
NEW_SERVER=$2
UPSTREAMS_FILE="./nginx/upstreams.conf"
CONTAINER_NAME="online-study-nginx"

echo "Proxy Manager: Bắt đầu chuyển hướng upstream '$UPSTREAM_NAME' sang '$NEW_SERVER'"

# 1. Kiểm tra file cấu hình
if [ ! -f "$UPSTREAMS_FILE" ]; then
    echo "LỖI: Không tìm thấy file $UPSTREAMS_FILE!"
    exit 1
fi

# 2. Tạo bản backup
cp "$UPSTREAMS_FILE" "${UPSTREAMS_FILE}.bak"
echo "- Đã backup cấu hình hiện tại ra ${UPSTREAMS_FILE}.bak"

# 3. Thay đổi thông tin server bằng awk
awk -v upstream="$UPSTREAM_NAME" -v new_server="$NEW_SERVER" '
$1 == "upstream" && $2 == upstream "{" { in_block=1; print; next }
$1 == "upstream" && $2 == upstream { in_block=1; print; next }
in_block && $1 == "server" { print "    server " new_server ";"; in_block=0; next }
{ print }
' "$UPSTREAMS_FILE.bak" > "$UPSTREAMS_FILE"

echo "- Đã cập nhật file upstreams.conf:"
grep -A 2 "upstream $UPSTREAM_NAME" "$UPSTREAMS_FILE"

# 4. Kiểm tra cấu hình Nginx (Nginx Test)
echo "- Đang kiểm tra cấu hình mới..."
TEST_RESULT=$(docker exec "$CONTAINER_NAME" nginx -t 2>&1)

if echo "$TEST_RESULT" | grep -q "syntax is ok"; then
    echo "- Cấu hình hợp lệ. Đang tiến hành reload Nginx (Graceful Reload)..."
    # 5. Thực hiện Graceful Reload
    docker exec "$CONTAINER_NAME" nginx -s reload
    echo "=> HOÀN TẤT! Đã chuyển traffic sang $NEW_SERVER mà không bị gián đoạn (Zero-Downtime)."
else
    echo "LỖI: Cấu hình không hợp lệ!"
    echo "$TEST_RESULT"
    echo "- Đang khôi phục lại cấu hình gốc..."
    cp "${UPSTREAMS_FILE}.bak" "$UPSTREAMS_FILE"
    echo "=> Đã khôi phục an toàn. Quá trình deploy thất bại, hệ thống vẫn giữ nguyên phiên bản cũ."
    exit 1
fi
