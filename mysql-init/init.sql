-- Tạo người dùng riêng cho ứng dụng thay vì sử dụng root
CREATE USER IF NOT EXISTS 'onlinestudy_user'@'%' IDENTIFIED BY 'AppS3cr3t#2026_bCd45';

-- Cấp quyền cần thiết (Không cấp quyền ALL PRIVILEGES để tránh rủi ro)
-- Ứng dụng Spring Boot với Hibernate ddl-auto=update cần tạo bảng, sửa cột, đọc ghi dữ liệu.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER ON `onlinestudy`.* TO 'onlinestudy_user'@'%';

-- Làm mới lại quyền
FLUSH PRIVILEGES;
