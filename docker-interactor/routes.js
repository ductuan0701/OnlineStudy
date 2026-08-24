const crypto = require('crypto');
const fs = require('fs');
const { SECRET_TOKEN, DB_FILE, PROJECT_DIR } = require('./config');
const { GlobalState, updateDeploymentState, processedDeliveries, MAX_PROCESSED } = require('./state');
const { main } = require('./deployer');
const { sendSlackAlert, runCmd } = require('./utils');
const { getActiveColor } = require('./monitor');

function setupRoutes(app, webhookLimiter) {
  
  app.post('/webhook', webhookLimiter, async (req, res) => {
    const signature = req.headers['x-hub-signature-256'];
    const deliveryId = req.headers['x-github-delivery'];
    const event = req.headers['x-github-event'];

    const commitSha = req.body?.workflow_run?.head_commit?.id || req.body?.after || req.body?.pull_request?.head?.sha || req.body?.commit_sha || 'unknown_commit';
    const sender = req.body?.sender?.login || 'unknown_sender';

    if (event === 'workflow_run') {
      if (req.body.action !== 'completed' || req.body.workflow_run?.conclusion !== 'success') {
        console.log(`[Webhook] 🟡 Bỏ qua sự kiện ${event} vì trạng thái là: ${req.body.action} / ${req.body.workflow_run?.conclusion}`);
        return res.status(200).send('Ignored: Workflow not completed or not successful');
      }
    }

    if (GlobalState.isDeploying) {
      console.log(`[Webhook] 🟡 Đưa vào hàng đợi (QUEUED): Tiến trình khác đang chạy!`);
      GlobalState.deploymentQueue.push({ commitSha, sender });
      updateDeploymentState(commitSha, 'QUEUED');
      return res.status(202).send('Queued');
    }

    if (!signature) {
      console.log(`[Webhook] ⛔ Bị từ chối: Thiếu X-Hub-Signature-256 header! (Sender: ${sender})`);
      return res.status(401).send('Unauthorized: Missing signature');
    }

    if (deliveryId && processedDeliveries.has(deliveryId)) {
      console.log(`[Webhook] ⛔ Bị từ chối (Replay Attack): Đã xử lý Delivery ID ${deliveryId}`);
      return res.status(400).send('Duplicate Delivery ID');
    }

    try {
      const hmac = crypto.createHmac('sha256', SECRET_TOKEN);
      const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');

      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
        console.log(`[Webhook] ⛔ Bị từ chối: Chữ ký HMAC không khớp! (Gửi từ: ${req.ip})`);
        return res.status(401).send('Unauthorized: Invalid signature');
      }
    } catch (error) {
      console.log(`[Webhook] ⛔ Lỗi khi kiểm tra chữ ký: ${error.message}`);
      return res.status(500).send('Internal Server Error');
    }

    if (deliveryId) {
      processedDeliveries.add(deliveryId);
      if (processedDeliveries.size > MAX_PROCESSED) {
        const iterator = processedDeliveries.values();
        processedDeliveries.delete(iterator.next().value);
      }
    }

    console.log(`\n[Webhook] 🟢 Tín hiệu HỢP LỆ! (Event: ${event} | Actor: ${sender} | Commit: ${commitSha} | ID: ${deliveryId})`);
    res.status(200).send('Webhook received! Starting SmartDeploy pipeline...');

    main(commitSha, sender);
  });

  app.post('/alert-runbook', async (req, res) => {
    const alertData = req.body;
    console.error(`\n🚨 [CONTINUOUS MONITORING ALERT] Nhận cảnh báo nghiêm trọng từ hệ thống giám sát!`);
    console.error(`Chi tiết: ${JSON.stringify(alertData)}`);

    try {
      const activeColor = await getActiveColor('backend');
      const rollbackColor = activeColor === 'blue' ? 'green' : 'blue';

      console.log(`[Auto-Runbook] Tiến hành Failover khẩn cấp sang luồng dự phòng: ${rollbackColor.toUpperCase()}`);
      
      await sendSlackAlert({
        status: 'FAILED',
        application: 'Continuous Monitoring (Grafana)',
        commit_sha: 'AUTO-FAILOVER',
        strategy: 'Emergency Rollback',
        duration_seconds: 0,
        old_version: activeColor,
        new_version: rollbackColor,
        rollback_reason: `Grafana Alert Triggered. Khôi phục tự động về ${rollbackColor}`
      });

      await runCmd('./scripts/proxy_manager.sh', ['backend_service', `online-study-backend-${rollbackColor}:8080`], { cwd: PROJECT_DIR });
      await runCmd('./scripts/proxy_manager.sh', ['frontend_service', `online-study-frontend-${rollbackColor}:80`], { cwd: PROJECT_DIR });

      console.log(`✅ [Auto-Runbook] Khôi phục thành công!`);
      res.status(200).send('Emergency Rollback Executed');
    } catch (err) {
      console.error(`[Auto-Runbook] LỖI khi chạy kịch bản cấp cứu: ${err.message}`);
      res.status(500).send('Emergency Rollback Failed');
    }
  });

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
          <br/><small class="text-muted" style="margin-top: 4px; display: inline-block;"><i class="fa-solid fa-user"></i> ${log.sender || 'System'}</small>
        </td>
        <td class="text-center nowrap">
          <span class="flow-badge">${(log.old_version || '?').toUpperCase()} <i class="fa-solid fa-arrow-right"></i> ${(log.new_version || '?').toUpperCase()}</span>
          <br/><small class="text-info" style="font-weight: 600; font-size: 11px; margin-top: 4px; display: inline-block;"><i class="fa-solid fa-database"></i> Schema: ${log.schema_version || 'v1.0'}</small>
        </td>
        <td class="text-center font-weight-bold nowrap">${log.duration_seconds !== undefined ? log.duration_seconds + 's' : '<i class="fa-solid fa-spinner fa-spin text-muted"></i>'}</td>
        <td class="text-center nowrap">
          <span class="badge ${log.status === 'SUCCESS' ? 'badge-success' : (log.status === 'FAILED' || log.status === 'ROLLED_BACK') ? 'badge-danger' : log.status === 'QUEUED' ? 'badge-warning' : 'badge-info'}">
            <i class="fa-solid ${log.status === 'SUCCESS' ? 'fa-circle-check' : (log.status === 'FAILED' || log.status === 'ROLLED_BACK') ? 'fa-circle-xmark' : 'fa-circle-notch fa-spin'}"></i> ${log.status}
          </span>
        </td>
        <td class="text-center">
          ${log.rollback_reason ? `<div class="note-box">${log.rollback_reason}</div>` : '<span class="text-muted">-</span>'}
        </td>
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
          :root { --bg-color: #f0f2f5; --card-bg: #ffffff; --primary: #4f46e5; --text-main: #1e293b; --text-muted: #64748b; --border: #e2e8f0; }
          body { font-family: 'Inter', sans-serif; background-color: var(--bg-color); color: var(--text-main); margin: 0; padding: 3rem 1rem; -webkit-font-smoothing: antialiased; }
          .container { max-width: 1100px; margin: 0 auto; background: var(--card-bg); border-radius: 16px; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05), 0 8px 10px -6px rgba(0,0,0,0.01); overflow: hidden; }
          .header { background: linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%); padding: 2.5rem 2rem; color: white; text-align: center; }
          .header h1 { margin: 0; font-size: 28px; font-weight: 700; display: flex; justify-content: center; align-items: center; gap: 12px; letter-spacing: -0.5px; }
          .header p { margin: 10px 0 0 0; font-size: 15px; opacity: 0.9; font-weight: 300; }
          .table-responsive { padding: 0; overflow-x: auto; }
          table { width: 100%; border-collapse: separate; border-spacing: 0; }
          th, td { padding: 18px 15px; border-bottom: 1px solid var(--border); vertical-align: middle; }
          th { background-color: #f8fafc; font-weight: 600; color: #475569; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
          tr:last-child td { border-bottom: none; }
          tr:hover td { background-color: #f8fafc; transition: all 0.2s ease; }
          .text-center { text-align: center; }
          .text-muted { color: var(--text-muted); }
          .text-danger { color: #ef4444; }
          .font-weight-bold { font-weight: 600; }
          .font-italic { font-style: italic; }
          .nowrap { white-space: nowrap; }
          .note-box { text-align: left; max-width: 320px; line-height: 1.5; font-size: 12px; color: #dc2626; background-color: #fef2f2; padding: 8px 12px; border-radius: 6px; border: 1px solid #fecaca; word-break: break-word; margin: 0 auto; }
          .py-5 { padding-top: 3rem; padding-bottom: 3rem; }
          .badge { padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; letter-spacing: 0.3px; white-space: nowrap; }
          .badge-success { background-color: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; }
          .badge-danger { background-color: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
          .badge-warning { background-color: #fffbeb; color: #d97706; border: 1px solid #fde68a; }
          .badge-info { background-color: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; }
          .commit-link { background: #f1f5f9; padding: 6px 10px; border-radius: 6px; font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: #3b82f6; border: 1px solid #e2e8f0; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; transition: all 0.2s; }
          .commit-link:hover { background: #e2e8f0; color: #2563eb; }
          .flow-badge { font-size: 12px; font-weight: 700; color: #475569; background: #f1f5f9; padding: 4px 10px; border-radius: 6px; white-space: nowrap; }
          .flow-badge i { margin: 0 4px; color: #94a3b8; font-size: 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1><i class="fa-solid fa-rocket"></i> SmartDeploy Enterprise</h1>
            <p>Hệ thống giám sát vòng đời triển khai liên tục (Blue-Green Deployment)</p>
          </div>
          <div class="table-responsive">
            <table>
              <thead>
                <tr>
                  <th class="text-center">Thời gian</th>
                  <th class="text-center">Commit & Tác giả</th>
                  <th class="text-center">Luồng & DB Schema</th>
                  <th class="text-center">Thời lượng</th>
                  <th class="text-center">Trạng thái</th>
                  <th class="text-center">Ghi chú</th>
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
}

module.exports = { setupRoutes };
