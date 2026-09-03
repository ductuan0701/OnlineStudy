# System Runbook - Online Study Project

Tài liệu này chứa các quy trình xử lý sự cố (Runbook) cho các cảnh báo từ hệ thống giám sát Grafana/Prometheus. Khi một Alert được kích hoạt, kỹ sư hệ thống cần làm theo các bước tương ứng dưới đây.

---

## 1. Cảnh báo: High CPU Usage (CPU Backend quá cao)
**Mô tả:** CPU của container `backend-blue` hoặc `backend-green` vượt mức 80% trong hơn 5 phút.
**Mức độ:** Cảnh cáo (Warning) / Nghiêm trọng (Critical)

### Các bước xử lý:
1. **Kiểm tra đồ thị chi tiết trên Grafana:**
   - Xem bảng `CPU Usage` trong Dashboard để xác định thời điểm bắt đầu tăng.
   - Kiểm tra xem lượng traffic (Request/sec) có tăng đột biến cùng lúc không.
2. **Kiểm tra Logs hệ thống:**
   - Đăng nhập VPS và chạy lệnh: `docker logs --tail 200 online-study-backend-blue`
   - Tìm kiếm các vòng lặp vô hạn (infinite loops), deadlock hoặc các tác vụ nặng đang chạy (như xuất báo cáo, xử lý video).
3. **Hành động khắc phục:**
   - Nếu do lưu lượng truy cập thật (Spike traffic): Cân nhắc tăng tài nguyên (Scale up) cho VPS.
   - Nếu do lỗi code (vòng lặp vô tận): Báo cho team Dev, nếu cần thiết thì rollback bản code trước đó:
     `docker-compose -f docker-compose.prod.yml stop backend-blue && docker-compose -f docker-compose.prod.yml up -d backend-green`

---

## 2. Cảnh báo: High Memory/Heap Usage (Tràn RAM)
**Mô tả:** Java Heap Memory của Backend vượt mức 85%. Có nguy cơ xảy ra lỗi `OutOfMemoryError`.
**Mức độ:** Nghiêm trọng (Critical)

### Các bước xử lý:
1. **Theo dõi Garbage Collection (GC):**
   - Trên Grafana, kiểm tra biểu đồ `JVM Statistics - Memory` xem đường Non-Heap và Heap có liên tục đi lên mà không giảm xuống sau các nhịp GC hay không (dấu hiệu rò rỉ bộ nhớ - Memory Leak).
2. **Hành động khắc phục tức thời:**
   - Restart lại container bị lỗi để giải phóng RAM ngay lập tức, đảm bảo người dùng không bị gián đoạn:
     `docker restart online-study-backend-blue`
3. **Phân tích nguyên nhân:**
   - Xem log xem có endpoint nào đang tải quá nhiều dữ liệu vào RAM (ví dụ: query Select * toàn bộ DB mà không phân trang).

---

## 3. Cảnh báo: High Error Rate (Nhiều lỗi 5xx)
**Mô tả:** Tỉ lệ request trả về mã lỗi 500 (Internal Server Error) vượt quá 5% tổng request.
**Mức độ:** Rất nghiêm trọng (Page)

### Các bước xử lý:
1. **[TỰ ĐỘNG] Smart Rollback Orchestrator:**
   - Hệ thống Grafana sẽ tự động bắn Webhook về endpoint `/alert-runbook`.
   - Webhook Agent sẽ tự động **đánh thức (start)** phiên bản dự phòng (Blue/Green) đang ngủ đông, sau đó chuyển hướng traffic (Failover) về phiên bản này ngay lập tức để cứu hệ thống (Thời gian gián đoạn < 1 giây).
2. **Kiểm tra sau sự cố (Post-mortem):**
   - Kiểm tra log Backend của container bị lỗi để tìm nguyên nhân (thường là NullPointerException hoặc mất kết nối DB).
   - Kiểm tra lịch sử tự động Rollback tại: `https://deploydb.hoclaptrinh.top/history`
3. **Can thiệp thủ công (Nếu Auto-rollback thất bại):**
   - Chạy lệnh đổi luồng thủ công trên VPS:
     `./scripts/proxy_manager.sh backend_service online-study-backend-[blue/green]:8080`

---
*Runbook này được tự động liên kết từ Grafana Alerts thông qua trường Annotation: Runbook URL.*
