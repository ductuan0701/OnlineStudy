const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROJECT_DIR } = require('./config');
const { GlobalState, updateDeploymentState } = require('./state');
const { runCmd, sendSlackAlert } = require('./utils');
const { preDeploymentReadinessGate, getActiveColor, postDeploymentVerification } = require('./monitor');

function processQueue() {
  if (GlobalState.isDeploying || GlobalState.deploymentQueue.length === 0) return;
  const nextJob = GlobalState.deploymentQueue.shift();
  main(nextJob.commitSha, nextJob.sender, nextJob.commitMessage);
}

async function main(commitSha, sender = 'unknown_sender', commitMessage = '') {
  GlobalState.isDeploying = true;
  updateDeploymentState(commitSha, 'PREPARING');
  console.log(`=== BẮT ĐẦU TIẾN TRÌNH ZERO-DOWNTIME DEPLOY (Commit: ${commitSha}) ===`);
  const startTime = Date.now();
  let deploymentStatus = 'FAILED';
  let rollbackReason = '';
  let activeColor = 'blue';
  let inactiveColor = 'green';
  let schemaVersion = 'unknown';

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

    schemaVersion = "v1.0";
    let configVersion = "v1.0";

    const schemaMatch = commitMessage.match(/\[schema:(v[\d\.]+)\]/i);
    if (schemaMatch && schemaMatch[1]) {
      schemaVersion = schemaMatch[1];
      console.log(`\n[+] Tìm thấy Schema Version từ Commit Message: ${schemaVersion}`);
    } else {
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
      triggered_by_commit: commitSha,
      triggered_by_user: sender
    };
    fs.writeFileSync(manifestPath, JSON.stringify(releaseManifest, null, 2));
    console.log(`[Manifest] Đã lưu Release Manifest tại: manifests/release-${imageTag}.json`);

    try {
      const prevManifests = fs.readdirSync(manifestDir).filter(f => f.startsWith('release-')).sort().reverse();
      if (prevManifests.length > 1) {
        const lastManifest = JSON.parse(fs.readFileSync(path.join(manifestDir, prevManifests[1])));
        if (lastManifest.schema_version !== schemaVersion) {
          console.log(`\n[!] Phát hiện thay đổi Schema (${lastManifest.schema_version} -> ${schemaVersion}). Đang kích hoạt Runbook sao lưu DB...`);
          await runCmd('sh', ['./scripts/backup_db.sh'], { cwd: PROJECT_DIR });
          console.log(`[!] Sao lưu DB thành công.`);
        }
      }
    } catch (e) {
      console.log(`[!] Lỗi kiểm tra/sao lưu DB: ${e.message}`);
    }

    console.log(`\n[2] Đang kéo (Pull) phiên bản Image mới nhất từ Docker Hub...`);
    const { stdout: pullOut, stderr: pullErr } = await runCmd('docker', ['compose', '-f', 'docker-compose.prod.yml', 'pull'], { cwd: PROJECT_DIR, env: { ...process.env, IMAGE_TAG: imageTag } });
    console.log(pullOut || pullErr);

    console.log(`\n[3] Đang khởi động container mới (${inactiveColor.toUpperCase()})...`);
    const { stdout: upOut, stderr: upErr } = await runCmd('docker', ['compose', '-f', 'docker-compose.prod.yml', 'up', '-d', `backend-${inactiveColor}`, `frontend-${inactiveColor}`], { cwd: PROJECT_DIR, env: { ...process.env, IMAGE_TAG: imageTag } });
    console.log(upOut || upErr);

    console.log(`\n[3] Kích hoạt Health Monitor Module...`);
    updateDeploymentState(commitSha, 'HEALTH_CHECK');
    await preDeploymentReadinessGate(`Backend API (${inactiveColor})`, `http://backend-${inactiveColor}:8080/api/actuator/health`);
    await preDeploymentReadinessGate(`Frontend React (${inactiveColor})`, `http://frontend-${inactiveColor}:80/`);

    console.log(`\n[4] Chuyển đổi luồng Nginx (Zero-Downtime Switch)...`);
    console.log(`\n[6] Kích hoạt Nginx Zero-Downtime Switch (Atomic Reload)...`);
    const { stdout: proxyOut1 } = await runCmd('./scripts/proxy_manager.sh', ['backend_service', `online-study-backend-${inactiveColor}:8080`], { cwd: PROJECT_DIR });
    console.log(proxyOut1);
    const { stdout: proxyOut2 } = await runCmd('./scripts/proxy_manager.sh', ['frontend_service', `online-study-frontend-${inactiveColor}:80`], { cwd: PROJECT_DIR });
    console.log(proxyOut2);

    updateDeploymentState(commitSha, 'VERIFYING');
    const canaryResult = await postDeploymentVerification(inactiveColor, 120000, 15000); 

    if (canaryResult.passed) {
      console.log(`[+] Mọi thông số ổn định. Bắt đầu vô hiệu hóa luồng cũ (${activeColor.toUpperCase()})...`);
      if (canaryResult.reason === 'INCONCLUSIVE_PASS') {
        deploymentStatus = 'INCONCLUSIVE_PASS';
      }
    } else {
      rollbackReason = canaryResult.reason;
      deploymentStatus = 'ROLLED_BACK';
      console.log(`\n[!] CẢNH BÁO: HỆ THỐNG GẶP LỖI (${canaryResult.reason})`);
      console.log(`[!] TIẾN HÀNH ROLLBACK (Khôi phục Nginx về ${activeColor.toUpperCase()})...`);
      
      await runCmd('./scripts/proxy_manager.sh', ['backend_service', `online-study-backend-${activeColor}:8080`], { cwd: PROJECT_DIR });
      await runCmd('./scripts/proxy_manager.sh', ['frontend_service', `online-study-frontend-${activeColor}:80`], { cwd: PROJECT_DIR });

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
      sender: sender,
      old_version: activeColor,
      new_version: inactiveColor,
      schema_version: schemaVersion,
      strategy: 'Blue-Green / Canary',
      start_time: new Date(startTime).toISOString(),
      end_time: new Date(endTime).toISOString(),
      duration_seconds: Math.round((endTime - startTime) / 1000),
      status: deploymentStatus,
      rollback_reason: rollbackReason
    };

    updateDeploymentState(commitSha, deploymentStatus, logData);

    GlobalState.isDeploying = false;
    processQueue();

    await sendSlackAlert(logData);
  }
}

module.exports = { main, processQueue };
