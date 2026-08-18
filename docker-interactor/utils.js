const util = require('util');
const { execFile } = require('child_process');
const runCmd = util.promisify(execFile);
const { SLACK_WEBHOOK_URL } = require('./config');

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

module.exports = {
  runCmd, sendSlackAlert
};
