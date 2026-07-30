const express = require('express');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

// Cấu hình Express Webhook
const app = express();
const PORT = process.env.PORT || 9000;
const SECRET_TOKEN = process.env.SECRET_TOKEN || 'my-secret';
const PROJECT_DIR = '/root/online-study'; // Đường dẫn phải giống hệt trên Host (Docker out of Docker)

/**
 * HÀM MAIN ĐIỀU PHỐI (ORCHESTRATOR)
 */
async function main() {
  console.log("=== BẮT ĐẦU TIẾN TRÌNH AUTO DEPLOY ===");
  try {
    console.log(`\n[1] Đang kéo (Pull) phiên bản Image mới nhất từ Docker Hub...`);
    const { stdout: pullOut, stderr: pullErr } = await exec(`cd ${PROJECT_DIR} && docker compose -f docker-compose.prod.yml pull`);
    console.log(pullOut || pullErr);
    
    console.log(`\n[2] Đang khởi động lại hệ thống (Up)...`);
    const { stdout: upOut, stderr: upErr } = await exec(`cd ${PROJECT_DIR} && docker compose -f docker-compose.prod.yml up -d --remove-orphans`);
    console.log(upOut || upErr);
    
    console.log(`\n[3] Đang dọn dẹp các Image rác để giải phóng ổ cứng (Prune)...`);
    const { stdout: pruneOut, stderr: pruneErr } = await exec(`docker system prune -f`);
    console.log(pruneOut || pruneErr);

    console.log("\n=== HOÀN TẤT TRIỂN KHAI THÀNH CÔNG! ===");
  } catch (error) {
    console.error("\n💥 Đã xảy ra lỗi hệ thống, tiến trình bị hủy bỏ:", error.message);
  }
}

app.post('/webhook', async (req, res) => {
  const token = req.query.token;
  if (token !== SECRET_TOKEN) {
    console.log(`[Webhook] ⛔ Bị từ chối truy cập do sai Token!`);
    return res.status(401).send('Unauthorized');
  }

  console.log(`\n[Webhook] 🟢 Nhận được tín hiệu Auto-Deploy hợp lệ!`);
  // Trả về 202 Accepted ngay lập tức để Webhook caller không bị Timeout
  res.status(202).send('Accepted. Deploying in background...');

  // Kích hoạt tiến trình cập nhật ngầm
  await main();
});

// Khởi chạy Agent
app.listen(PORT, () => {
  console.log(`🎧 Docker Webhook Agent (Production) đang lắng nghe tại http://0.0.0.0:${PORT}/webhook`);
  console.log(`🔑 Yêu cầu Token bảo mật: ?token=${SECRET_TOKEN}`);
  console.log(`📂 Đã liên kết thư mục làm việc: ${PROJECT_DIR}`);
});
