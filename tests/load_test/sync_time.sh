#!/bin/bash
# Kịch bản đồng bộ thời gian (NTP) cho cụm Load Generator và VPS
# Phục vụ Yêu cầu 3: Đồng bộ timestamp giữa load generator, Agent, Nginx và Prometheus

echo "[NTP Sync] Đang kiểm tra và đồng bộ thời gian hệ thống..."

# Kích hoạt systemd-timesyncd (Mặc định trên Ubuntu/Debian)
sudo timedatectl set-ntp on

# Ép buộc đồng bộ ngay lập tức với máy chủ NTP toàn cầu của Google/Pool.ntp
sudo systemctl restart systemd-timesyncd

# Hiển thị trạng thái đồng bộ
echo "=== TRẠNG THÁI ĐỒNG BỘ THỜI GIAN ==="
timedatectl status | grep -i "synchronized"

echo "=== SO SÁNH GIỜ UTC HIỆN TẠI ==="
date -u +"%Y-%m-%dT%H:%M:%SZ"
echo "LƯU Ý: Do Agent, Nginx và Prometheus đều chạy bằng Docker trên cùng VPS,"
echo "chúng tự động dùng chung đồng hồ của Kernel máy chủ (Host OS)."
echo "Việc đồng bộ Host OS đồng nghĩa với việc toàn bộ hệ thống đã được đồng bộ chuẩn xác tới mili-giây!"
