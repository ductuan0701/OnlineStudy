# Kiểm thử Hiệu năng quá trình Chuyển giao (Deploy Load Test)

Kịch bản này sử dụng công cụ k6 để giả lập tải nền, nhằm chứng minh hệ thống đạt **near-zero deploy-time downtime**.

## 1. Môi trường Test (Topology)
- **Công cụ:** k6 (https://k6.io)
- **Mục tiêu (Target):** Máy chủ Nginx (https://api.hoclaptrinh.top)
- **Đồng bộ thời gian:** Giao thức NTP được áp dụng để đồng bộ thời gian giữa Load Generator và VPS.
- **Kịch bản:** 
  - 50 VU (Virtual Users) bắn request HTTP GET liên tục với kết nối Keep-alive.
  - Phút thứ 1: Kích hoạt Webhook deploy.
  - Theo dõi tỷ lệ rớt mạng (Dropped requests) và tốc độ phản hồi (P50, P99).

## 2. Cách chạy (Tái tạo Minh chứng)
Dành cho người kiểm duyệt muốn chạy lại bài test:

1. Cài đặt k6 (`brew install k6` trên Mac hoặc làm theo hướng dẫn tại k6.io).
2. Di chuyển vào thư mục này:
   ```bash
   cd tests/load_test
   ```
3. Chạy kịch bản và xuất báo cáo thô ra file JSON:
   ```bash
   k6 run --out json=results/raw_result_1.json k6_deploy_test.js
   ```

## 3. Ngưỡng Đạt / Không đạt (SLOs)
Bài kiểm thử chỉ được đánh giá là thành công (PASS) nếu thỏa mãn toàn bộ các điều kiện sau trong suốt quá trình hệ thống chuyển giao (Switch) từ Blue sang Green:
- `http_req_failed`: Dưới 1%.
- `http_req_duration (P99)`: 99% request phải phản hồi dưới 500ms.
