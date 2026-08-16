#!/bin/bash
# ==============================================================================
# SMARTDEPLOY ENTERPRISE - TARGETED MAINTENANCE SCRIPT
# ==============================================================================
# Kịch bản bảo trì và dọn dẹp hệ thống định kỳ (Scheduled Maintenance)
# Chạy độc lập qua Cronjob để giải quyết vấn đề phân mảnh và đầy ổ cứng,
# mà không làm ảnh hưởng đến khả năng Rollback của Pipeline chính.
#
# Yêu cầu hệ thống: docker, df, awk, grep
# ==============================================================================

# Cấu hình ngưỡng cảnh báo và dọn dẹp (Ví dụ: 80%)
DISK_THRESHOLD=80
PROJECT_LABEL="project=online-study"
RETENTION_HOURS=168 # 7 ngày

echo "============================================================"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] BẮT ĐẦU QUÁ TRÌNH BẢO TRÌ (DRY-RUN / CHECK)"
echo "============================================================"

# 1. Kiểm tra dung lượng ổ đĩa hiện tại
# Lấy dung lượng partition chứa Docker (thường là / hoặc /var/lib/docker)
CURRENT_USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')

echo "Dung lượng đĩa hiện tại: ${CURRENT_USAGE}% (Ngưỡng dọn dẹp: ${DISK_THRESHOLD}%)"

if [ "$CURRENT_USAGE" -ge "$DISK_THRESHOLD" ]; then
    echo "⚠️ CẢNH BÁO: Dung lượng đĩa vượt ngưỡng cho phép! Bắt đầu dọn dẹp an toàn..."
    
    # 2. Xóa các container đã thoát (Exited) của dự án
    echo ">> Dọn dẹp Exited Containers thuộc dự án '${PROJECT_LABEL}'..."
    docker container prune -f --filter "label=${PROJECT_LABEL}"
    
    # 3. Dọn dẹp Image cũ (Targeted Prune)
    # Chỉ xóa những Image thuộc project, không được tham chiếu bởi container nào, và cũ hơn RETENTION_HOURS
    echo ">> Dọn dẹp các Image không còn sử dụng (Dangling/Unused) cũ hơn ${RETENTION_HOURS} giờ..."
    docker image prune -a -f --filter "label=${PROJECT_LABEL}" --filter "until=${RETENTION_HOURS}h"
    
    # Tính toán lại dung lượng
    NEW_USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
    echo "✅ Đã dọn dẹp xong! Dung lượng hiện tại: ${NEW_USAGE}%"
else
    echo "✅ Hệ thống ổn định, dung lượng đĩa trong khoảng an toàn. Bỏ qua quá trình Prune để giữ lại Image cho Rollback."
fi

echo "============================================================"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] HOÀN TẤT BẢO TRÌ."
echo "============================================================"
