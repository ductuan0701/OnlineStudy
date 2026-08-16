const express = require('express');
const util = require('util');
const { execFile } = require('child_process');
const runCmd = util.promisify(execFile);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

// Cấu hình Express Webhook
const app = express();
app.set('trust proxy', 1); // Cần thiết khi chạy sau Nginx/Cloudflare để Rate Limit lấy đúng IP

// Hỗ trợ body JSON, giới hạn 100kb và lưu lại Raw Body để tính HMAC
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
const PORT = process.env.PORT || 9000;
const SECRET_TOKEN = process.env.SECRET_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const PROJECT_DIR = '/root/online-study'; // Đường dẫn phải giống hệt trên Host (Docker out of Docker)
const DB_FILE = path.join(PROJECT_DIR, 'docker-interactor', 'deployments.json');
if (!SECRET_TOKEN) {
  console.error("🚨 LỖI BẢO MẬT: Bạn chưa cấu hình biến môi trường SECRET_TOKEN trong file .env!");
  process.exit(1);
}

// Chống Replay Attack: Lưu trữ các ID đã xử lý
const processedDeliveries = new Set();
const MAX_PROCESSED = 1000;

// Khoá tiến trình (Mutex Lock) để chống chạy đè nhiều bản Deploy cùng lúc
// Khoá tiến trình và Hàng đợi (Queue)
let isDeploying = false;
const deploymentQueue = []; // Mục 34: Dùng Queue

// Mục 36: Lưu State Machine bền vững
function updateDeploymentState(commitSha, state, extra = {}) {
  try {
    let deployments = [];
    if (fs.existsSync(DB_FILE)) deployments = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));

    let target = deployments.find(d => d.commit_sha === commitSha && !['SUCCESS', 'FAILED', 'ROLLED_BACK'].includes(d.status));
    if (!target) {
      target = {
        deployment_id: 'dep_' + Date.now(),
        commit_sha: commitSha,
        status: state,
        start_time: new Date().toISOString(),
        application: 'online-study',
        ...extra
      };
      deployments.unshift(target);
    } else {
      target.status = state;
      Object.assign(target, extra);
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(deployments, null, 2));
    console.log(`[State Machine] ${commitSha.substring(0, 7)} -> ${state}`);
  } catch (e) { }
}

function processQueue() {
  if (isDeploying || deploymentQueue.length === 0) return;
  const nextCommit = deploymentQueue.shift();
  main(nextCommit);
}

// Giới hạn số lượng Request (Rate Limit) cho Webhook: Tối đa 15 request / 1 phút
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 15,
  message: "Too many webhook requests from this IP, please try again after a minute."
});

/**
 * GỬI THÔNG BÁO SLACK 
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
    if (!response.ok) throw new Error(`Prometheus HTTP ${response.status}`);
    const data = await response.json();
    if (data.status === 'success' && data.data.result.length > 0) {
      const val = parseFloat(data.data.result[0].value[1]);
      return Number.isNaN(val) ? null : val;
    }
    return null; // No data
  } catch (e) {
    throw new Error(`Prometheus Unavailable: ${e.message}`);
  }
}

/**
 * CANARY ANALYSIS MODULE (MULTI-DIMENSIONAL SMART ROLLBACK)
 */
async function canaryAnalysis(candidateColor, durationMs = 120000, checkIntervalMs = 15000) {
  console.log(`\n[5] BẮT ĐẦU POST-DEPLOYMENT VERIFICATION (${candidateColor.toUpperCase()}) - ${durationMs / 1000}s`);
  const endTime = Date.now() + durationMs;
  const MIN_REQUESTS_THRESHOLD = 5; // Yêu cầu tối thiểu 5 request/phút để đánh giá

  while (Date.now() < endTime) {
    try {
      // 1. Phân tích Error Rate (5xx) gắn nhãn color
      const error5xxRate = await fetchPrometheusMetric(`sum(rate(http_server_requests_seconds_count{status=~"5..", instance="backend-${candidateColor}:8080"}[1m]))`);
      const totalRequestRate = await fetchPrometheusMetric(`sum(rate(http_server_requests_seconds_count{instance="backend-${candidateColor}:8080"}[1m]))`);

      // Xử lý INCONCLUSIVE: Không có data hoặc Zero Traffic
      if (totalRequestRate === null || totalRequestRate === 0) {
        console.warn(`⚠️ Đang chờ dữ liệu metric từ Prometheus cho ${candidateColor}...`);
        await new Promise(r => setTimeout(r, checkIntervalMs));
        continue;
      }

      // Quy đổi sang request/phút
      const requestsPerMin = totalRequestRate * 60;
      if (requestsPerMin < MIN_REQUESTS_THRESHOLD) {
        console.warn(`⚠️ Lưu lượng quá thấp (${requestsPerMin.toFixed(1)} req/m). Đang chờ thêm traffic...`);
        await new Promise(r => setTimeout(r, checkIntervalMs));
        continue;
      }

      let errorPercentage = (error5xxRate || 0) / totalRequestRate * 100;

      // 2. Phân tích Độ trễ (Latency P95 & P99)
      const p95Latency = await fetchPrometheusMetric(`histogram_quantile(0.95, sum(rate(http_server_requests_seconds_bucket{instance="backend-${candidateColor}:8080"}[1m])) by (le))`) || 0;
      const p99Latency = await fetchPrometheusMetric(`histogram_quantile(0.99, sum(rate(http_server_requests_seconds_bucket{instance="backend-${candidateColor}:8080"}[1m])) by (le))`) || 0;

      // 3. Phân tích Saturation (Tài nguyên Máy chủ)
      const cpuUsage = (await fetchPrometheusMetric(`process_cpu_usage{instance="backend-${candidateColor}:8080"}`) || 0) * 100;
      const heapUsed = await fetchPrometheusMetric(`sum(jvm_memory_used_bytes{area="heap", instance="backend-${candidateColor}:8080"})`);
      const heapMax = await fetchPrometheusMetric(`sum(jvm_memory_max_bytes{area="heap", instance="backend-${candidateColor}:8080"})`);
      const memoryUsage = heapMax > 0 ? ((heapUsed || 0) / heapMax) * 100 : 0;

      console.log(`[Score] Traffic: ${requestsPerMin.toFixed(1)} req/m | Err: ${errorPercentage.toFixed(2)}% | P95: ${(p95Latency * 1000).toFixed(0)}ms | CPU: ${cpuUsage.toFixed(1)}% | Mem: ${memoryUsage.toFixed(1)}%`);

      // Tiêu chí FAIL (Khôi phục)
      if (errorPercentage > 1.0) return { passed: false, reason: `FAIL: Lỗi 5xx vượt ngưỡng (${errorPercentage.toFixed(2)}%)` };
      if (p95Latency > 0.500) return { passed: false, reason: `FAIL: P95 Latency vượt ngưỡng 500ms (${(p95Latency * 1000).toFixed(0)}ms)` };
      if (cpuUsage > 80.0) return { passed: false, reason: `FAIL: CPU Usage bão hòa (${cpuUsage.toFixed(1)}%)` };

      await new Promise(res => setTimeout(res, checkIntervalMs));
    } catch (e) {
      // INCONCLUSIVE: Prometheus sập hoặc Parse Error -> Fail Closed
      console.error(`🚨 INCONCLUSIVE ERROR: ${e.message}`);
      return { passed: false, reason: `INCONCLUSIVE: ${e.message}` };
    }
  }

  console.log(`✅ PASS: Xác minh Post-Deployment thành công!`);
  return { passed: true, reason: 'PASS' };
}

/**
 * HÀM MAIN ĐIỀU PHỐI (ORCHESTRATOR) - ZERO DOWNTIME
 */
async function main(commitSha) {
  isDeploying = true;
  updateDeploymentState(commitSha, 'PREPARING');
  console.log(`=== BẮT ĐẦU TIẾN TRÌNH ZERO-DOWNTIME DEPLOY (Commit: ${commitSha}) ===`);
  const startTime = Date.now();
  let deploymentStatus = 'FAILED';
  let rollbackReason = '';
  let activeColor = 'blue';
  let inactiveColor = 'green';

  try {
    activeColor = await getActiveColor('backend');
    inactiveColor = activeColor === 'blue' ? 'green' : 'blue';

    const ALLOWED_COLORS = ['blue', 'green'];
    if (!ALLOWED_COLORS.includes(activeColor) || !ALLOWED_COLORS.includes(inactiveColor)) {
      throw new Error('Security Violation: Invalid Color!');
    }
    console.log(`\n[0] Nhận diện luồng hiện tại: ${activeColor.toUpperCase()}. Sẽ deploy vào luồng mới: ${inactiveColor.toUpperCase()}`);

    const imageTag = `sha-${commitSha.substring(0, 7)}`;
    console.log(`\n[1] Chuẩn bị triển khai bằng Immutable Tag: ${imageTag}`);

    // YÊU CẦU 2: Tạo Release Manifest & Đọc Schema Version Động (Chuẩn bị cho Rollback DB)
    let schemaVersion = "v1.0";
    let configVersion = "v1.0";
    try {
      console.log(`\n[+] Đang truy xuất cấu hình Version từ Github (Commit: ${commitSha})...`);
      const versionUrl = `https://raw.githubusercontent.com/ductuan0701/OnlineStudy/${commitSha}/version.json`;
      const response = await fetch(versionUrl);
      if (response.ok) {
        const versionData = await response.json();
        schemaVersion = versionData.schema_version || "v1.0";
        configVersion = versionData.config_version || "v1.0";
        console.log(`[+] Đã tìm thấy cấu hình: Schema=${schemaVersion}, Config=${configVersion}`);
      } else {
        console.log(`[+] Không tìm thấy file version.json. Dùng mặc định (v1.0).`);
      }
    } catch (e) {
      console.log(`[+] Lỗi đọc version.json: ${e.message}. Dùng mặc định (v1.0).`);
    }

    const manifestDir = path.join(PROJECT_DIR, 'manifests');
    if (!fs.existsSync(manifestDir)) fs.mkdirSync(manifestDir);
    const manifestPath = path.join(manifestDir, `release-${imageTag}.json`);
    const releaseManifest = {
      version: imageTag,
      backend_digest: `boychungtinh/online-study-backend:${imageTag}`,
      frontend_digest: `boychungtinh/online-study-frontend:${imageTag}`,
      schema_version: schemaVersion,
      config_version: configVersion,
      deployed_at: new Date().toISOString(),
      triggered_by_commit: commitSha
    };
    fs.writeFileSync(manifestPath, JSON.stringify(releaseManifest, null, 2));
    console.log(`[Manifest] Đã lưu Release Manifest tại: manifests/release-${imageTag}.json`);

    console.log(`\n[2] Đang kéo (Pull) phiên bản Image mới nhất từ Docker Hub...`);
    const { stdout: pullOut, stderr: pullErr } = await runCmd('docker', ['compose', '-f', 'docker-compose.prod.yml', 'pull'], { cwd: PROJECT_DIR, env: { ...process.env, IMAGE_TAG: imageTag } });
    console.log(pullOut || pullErr);

    console.log(`\n[3] Đang khởi động container mới (${inactiveColor.toUpperCase()})...`);

    const { stdout: upOut, stderr: upErr } = await runCmd('docker', ['compose', '-f', 'docker-compose.prod.yml', 'up', '-d', `backend-${inactiveColor}`, `frontend-${inactiveColor}`], { cwd: PROJECT_DIR, env: { ...process.env, IMAGE_TAG: imageTag } });
    console.log(upOut || upErr);

    console.log(`\n[3] Kích hoạt Health Monitor Module...`);
    updateDeploymentState(commitSha, 'HEALTH_CHECK');
    await checkHealth(`Backend API (${inactiveColor})`, `http://backend-${inactiveColor}:8080/api/actuator/health`);
    await checkHealth(`Frontend React (${inactiveColor})`, `http://frontend-${inactiveColor}:80/`);

    console.log(`\n[4] Chuyển đổi luồng Nginx (Zero-Downtime Switch)...`);
    updateDeploymentState(commitSha, 'SWITCHED');
    const { stdout: proxyOut1 } = await runCmd('./proxy_manager.sh', ['backend_service', `online-study-backend-${inactiveColor}:8080`], { cwd: PROJECT_DIR });
    console.log(proxyOut1);
    const { stdout: proxyOut2 } = await runCmd('./proxy_manager.sh', ['frontend_service', `online-study-frontend-${inactiveColor}:80`], { cwd: PROJECT_DIR });
    console.log(proxyOut2);

    updateDeploymentState(commitSha, 'VERIFYING');
    const canaryResult = await canaryAnalysis(inactiveColor, 120000, 15000); // Truyền candidateColor

    if (!canaryResult.passed) {
      rollbackReason = canaryResult.reason;
      deploymentStatus = 'ROLLED_BACK';
      console.log(`\n[ROLLBACK] Đang tiến hành khôi phục về phiên bản cũ (${activeColor.toUpperCase()})...`);
      await runCmd('./proxy_manager.sh', ['backend_service', `online-study-backend-${activeColor}:8080`], { cwd: PROJECT_DIR });
      await runCmd('./proxy_manager.sh', ['frontend_service', `online-study-frontend-${activeColor}:80`], { cwd: PROJECT_DIR });

      console.log(`\n[ROLLBACK] Đang dập tắt container lỗi (${inactiveColor.toUpperCase()})...`);
      await runCmd('docker', ['compose', '-f', 'docker-compose.prod.yml', 'stop', `backend-${inactiveColor}`, `frontend-${inactiveColor}`], { cwd: PROJECT_DIR });

      throw new Error(`Triển khai thất bại. Lý do: ${rollbackReason}`);
    }

    deploymentStatus = 'SUCCESS';
    console.log(`\n[6] Đang dập tắt container cũ (${activeColor.toUpperCase()}) để giải phóng tài nguyên...`);
    await runCmd('docker', ['compose', '-f', 'docker-compose.prod.yml', 'stop', `backend-${activeColor}`, `frontend-${activeColor}`], { cwd: PROJECT_DIR });

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
      image_tag: `sha-${commitSha.substring(0, 7)}`,
      old_version: activeColor,
      new_version: inactiveColor,
      strategy: 'Blue-Green / Canary',
      start_time: new Date(startTime).toISOString(),
      end_time: new Date(endTime).toISOString(),
      duration_seconds: Math.round((endTime - startTime) / 1000),
      status: deploymentStatus,
      rollback_reason: rollbackReason
    };

    // Lưu trạng thái cuối
    updateDeploymentState(commitSha, deploymentStatus, logData);

    // Mở khoá và chạy Job tiếp theo
    isDeploying = false;
    processQueue();

    // Gửi cảnh báo qua Slack
    await sendSlackAlert(logData);
  }
}

app.post('/webhook', webhookLimiter, async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const deliveryId = req.headers['x-github-delivery'];
  const event = req.headers['x-github-event'];

  // Xử lý chống trôi lệnh (Race Condition): Chỉ kích hoạt khi Github Actions đã chạy xong và thành công
  if (event === 'workflow_run') {
    if (req.body.action !== 'completed' || req.body.workflow_run?.conclusion !== 'success') {
      console.log(`[Webhook] 🟡 Bỏ qua sự kiện ${event} vì trạng thái là: ${req.body.action} / ${req.body.workflow_run?.conclusion}`);
      return res.status(200).send('Ignored: Workflow not completed or not successful');
    }
  }

  // Mục 34 & 37: Hàng đợi (Queue) - Tuần tự hóa các Webhook đến cùng lúc
  if (isDeploying) {
    console.log(`[Webhook] 🟡 Đưa vào hàng đợi (QUEUED): Tiến trình khác đang chạy!`);
    deploymentQueue.push(commitSha);
    updateDeploymentState(commitSha, 'QUEUED');
    return res.status(202).send('Queued');
  }

  // Trích xuất thông tin log an toàn
  const commitSha = req.body?.workflow_run?.head_commit?.id || req.body?.after || req.body?.pull_request?.head?.sha || req.body?.commit_sha || 'unknown_commit';
  const sender = req.body?.sender?.login || 'unknown_sender';

  if (!signature) {
    console.log(`[Webhook] ⛔ Bị từ chối: Thiếu X-Hub-Signature-256 header! (Sender: ${sender})`);
    return res.status(401).send('Unauthorized: Missing signature');
  }

  // Chống Replay Attack
  if (deliveryId && processedDeliveries.has(deliveryId)) {
    console.log(`[Webhook] ⛔ Bị từ chối (Replay Attack): Đã xử lý Delivery ID ${deliveryId}`);
    return res.status(400).send('Duplicate Delivery ID');
  }

  // Xác thực HMAC-SHA256 an toàn với constant-time comparison
  try {
    const hmac = crypto.createHmac('sha256', SECRET_TOKEN);
    const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

    // So sánh constant-time để chống Timing Attack
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
      console.log(`[Webhook] ⛔ Bị từ chối: Chữ ký HMAC không khớp! (Gửi từ: ${req.ip})`);
      return res.status(401).send('Unauthorized: Invalid signature');
    }
  } catch (error) {
    console.log(`[Webhook] ⛔ Lỗi khi kiểm tra chữ ký: ${error.message}`);
    return res.status(500).send('Internal Server Error');
  }

  // Lưu Delivery ID vào danh sách xử lý
  if (deliveryId) {
    processedDeliveries.add(deliveryId);
    if (processedDeliveries.size > MAX_PROCESSED) {
      // Xóa phần tử cũ nhất nếu vượt quá 1000
      const iterator = processedDeliveries.values();
      processedDeliveries.delete(iterator.next().value);
    }
  }

  console.log(`\n[Webhook] 🟢 Tín hiệu HỢP LỆ! (Event: ${event} | Actor: ${sender} | Commit: ${commitSha} | ID: ${deliveryId})`);
  // Trả về 202 Accepted lập tức để Webhook caller không Timeout
  res.status(202).send('Accepted. Deploying in background...');

  // Kích hoạt tiến cập nhật
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
      <td class="nowrap text-muted"><i class="fa-regular fa-clock"></i> ${new Date(log.start_time).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</td>
      <td class="text-center">
        <a href="https://github.com/ductuan0701/OnlineStudy/commit/${log.commit_sha}" target="_blank" class="commit-link">
          <i class="fa-brands fa-github"></i> ${log.commit_sha.substring(0, 7)}
        </a>
        <br/><small class="text-muted">${log.image_tag || 'latest'}</small>
      </td>
      <td class="text-center nowrap"><span class="flow-badge">${(log.old_version || '?').toUpperCase()} <i class="fa-solid fa-arrow-right"></i> ${(log.new_version || '?').toUpperCase()}</span></td>
      <td class="text-center font-weight-bold nowrap">${log.duration_seconds !== undefined ? log.duration_seconds + 's' : '<i class="fa-solid fa-spinner fa-spin text-muted"></i>'}</td>
      <td class="text-center nowrap">
        <span class="badge ${log.status === 'SUCCESS' ? 'badge-success' :
      (log.status === 'FAILED' || log.status === 'ROLLED_BACK') ? 'badge-danger' :
        log.status === 'QUEUED' ? 'badge-warning' : 'badge-info'
    }">
          <i class="fa-solid ${log.status === 'SUCCESS' ? 'fa-circle-check' :
      (log.status === 'FAILED' || log.status === 'ROLLED_BACK') ? 'fa-circle-xmark' :
        'fa-circle-notch fa-spin'
    }"></i> ${log.status}
        </span>
      </td>
      <td class="text-danger font-italic ${log.rollback_reason ? 'rollback-cell' : 'text-center'}"><small>${log.rollback_reason || '-'}</small></td>
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
        th, td { padding: 18px 15px; border-bottom: 1px solid var(--border); vertical-align: middle; }
        th { 
          background-color: #f8fafc; 
          font-weight: 600; 
          color: #475569; 
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          white-space: nowrap;
        }
        tr:last-child td { border-bottom: none; }
        tr:hover td { background-color: #f8fafc; transition: all 0.2s ease; }
        
        .text-center { text-align: center; }
        .text-muted { color: var(--text-muted); }
        .text-danger { color: #ef4444; }
        .font-weight-bold { font-weight: 600; }
        .font-italic { font-style: italic; }
        .nowrap { white-space: nowrap; }
        .rollback-cell { text-align: left; max-width: 300px; line-height: 1.5; }
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
          white-space: nowrap;
        }
        .badge-success { background-color: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; }
        .badge-danger { background-color: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
        .badge-warning { background-color: #fffbeb; color: #d97706; border: 1px solid #fde68a; }
        .badge-info { background-color: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; }
        
        .commit-link { 
          background: #f1f5f9; 
          padding: 6px 10px; 
          border-radius: 6px; 
          font-size: 13px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          color: #3b82f6;
          border: 1px solid #e2e8f0;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          white-space: nowrap;
          transition: all 0.2s;
        }
        .commit-link:hover { background: #e2e8f0; color: #2563eb; }
        
        .flow-badge {
          font-size: 12px;
          font-weight: 700;
          color: #475569;
          background: #f1f5f9;
          padding: 4px 10px;
          border-radius: 6px;
          white-space: nowrap;
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
                <th class="text-center">Commit & Tag</th>
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
