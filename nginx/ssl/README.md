# Thư Mục Lưu Trữ Chứng Chỉ SSL/TLS (Cloudflare Origin CA / Let's Encrypt)

Để kích hoạt HTTPS trên Nginx cho tên miền **`hoclaptrinh.top`**, bạn hãy thực hiện các bước sau:

1. Đăng nhập vào bảng điều khiển **Cloudflare** -> Chọn tên miền `hoclaptrinh.top`.
2. Vào mục **SSL/TLS** -> **Origin Server** -> Nhấp vào **Create Certificate** (Thời hạn 15 năm).
3. Sao chép nội dung **Origin Certificate** và lưu vào tệp tại đường dẫn:
   ```
   nginx/ssl/origin.crt
   ```
4. Sao chép nội dung **Private Key** và lưu vào tệp tại đường dẫn:
   ```
   nginx/ssl/origin.key
   ```

> [!NOTE]
> Nếu các tệp `origin.crt` và `origin.key` chưa tồn tại, Nginx có thể tạm thời không khởi động được ở chế độ SSL. Hãy đảm bảo tạo 2 tệp này trước khi chạy `docker compose up -d`.
