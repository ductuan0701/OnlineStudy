const fs = require('fs');
const { DB_FILE } = require('./config');

const processedDeliveries = new Set();
const MAX_PROCESSED = 1000;

const GlobalState = {
  isDeploying: false,
  deploymentQueue: []
};
//adwdwwa
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

module.exports = {
  processedDeliveries, MAX_PROCESSED, GlobalState, updateDeploymentState
};
/* *Hello World */