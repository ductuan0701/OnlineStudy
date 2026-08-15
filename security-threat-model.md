# Báo Cáo Bảo Mật Webhook Agent (DevSecOps)

## Lập Threat Model (Mô Hình Mối Đe Dọa)
Đây là tài liệu phân tích rủi ro hệ thống tự động triển khai (Webhook Agent):

*   **Tài sản (Assets):** Mã nguồn ứng dụng, Thông tin Database, Quyền kiểm soát Docker Daemon (thông qua Docker Socket), và Cấu hình Nginx Proxy.
*   **Trust Boundary (Ranh giới tin cậy):** Nằm tại Lớp WAF (Cloudflare) và hàm kiểm tra chữ ký `HMAC-SHA256` trên Webhook Agent. Mọi luồng dữ liệu từ Internet đi vào cổng `9000` đều là Untrusted (Không tin cậy) cho đến khi chữ ký được xác minh.
*   **Entry Point (Điểm xâm nhập):** Giao thức HTTP POST tại Endpoint `/webhook` mở ra Internet.
*   **Hành động Docker được phép (Allowed Actions):** Agent chỉ có quyền thực thi các hành động giới hạn: `compose pull`, `compose up -d`, `stop`, và `system prune`. Không được phép thao tác (rm/exec) vào các container không thuộc dự án.
*   **Blast Radius (Bán kính sát thương):** Nếu Agent bị thỏa hiệp, Hacker có thể truy cập Docker Socket và giành quyền Root trên Host. Để thu hẹp Blast Radius, hệ thống đã áp dụng Docker Socket Proxy (Giới hạn API qua cổng 2375) và Container Hardening (Tước quyền Root, cấm tạo tiến trình mới).
