const path = require('path');

const PORT = process.env.PORT || 9000;
const SECRET_TOKEN = process.env.SECRET_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const PROJECT_DIR = '/root/online-study';
const DB_FILE = path.join(PROJECT_DIR, 'docker-interactor', 'deployments.json');

if (!SECRET_TOKEN) {
  console.error("🚨 LỖI BẢO MẬT: Bạn chưa cấu hình biến môi trường SECRET_TOKEN trong file .env!");
  process.exit(1);
}

module.exports = {
  PORT, SECRET_TOKEN, SLACK_WEBHOOK_URL, PROJECT_DIR, DB_FILE
};
