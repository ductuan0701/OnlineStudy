import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 5000 },
    { duration: '3m', target: 5000 },
    { duration: '30s', target: 0 },
  ],
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(95)', 'p(99)', 'count'],
  thresholds: {
    http_req_duration: ['p(50)<200', 'p(95)<500', 'p(99)<800'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    dropped_iterations: ['count>=0'],
  },
};

export default function () {
  // Kịch bản 3: Người dùng vẫn truy cập ứng dụng bình thường (Happy Path cho người dùng)
  const res = http.get('https://api.hoclaptrinh.top/api/actuator/health', {
    headers: { 'Connection': 'keep-alive' }
  });
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
  sleep(1);
}
