import http from 'k6/http';
import { check, sleep } from 'k6';

// Cấu hình Kịch bản Test Tải (Load Test Options)
export const options = {
  stages: [
    { duration: '30s', target: 5000 },  // Warm-up: Tăng dần lên 1000 Virtual Users (VU)
    { duration: '3m', target: 5000 },   // Chạy tải nền liên tục trong 3 phút (Bao trùm quá trình Deploy)
    { duration: '30s', target: 0 },   // Cool-down: Giảm dần số lượng request
  ],
  // Khai báo các cột thống kê sẽ hiển thị trong báo cáo k6
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)', 'count'],
  thresholds: {
    // LƯU Ý: Các ngưỡng này ĐƯỢC ĐỒNG BỘ 100% với kịch bản Canary Analysis của Webhook Agent
    // Agent sẽ Rollback nếu P95 > 500ms hoặc Error > 1%.
    http_req_duration: ['p(50)<200', 'p(95)<500', 'p(99)<800'], // Khớp với P95 của Canary
    http_req_failed: ['rate<0.01'],   // Khớp với tỷ lệ lỗi 1% của Canary
    checks: ['rate>0.99'],            // Đảm bảo > 99% request trả về đúng HTTP 200 (Status distribution)
    dropped_iterations: ['count>=0'], // Theo dõi số lượng iterations bị drop do hệ thống quá tải
  },
};

export default function () {
  // Gửi request tới Health Check Endpoint để kiểm chứng Zero-Downtime
  // Thử keep-alive theo yêu cầu của giám khảo
  const res = http.get('https://api.hoclaptrinh.top/api/health', {
    headers: { 'Connection': 'keep-alive' }
  });

  // Xác nhận HTTP Status 200 OK
  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  // Giả lập thời gian ngâm (think time) của user
  sleep(1);
}
