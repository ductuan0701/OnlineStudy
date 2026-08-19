const fs = require('fs');
const path = require('path');
const { PROJECT_DIR } = require('./config');

async function preDeploymentReadinessGate(serviceName, url, maxWaitMs = 60000, delayMs = 5000) {
  const startTime = Date.now();
  const deadline = startTime + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      console.log(`[Health Monitor] Đang ping ${serviceName} (${url})... (Timeout còn: ${((deadline - Date.now())/1000).toFixed(1)}s)`);
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      
      let isReady = false;
      let details = '';

      if (response.ok) {
        try {
          const body = await response.json();
          if (body.status === 'UP') {
            isReady = true;
          } else {
            details = JSON.stringify(body.components || body);
          }
        } catch (e) {
          isReady = true;
        }
      } else {
        details = `HTTP Status: ${response.status}`;
      }

      if (isReady) {
        console.log(`✅ ${serviceName} đã READY và LIVE! (Thời gian thực: ${((Date.now() - startTime)/1000).toFixed(2)}s)`);
        return true;
      }
      console.warn(`⚠️ ${serviceName} chưa sẵn sàng. ${details ? 'Chi tiết: ' + details : ''}`);
    } catch (error) {
      console.warn(`⚠️ Đang chờ ${serviceName} khởi động... (${error.name})`);
    }

    if (Date.now() + delayMs >= deadline) break;
    await new Promise(res => setTimeout(res, delayMs));
  }
  
  const realWaitTime = ((Date.now() - startTime) / 1000).toFixed(2);
  throw new Error(`[Health Monitor] 🚨 Mất kết nối! ${serviceName} KHÔNG vượt qua được bài test sức khỏe (readiness gate) sau ${realWaitTime}s`);
}

async function getActiveColor(serviceName) {
  try {
    const upstreamFile = path.join(PROJECT_DIR, 'nginx', 'upstreams.conf');
    const content = fs.readFileSync(upstreamFile, 'utf-8');
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
  return 'blue';
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
    return null;
  } catch (e) {
    throw new Error(`Prometheus Unavailable: ${e.message}`);
  }
}

async function postDeploymentVerification(candidateColor, durationMs = 120000, checkIntervalMs = 15000) {
  console.log(`\n[5] BẮT ĐẦU POST-DEPLOYMENT VERIFICATION (${candidateColor.toUpperCase()}) - ${durationMs / 1000}s`);
  const endTime = Date.now() + durationMs;
  const MIN_REQUESTS_THRESHOLD = 5; 
  let hadSufficientTraffic = false;

  while (Date.now() < endTime) {
    try {
      const error5xxRate = await fetchPrometheusMetric(`sum(rate(http_server_requests_seconds_count{status=~"5..", instance="backend-${candidateColor}:8080"}[1m]))`);
      const totalRequestRate = await fetchPrometheusMetric(`sum(rate(http_server_requests_seconds_count{instance="backend-${candidateColor}:8080"}[1m]))`);

      if (totalRequestRate === null || totalRequestRate === 0) {
        console.warn(`⚠️ Đang chờ dữ liệu metric từ Prometheus cho ${candidateColor}...`);
        if (Date.now() + checkIntervalMs < endTime) await new Promise(r => setTimeout(r, checkIntervalMs));
        continue;
      }

      const requestsPerMin = totalRequestRate * 60;
      if (requestsPerMin < MIN_REQUESTS_THRESHOLD) {
        console.warn(`⚠️ Lưu lượng quá thấp (${requestsPerMin.toFixed(1)} req/m). Đang chờ thêm traffic...`);
        if (Date.now() + checkIntervalMs < endTime) await new Promise(r => setTimeout(r, checkIntervalMs));
        continue;
      }

      hadSufficientTraffic = true;

      let errorPercentage = (error5xxRate || 0) / totalRequestRate * 100;
      const p95Latency = await fetchPrometheusMetric(`histogram_quantile(0.95, sum(rate(http_server_requests_seconds_bucket{instance="backend-${candidateColor}:8080"}[1m])) by (le))`) || 0;
      const p99Latency = await fetchPrometheusMetric(`histogram_quantile(0.99, sum(rate(http_server_requests_seconds_bucket{instance="backend-${candidateColor}:8080"}[1m])) by (le))`) || 0;
      const cpuUsage = (await fetchPrometheusMetric(`process_cpu_usage{instance="backend-${candidateColor}:8080"}`) || 0) * 100;
      const heapMax = await fetchPrometheusMetric(`sum(jvm_memory_max_bytes{area="heap", instance="backend-${candidateColor}:8080"})`);
      const heapUsed = await fetchPrometheusMetric(`sum(jvm_memory_used_bytes{area="heap", instance="backend-${candidateColor}:8080"})`);
      const memoryUsage = heapMax > 0 ? ((heapUsed || 0) / heapMax) * 100 : 0;

      console.log(`[Score] Traffic: ${requestsPerMin.toFixed(1)} req/m | Err: ${errorPercentage.toFixed(2)}% | P95: ${(p95Latency * 1000).toFixed(0)}ms | P99: ${(p99Latency * 1000).toFixed(0)}ms | CPU: ${cpuUsage.toFixed(1)}% | Mem: ${memoryUsage.toFixed(1)}%`);

      if (errorPercentage > 1.0) return { passed: false, reason: `FAIL: Lỗi 5xx vượt SLO (${errorPercentage.toFixed(2)}%)` };
      if (p95Latency > 0.500) return { passed: false, reason: `FAIL: P95 Latency vượt SLO 500ms (${(p95Latency * 1000).toFixed(0)}ms)` };
      if (p99Latency > 0.800) return { passed: false, reason: `FAIL: P99 Latency vượt SLO 800ms (${(p99Latency * 1000).toFixed(0)}ms)` };
      if (cpuUsage > 80.0) return { passed: false, reason: `FAIL: CPU Usage bão hòa (${cpuUsage.toFixed(1)}%)` };

      if (Date.now() + checkIntervalMs < endTime) await new Promise(res => setTimeout(res, checkIntervalMs));
    } catch (e) {
      console.error(`🚨 ALERT: Lỗi nghiêm trọng - Không thể lấy dữ liệu từ Prometheus. Mất khả năng giám sát!`);
      return { passed: false, reason: `INCONCLUSIVE_FAILSAFE: Prometheus Scrape Failed (${e.message})` };
    }
  }

  if (!hadSufficientTraffic) {
    console.log(`✅ INCONCLUSIVE PASS: Triển khai thành công nhưng lượng traffic quá thấp để đo lường SLO.`);
    return { passed: true, reason: 'INCONCLUSIVE_PASS' };
  }

  console.log(`✅ PASS: Xác minh Post-Deployment thành công với SLO đạt chuẩn! Cửa sổ triển khai khép lại.`);
  return { passed: true, reason: 'PASS' };
}

module.exports = {
  preDeploymentReadinessGate, getActiveColor, postDeploymentVerification
};
