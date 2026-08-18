# Hướng dẫn Bảo mật & Rà soát Lộ lọt Thông tin (Incident Response)

Tài liệu này hướng dẫn bạn các bước cần làm NGAY LẬP TỨC để khắc phục sự cố lộ lọt thông tin (Mật khẩu DB, Momo Keys, Grafana, Webhook Token).

## BƯỚC 1: THU HỒI VÀ THAY ĐỔI TẤT CẢ SECRET (Khẩn cấp)

Do các mật khẩu đã từng nằm trong mã nguồn và có thể đã bị đánh cắp, bạn BẮT BUỘC phải đổi toàn bộ mật khẩu trên máy chủ thật

1. **Mật khẩu MySQL & Grafana**: 
   - Mở file `.env` trên máy chủ và đổi giá trị cho `MYSQL_ROOT_PASSWORD`, `MYSQL_APP_PASSWORD`, `GF_SECURITY_ADMIN_PASSWORD`.
   - Chạy lệnh `docker compose -f docker-compose.prod.yml down` rồi `docker compose -f docker-compose.prod.yml up -d` để áp dụng mật khẩu mới.
2. **MoMo API Keys**: 
   - Đăng nhập vào trang quản trị của MoMo (Momo Business/Partner Portal).
   - Yêu cầu cấp lại bộ khóa `Access Key` và `Secret Key` mới. Cập nhật chúng vào file `.env`.
3. **Webhook Token**: 
   - Đổi giá trị `WEBHOOK_TOKEN` trong `.env`.
   - Cập nhật lại đường dẫn Webhook trên GitHub Settings (thay token cũ bằng token mới ở đuôi `?token=...`).

## BƯỚC 2: KIỂM TRA LOG ĐỂ TÌM DẤU VẾT TRUY CẬP TRÁI PHÉP

Bạn cần xác định xem kẻ tấn công đã kịp sử dụng các secret bị lộ để truy cập vào hệ thống chưa.

**Kiểm tra log của Nginx (xem có truy cập bất thường vào DB hoặc Webhook không):**
```bash
docker logs online-study-nginx --tail 1000 | grep "webhook"
```

**Kiểm tra log của Database (xem có IP lạ đăng nhập không):**
```bash
docker logs online-study-db --tail 1000
```

**Kiểm tra log của Grafana:**
```bash
docker logs online-study-grafana --tail 1000
```

*Lưu ý: Nếu bạn có lưu trữ log ra file (ví dụ trong thư mục `/var/log/nginx/` trên host), hãy kiểm tra trực tiếp các file log đó theo mốc thời gian nghi ngờ lộ secret.*

## BƯỚC 3: XÓA SẠCH SECRET KHỎI LỊCH SỬ GIT VÀ IMAGE (Dọn dẹp)

Mặc dù chúng ta đã xóa secret ở commit mới nhất, nhưng chúng vẫn còn tồn tại trong lịch sử Git. Bất kỳ ai clone repo về đều có thể xem lịch sử và lấy được.

**Tùy chọn 1: Dùng BFG Repo-Cleaner (Khuyên dùng)**
1. Tải BFG: `wget https://repo1.maven.org/maven2/com/madgag/bfg/1.14.0/bfg-1.14.0.jar`
2. Tạo một file `passwords.txt` chứa các mật khẩu đã bị lộ (mỗi dòng 1 mật khẩu).
3. Chạy lệnh thay thế toàn bộ mật khẩu bằng `***REMOVED***`:
   ```bash
   java -jar bfg-1.14.0.jar --replace-text passwords.txt
   ```
4. Dọn rác Git và ép push lên server (cẩn thận vì lệnh này viết lại toàn bộ lịch sử):
   ```bash
   git reflog expire --expire=now --all && git gc --prune=now --aggressive
   git push --force
   ```

**Dọn dẹp Docker Image Layers:**
Secret có thể kẹt lại trong các layer của Docker image cũ đang chạy trên server.
1. Xóa toàn bộ image cũ không dùng tới:
   ```bash
   docker system prune -a --volumes
   ```

## BƯỚC 4: KÍCH HOẠT QUÉT SECRET TỰ ĐỘNG

Tôi đã cài đặt sẵn cho bạn 2 lớp bảo vệ:
1. **GitHub Actions**: File `.github/workflows/secret-scan.yml` sẽ dùng Gitleaks quét tự động mỗi khi có code push lên.
2. **Pre-commit Hook (Cá nhân)**: Để quét ngay trên máy bạn trước khi commit, bạn cần cài đặt `pre-commit` (yêu cầu máy có cài Python):
   ```bash
   pip install pre-commit
   pre-commit install
   ```
   Từ giờ mỗi khi bạn gõ `git commit`, gitleaks sẽ chạy và tự động chặn nếu bạn vô tình gõ mật khẩu vào code.
