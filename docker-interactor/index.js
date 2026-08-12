const express = require('express');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Cấu hình Express Webhook
const app = express();
app.use(express.json()); // Hỗ trợ body JSON
const PORT = process.env.PORT || 9000;
const SECRET_TOKEN = process.env.SECRET_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const PROJECT_DIR = '/root/online-study'; // Đường dẫn phải giống hệt trên Host (Docker out of Docker)
const DB_FILE = path.join(PROJECT_DIR, 'docker-interactor', 'deployments.json');
if (!SECRET_TOKEN) {
  console.error("🚨 LỖI BẢO MẬT: Bạn chưa cấu hình biến môi trường SECRET_TOKEN trong file .env!");
  process.exit(1);
}

/**
 * GỬI THÔNG BÁO SLACK (ALERTING)
 */
async function sendSlackAlert(logData) {
  if (!SLACK_WEBHOOK_URL) return;

  const isSuccess = logData.status === 'SUCCESS';
  const payload = {
    attachments: [{
      color: isSuccess ? '#36a64f' : '#ff0000',
      title: isSuccess ? '✅ SmartDeploy Success' : '🚨 SmartDeploy Rollback',
      fields: [
        { title: 'Application', value: logData.application, short: true },
        { title: 'Version', value: logData.commit_sha, short: true },
        { title: 'Strategy', value: logData.strategy, short: true },
        { title: 'Status', value: logData.status, short: true },
        { title: 'Duration', value: `${logData.duration_seconds}s`, short: true },
        { title: 'Transition', value: `${logData.old_version.toUpperCase()} ➔ ${logData.new_version.toUpperCase()}`, short: true }
      ]
    }]
  };

  if (!isSuccess && logData.rollback_reason) {
    payload.attachments[0].fields.push({ title: 'Reason', value: logData.rollback_reason, short: false });
  }

  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log(`[Alerting] Đã gửi thông báo tới Slack!`);
  } catch (error) {
    console.error(`[Alerting] Lỗi gửi Slack: ${error.message}`);
  }
}

/**
 * LƯU LỊCH SỬ DEPLOYMENT
 */
function saveDeploymentLog(logData) {
  try {
    let deployments = [];
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      deployments = JSON.parse(raw);
    }
    deployments.unshift(logData); // Thêm vào đầu danh sách
    fs.writeFileSync(DB_FILE, JSON.stringify(deployments, null, 2));
    console.log(`[History] Đã lưu lịch sử deployment: ${logData.deployment_id}`);
  } catch (e) {
    console.error(`[History] Lỗi lưu lịch sử: ${e.message}`);
  }
}

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

async function fetchPrometheusMetric(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const response = await fetch(`http://prometheus:9090/api/v1/query?query=${encodedQuery}`, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    if (data.status === 'success' && data.data.result.length > 0) {
      const val = parseFloat(data.data.result[0].value[1]);
      return Number.isNaN(val) ? 0 : val;
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

/**
 * CANARY ANALYSIS MODULE (MULTI-DIMENSIONAL SMART ROLLBACK)
 */
async function canaryAnalysis(durationMs = 120000, checkIntervalMs = 15000) {
  console.log(`\n[5] BẮT ĐẦU GIAI ĐOẠN CANARY ANALYSIS (Multi-dimensional) - ${durationMs / 1000}s`);
  const endTime = Date.now() + durationMs;

  while (Date.now() < endTime) {
    // 1. Phân tích Error Rate (5xx)
    const error5xxRate = await fetchPrometheusMetric('sum(rate(http_server_requests_seconds_count{status=~"5.."}[1m]))');
    const totalRequestRate = await fetchPrometheusMetric('sum(rate(http_server_requests_seconds_count[1m]))');
    let errorPercentage = 0;
    if (totalRequestRate > 0) {
      errorPercentage = (error5xxRate / totalRequestRate) * 100;
    } else if (error5xxRate > 0) {
      errorPercentage = 100;
    }

    // 2. Phân tích Độ trễ (Latency P95 & P99)
    const p95Latency = await fetchPrometheusMetric('histogram_quantile(0.95, sum(rate(http_server_requests_seconds_bucket[1m])) by (le))');
    const p99Latency = await fetchPrometheusMetric('histogram_quantile(0.99, sum(rate(http_server_requests_seconds_bucket[1m])) by (le))');

    // 3. Phân tích Tài nguyên Máy chủ (CPU & Memory)
    const cpuUsage = await fetchPrometheusMetric('process_cpu_usage') * 100;
    const heapUsed = await fetchPrometheusMetric('sum(jvm_memory_used_bytes{area="heap"})');
    const heapMax = await fetchPrometheusMetric('sum(jvm_memory_max_bytes{area="heap"})');
    const memoryUsage = heapMax > 0 ? (heapUsed / heapMax) * 100 : 0;

    // In điểm số Canary Score hiện tại
    console.log(`[Canary Score] Err: ${errorPercentage.toFixed(2)}% | P95: ${(p95Latency * 1000).toFixed(0)}ms | P99: ${(p99Latency * 1000).toFixed(0)}ms | CPU: ${cpuUsage.toFixed(1)}% | Mem: ${memoryUsage.toFixed(1)}%`);

    // Kiểm tra các ngưỡng giới hạn (Thresholds)
    if (errorPercentage > 1.0) {
      const msg = `🚨 Lỗi 5xx vượt ngưỡng 1% (${errorPercentage.toFixed(2)}%)!`;
      console.error(`CANARY ALERT: ${msg}`);
      return { passed: false, reason: msg };
    }
    if (p95Latency > 0.500) {
      const msg = `🚨 P95 Latency vượt ngưỡng 500ms (${(p95Latency * 1000).toFixed(0)}ms)!`;
      console.error(`CANARY ALERT: ${msg}`);
      return { passed: false, reason: msg };
    }
    if (p99Latency > 1.000) {
      const msg = `🚨 P99 Latency vượt ngưỡng 1s (${(p99Latency * 1000).toFixed(0)}ms)!`;
      console.error(`CANARY ALERT: ${msg}`);
      return { passed: false, reason: msg };
    }
    if (cpuUsage > 80.0) {
      const msg = `🚨 CPU Usage vượt ngưỡng 80% (${cpuUsage.toFixed(1)}%)!`;
      console.error(`CANARY ALERT: ${msg}`);
      return { passed: false, reason: msg };
    }
    if (memoryUsage > 85.0) {
      const msg = `🚨 Memory Usage vượt ngưỡng 85% (${memoryUsage.toFixed(1)}%)!`;
      console.error(`CANARY ALERT: ${msg}`);
      return { passed: false, reason: msg };
    }

    await new Promise(res => setTimeout(res, checkIntervalMs));
  }

  console.log(`✅ CANARY PASS: Bản cập nhật đạt điểm An Toàn (Safe Score) trên mọi chỉ số!`);
  return { passed: true, reason: 'Mọi chỉ số an toàn' };
}

/**
 * HÀM MAIN ĐIỀU PHỐI (ORCHESTRATOR) - ZERO DOWNTIME
 */
async function main(commitSha) {
  console.log(`=== BẮT ĐẦU TIẾN TRÌNH ZERO-DOWNTIME DEPLOY (Commit: ${commitSha}) ===`);
  const startTime = Date.now();
  let deploymentStatus = 'FAILED';
  let rollbackReason = '';
  let activeColor = 'blue';
  let inactiveColor = 'green';

  try {
    activeColor = await getActiveColor('backend');
    inactiveColor = activeColor === 'blue' ? 'green' : 'blue';
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

    const canaryResult = await canaryAnalysis(120000, 15000); // Theo dõi 2 phút

    if (!canaryResult.passed) {
      rollbackReason = canaryResult.reason;
      deploymentStatus = 'ROLLED_BACK';
      console.log(`\n[ROLLBACK] Đang tiến hành khôi phục về phiên bản cũ (${activeColor.toUpperCase()})...`);
      await exec(`cd ${PROJECT_DIR} && ./proxy_manager.sh backend_service online-study-backend-${activeColor}:8080`);
      await exec(`cd ${PROJECT_DIR} && ./proxy_manager.sh frontend_service online-study-frontend-${activeColor}:80`);

      console.log(`\n[ROLLBACK] Đang dập tắt container lỗi (${inactiveColor.toUpperCase()})...`);
      await exec(`cd ${PROJECT_DIR} && docker compose -f docker-compose.prod.yml stop backend-${inactiveColor} frontend-${inactiveColor}`);

      throw new Error(`Triển khai thất bại. Lý do: ${rollbackReason}`);
    }

    deploymentStatus = 'SUCCESS';
    console.log(`\n[6] Đang dập tắt container cũ (${activeColor.toUpperCase()}) để giải phóng tài nguyên...`);
    await exec(`cd ${PROJECT_DIR} && docker compose -f docker-compose.prod.yml stop backend-${activeColor} frontend-${activeColor}`);

    console.log(`\n[6] Đang dọn dẹp các Image rác để giải phóng ổ cứng (Prune)...`);
    const { stdout: pruneOut, stderr: pruneErr } = await exec(`docker system prune -f`);
    console.log(pruneOut || pruneErr);

    console.log("\n=== HOÀN TẤT TRIỂN KHAI ZERO-DOWNTIME THÀNH CÔNG! ===");
  } catch (error) {
    if (deploymentStatus !== 'ROLLED_BACK') {
      rollbackReason = error.message;
    }
    console.error("\n💥 Đã xảy ra lỗi hệ thống, tiến trình bị hủy bỏ:", error.message);
  } finally {
    const endTime = Date.now();
    const logData = {
      deployment_id: crypto.randomUUID(),
      application: 'Online Study Backend',
      commit_sha: commitSha,
      old_version: activeColor,
      new_version: inactiveColor,
      strategy: 'Blue-Green / Canary',
      start_time: new Date(startTime).toISOString(),
      end_time: new Date(endTime).toISOString(),
      duration_seconds: Math.round((endTime - startTime) / 1000),
      status: deploymentStatus,
      rollback_reason: rollbackReason
    };

    // Lưu lịch sử vào DB
    saveDeploymentLog(logData);

    // Gửi cảnh báo qua Slack
    await sendSlackAlert(logData);
  }
}

app.post('/webhook', async (req, res) => {
  const token = req.query.token;
  const commitSha = req.body?.commit_sha || req.query?.commit_sha || 'unknown_commit';

  if (token !== SECRET_TOKEN) {
    console.log(`[Webhook] ⛔ Bị từ chối truy cập do sai Token!`);
    return res.status(401).send('Unauthorized');
  }

  console.log(`\n[Webhook] 🟢 Nhận được tín hiệu Auto-Deploy hợp lệ! (Commit: ${commitSha})`);
  // Trả về 202 Accepted ngay lập tức để Webhook caller không bị Timeout
  res.status(202).send('Accepted. Deploying in background...');

  // Kích hoạt tiến trình cập nhật ngầm
  await main(commitSha);
});

// ==========================================
// 4. API DASHBOARD - XEM LỊCH SỬ TRIỂN KHAI
// ==========================================
app.get('/history', (req, res) => {
  let logs = [];
  try {
    if (fs.existsSync(DB_FILE)) {
      logs = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (err) {
    console.error("Lỗi đọc DB_FILE cho Dashboard:", err);
  }

  let rowsHtml = logs.map(log => `
    <tr>
      <td class="text-center text-muted">${new Date(log.start_time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</td>
      <td class="text-center"><code><i class="fa-solid fa-code-commit"></i> ${log.commit_sha}</code></td>
      <td class="text-center"><span class="flow-badge">${log.old_version.toUpperCase()} <i class="fa-solid fa-arrow-right"></i> ${log.new_version.toUpperCase()}</span></td>
      <td class="text-center font-weight-bold">${log.duration_seconds}s</td>
      <td class="text-center">
        <span class="badge ${log.status === 'SUCCESS' ? 'badge-success' : 'badge-danger'}">
          <i class="fa-solid ${log.status === 'SUCCESS' ? 'fa-circle-check' : 'fa-circle-xmark'}"></i> ${log.status}
        </span>
      </td>
      <td class="text-center text-danger font-italic"><small>${log.rollback_reason || '-'}</small></td>
    </tr>
  `).join('');

  if (logs.length === 0) rowsHtml = `<tr><td colspan="6" class="text-center text-muted py-5">Chưa có dữ liệu triển khai nào.</td></tr>`;

  const html = `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SmartDeploy | Enterprise Dashboard</title>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
      <style>
        :root {
          --bg-color: #f0f2f5;
          --card-bg: #ffffff;
          --primary: #4f46e5;
          --text-main: #1e293b;
          --text-muted: #64748b;
          --border: #e2e8f0;
        }
        body { 
          font-family: 'Inter', sans-serif; 
          background-color: var(--bg-color); 
          color: var(--text-main); 
          margin: 0; 
          padding: 3rem 1rem;
          -webkit-font-smoothing: antialiased;
        }
        .container { 
          max-width: 1100px; 
          margin: 0 auto; 
          background: var(--card-bg); 
          border-radius: 16px; 
          box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05), 0 8px 10px -6px rgba(0,0,0,0.01);
          overflow: hidden;
        }
        .header {
          background: linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%);
          padding: 2.5rem 2rem;
          color: white;
          text-align: center;
        }
        .header h1 { margin: 0; font-size: 28px; font-weight: 700; display: flex; justify-content: center; align-items: center; gap: 12px; letter-spacing: -0.5px; }
        .header p { margin: 10px 0 0 0; font-size: 15px; opacity: 0.9; font-weight: 300; }
        
        .table-responsive { padding: 0; overflow-x: auto; }
        table { width: 100%; border-collapse: separate; border-spacing: 0; }
        th, td { padding: 18px 15px; border-bottom: 1px solid var(--border); }
        th { 
          background-color: #f8fafc; 
          font-weight: 600; 
          color: #475569; 
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        tr:last-child td { border-bottom: none; }
        tr:hover td { background-color: #f8fafc; transition: all 0.2s ease; }
        
        .text-center { text-align: center; }
        .text-muted { color: var(--text-muted); }
        .text-danger { color: #ef4444; }
        .font-weight-bold { font-weight: 600; }
        .font-italic { font-style: italic; }
        .py-5 { padding-top: 3rem; padding-bottom: 3rem; }
        
        .badge { 
          padding: 6px 12px; 
          border-radius: 20px; 
          font-size: 12px; 
          font-weight: 600; 
          display: inline-flex;
          align-items: center;
          gap: 6px;
          letter-spacing: 0.3px;
        }
        .badge-success { background-color: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; }
        .badge-danger { background-color: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
        
        code { 
          background: #f1f5f9; 
          padding: 5px 10px; 
          border-radius: 6px; 
          font-size: 13px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          color: #3b82f6;
          border: 1px solid #e2e8f0;
        }
        .flow-badge {
          font-size: 12px;
          font-weight: 700;
          color: #475569;
          background: #f1f5f9;
          padding: 4px 10px;
          border-radius: 6px;
        }
        .flow-badge i { margin: 0 4px; color: #94a3b8; font-size: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1><i class="fa-solid fa-rocket"></i> SmartDeploy Enterprise</h1>
          <p>Hệ thống giám sát vòng đời triển khai liên tục (Blue-Green & Canary)</p>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th class="text-center">Thời gian</th>
                <th class="text-center">Commit</th>
                <th class="text-center">Luồng</th>
                <th class="text-center">Thời lượng</th>
                <th class="text-center">Trạng thái</th>
                <th class="text-center">Rollback Log</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    </body>
    </html>
  `;
  res.send(html);
});

// Khởi chạy Agent
app.listen(PORT, () => {
  console.log(`🎧 Docker Webhook Agent đang lắng nghe tại http://0.0.0.0:${PORT}/webhook`);
  console.log(`📊 Dashboard Lịch sử Triển khai tại http://0.0.0.0:${PORT}/history`);
  console.log(`🔑 Yêu cầu Token bảo mật: ?token=${SECRET_TOKEN}`);
  console.log(`📂 Đã liên kết thư mục làm việc: ${PROJECT_DIR}`);
});
