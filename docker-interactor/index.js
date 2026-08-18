const express = require('express');
const rateLimit = require('express-rate-limit');
const { PORT, SECRET_TOKEN, PROJECT_DIR } = require('./config');
const { setupRoutes } = require('./routes');

// Cấu hình Express Webhook
const app = express();
app.set('trust proxy', 1); // Cần thiết khi chạy sau Nginx/Cloudflare để Rate Limit lấy đúng IP

// Hỗ trợ body JSON, giới hạn 5mb và lưu lại Raw Body để tính HMAC
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Giới hạn số lượng Request (Rate Limit) cho Webhook: Tối đa 15 request / 1 phút
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 15,
  message: "Too many webhook requests from this IP, please try again after a minute."
});

// Kích hoạt tất cả các Routes
setupRoutes(app, webhookLimiter);

// Khởi chạy Agent
app.listen(PORT, () => {
  console.log(`🎧 Docker Webhook Agent đang lắng nghe tại http://0.0.0.0:${PORT}/webhook`);
  console.log(`📊 Dashboard Lịch sử Triển khai tại http://0.0.0.0:${PORT}/history`);
  console.log(`🔑 Yêu cầu Token bảo mật: ?token=${SECRET_TOKEN}`);
  console.log(`📂 Đã liên kết thư mục làm việc: ${PROJECT_DIR}`);
});
