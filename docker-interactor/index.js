const express = require('express');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const fs = require('fs');
const path = require('path');

// Cấu hình Express Webhook
const app = express();
const PORT = process.env.PORT || 9000;
const SECRET_TOKEN = process.env.SECRET_TOKEN;
if (!SECRET_TOKEN) {
  console.error("🚨 LỖI BẢO MẬT: Bạn chưa cấu hình biến môi trường SECRET_TOKEN trong file .env!");
  process.exit(1);
}
const PROJECT_DIR = '/root/online-study'; // Đường dẫn phải giống hệt trên Host (Docker out of Docker)

/**
 * MODULE HEALTH MONITOR
 */
async function checkHealth(serviceName, url, maxRetries = 12, delayMs = 5000) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      console.log(`[Health Monitor] Đang ping ${serviceName} (${url}) (Lần ${i}/${maxRetries})...`);
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        console.log(`✅ ${serviceName} đã READY và LIVE! (Status: ${response.status})`);
        return true;
      }
      console.warn(`⚠️ ${serviceName} chưa sẵn sàng. (Status: ${response.status})`);
    } catch (error) {
      console.warn(`⚠️ Đang chờ ${serviceName} khởi động... (${error.name})`);
    }
    await new Promise(res => setTimeout(res, delayMs));
  }
  throw new Error(`[Health Monitor] 🚨 Mất kết nối! ${serviceName} KHÔNG vượt qua được bài test sức khỏe sau ${maxRetries * delayMs / 1000}s`);
}

/**
 * XÁC ĐỊNH LUỒNG ĐANG CHẠY (BLUE OR GREEN)
 */
async function getActiveColor(serviceName) {
  try {
    const upstreamFile = path.join(PROJECT_DIR, 'nginx', 'upstreams.conf');
    const content = fs.readFileSync(upstreamFile, 'utf-8');
    // Tìm regex dạng: upstream backend_service { server backend-blue:8080; }
    const regex = new RegExp(`upstream ${serviceName}_service\\s*{[^}]*server\\s+([a-zA-Z0-9-]+):\\d+;`, 'm');
    const match = content.match(regex);
    if (match && match[1]) {
      const targetServer = match[1];
      if (targetServer.includes('blue')) return 'blue';
      if (targetServer.includes('green')) return 'green';
    }
  } catch (err) {
    console.error("[Health Monitor] Lỗi khi đọc upstreams.conf:", err.message);
  }
  return 'blue'; // Mặc định nếu lỗi
}

/**
 * CANARY ANALYSIS MODULE (SMART ROLLBACK)
 */
async function canaryAnalysis(durationMs = 120000, checkIntervalMs = 15000) {
  console.log(`\n[5] BẮT ĐẦU GIAI ĐOẠN CANARY ANALYSIS (${durationMs / 1000}s)`);
  const endTime = Date.now() + durationMs;

  while (Date.now() < endTime) {
    try {
      const query = encodeURIComponent(`sum(rate(http_server_requests_seconds_count{status=~"5.."}[1m]))`);
      const response = await fetch(`http://prometheus:9090/api/v1/query?query=${query}`, { signal: AbortSignal.timeout(5000) });
      const data = await response.json();

      if (data.status === 'success' && data.data.result.length > 0) {
        const errorRate = parseFloat(data.data.result[0].value[1]);
        if (errorRate > 0) { // Ngưỡng: > 0 (Khắt khe: Rollback ngay khi có bất kỳ 500 nào)
          console.error(`🚨 CANARY ALERT: Phát hiện lỗi 5xx trên Production (Error Rate: ${errorRate}). Kích hoạt Smart Rollback!`);
          return false; // Trả về false để báo hiệu cần Rollback
        }
      }
      console.log(`[Canary] Hệ thống đang ổn định... Tiếp tục theo dõi...`);
    } catch (err) {
      console.warn(`[Canary] Cảnh báo: Không thể kết nối Prometheus: ${err.message}`);
    }
    await new Promise(res => setTimeout(res, checkIntervalMs));
  }

  console.log(`✅ CANARY PASS: Bản cập nhật vượt qua bài kiểm tra an toàn sau ${durationMs / 1000}s!`);
  return true;
}

/**
 * HÀM MAIN ĐIỀU PHỐI (ORCHESTRATOR) - ZERO DOWNTIME
 */
async function main() {
  console.log("=== BẮT ĐẦU TIẾN TRÌNH ZERO-DOWNTIME DEPLOY ===");
  try {
    const activeColor = await getActiveColor('backend');
    const inactiveColor = activeColor === 'blue' ? 'green' : 'blue';
    console.log(`\n[0] Nhận diện luồng hiện tại: ${activeColor.toUpperCase()}. Sẽ deploy vào luồng mới: ${inactiveColor.toUpperCase()}`);

    console.log(`\n[1] Đang kéo (Pull) phiên bản Image mới nhất từ Docker Hub...`);
    const { stdout: pullOut, stderr: pullErr } = await exec(`cd ${PROJECT_DIR} && docker compose -f docker-compose.prod.yml pull`);
    console.log(pullOut || pullErr);

    console.log(`\n[2] Đang khởi động container mới (${inactiveColor.toUpperCase()})...`);

    const { stdout: upOut, stderr: upErr } = await exec(`cd ${PROJECT_DIR} && docker compose -f docker-compose.prod.yml up -d backend-${inactiveColor} frontend-${inactiveColor}`);
    console.log(upOut || upErr);

    console.log(`\n[3] Kích hoạt Health Monitor Module...`);
    await checkHealth(`Backend API (${inactiveColor})`, `http://backend-${inactiveColor}:8080/api/actuator/health`);
    await checkHealth(`Frontend React (${inactiveColor})`, `http://frontend-${inactiveColor}:80/`);

    console.log(`\n[4] Chuyển đổi luồng Nginx (Zero-Downtime Switch)...`);
    const { stdout: proxyOut1 } = await exec(`cd ${PROJECT_DIR} && ./proxy_manager.sh backend_service online-study-backend-${inactiveColor}:8080`);
    console.log(proxyOut1);
    const { stdout: proxyOut2 } = await exec(`cd ${PROJECT_DIR} && ./proxy_manager.sh frontend_service online-study-frontend-${inactiveColor}:80`);
    console.log(proxyOut2);

    // Giai đoạn Canary Analysis
    const isCanarySafe = await canaryAnalysis(120000, 15000); // Theo dõi 2 phút

    if (!isCanarySafe) {
      console.log(`\n[ROLLBACK] Đang tiến hành khôi phục về phiên bản cũ (${activeColor.toUpperCase()})...`);
      const { stdout: rbOut1 } = await exec(`cd ${PROJECT_DIR} && ./proxy_manager.sh backend_service online-study-backend-${activeColor}:8080`);
      console.log(rbOut1);
      const { stdout: rbOut2 } = await exec(`cd ${PROJECT_DIR} && ./proxy_manager.sh frontend_service online-study-frontend-${activeColor}:80`);
      console.log(rbOut2);

      console.log(`\n[ROLLBACK] Đang dập tắt container lỗi (${inactiveColor.toUpperCase()})...`);
      await exec(`cd ${PROJECT_DIR} && docker compose -f docker-compose.prod.yml stop backend-${inactiveColor} frontend-${inactiveColor}`);

      throw new Error("Triển khai thất bại do không vượt qua Canary Analysis. Đã tự động Rollback thành công bảo vệ người dùng!");
    }

    console.log(`\n[6] Đang dập tắt container cũ (${activeColor.toUpperCase()}) để giải phóng tài nguyên...`);
    await exec(`cd ${PROJECT_DIR} && docker compose -f docker-compose.prod.yml stop backend-${activeColor} frontend-${activeColor}`);

    console.log(`\n[6] Đang dọn dẹp các Image rác để giải phóng ổ cứng (Prune)...`);
    const { stdout: pruneOut, stderr: pruneErr } = await exec(`docker system prune -f`);
    console.log(pruneOut || pruneErr);

    console.log("\n=== HOÀN TẤT TRIỂN KHAI ZERO-DOWNTIME THÀNH CÔNG! ===");
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
