const axios = require('axios');
const http = require('http');
const express = require('express');

// Cấu hình axios kết nối thẳng vào Docker Unix Socket
const dockerAPI = axios.create({
  baseURL: 'http://localhost', // Bỏ fix cứng version để Docker Daemon tự dùng bản native
  httpAgent: new http.Agent({ socketPath: '/var/run/docker.sock' })
});

// Cấu hình cho Proof of Concept
const IMAGE_NAME = 'nginx:alpine';
const CONTAINER_NAME = 'my-test-nginx';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 1. Pull Image từ Docker Hub
 */
async function pullImage(imageName) {
  console.log(`\n[1] Pulling image: ${imageName} ...`);
  try {
    // Docker trả về stream, ta dùng responseType: 'stream' để lấy log
    const response = await dockerAPI.post(`/images/create?fromImage=${imageName}`, null, {
      responseType: 'stream'
    });
    
    return new Promise((resolve, reject) => {
      response.data.on('data', chunk => {
        // Tắt log dòng này nếu không muốn thấy chi tiết pull (hơi dài)
        // console.log(chunk.toString().trim()); 
      });
      response.data.on('end', () => {
        console.log(`✅ Kéo image ${imageName} thành công!`);
        resolve();
      });
      response.data.on('error', err => reject(err));
    });
  } catch (error) {
    const errorMsg = (error.response && error.response.data) ? error.response.data : error.message;
    console.error('❌ Lỗi khi pull image:', errorMsg);
    throw error;
  }
}

/**
 * 2. Tìm ID của Container cũ dựa vào tên
 */
async function findContainer(name) {
  console.log(`\n[2] Đang tìm container có tên: ${name} ...`);
  try {
    const filters = JSON.stringify({ name: [name] });
    const response = await dockerAPI.get(`/containers/json?all=true&filters=${filters}`);
    const containers = response.data;
    
    if (containers.length > 0) {
      console.log(`🔍 Tìm thấy container cũ: ${containers[0].Id.substring(0, 12)} (State: ${containers[0].State})`);
      return containers[0].Id;
    }
    console.log(`🔍 Không tìm thấy container nào tên ${name}.`);
    return null;
  } catch (error) {
    console.error('❌ Lỗi khi tìm container:', error.message);
    throw error;
  }
}

/**
 * 3. Stop và Remove Container cũ
 */
async function stopAndRemoveContainer(id) {
  try {
    console.log(`\n[3] Đang dừng container ${id.substring(0, 12)} ...`);
    await dockerAPI.post(`/containers/${id}/stop`);
    console.log(`🛑 Đã dừng container.`);
    
    // Đợi một chút để docker dọn dẹp
    await sleep(1000); 

    console.log(`[3] Đang xóa container ${id.substring(0, 12)} ...`);
    await dockerAPI.delete(`/containers/${id}`);
    console.log(`🗑️ Đã xóa container cũ thành công!`);
  } catch (error) {
    // Bỏ qua lỗi nếu container đã bị dừng hoặc không tồn tại
    if (error.response && error.response.status === 304) {
      console.log(`🛑 Container đã ở trạng thái dừng.`);
      console.log(`[3] Đang xóa container ${id.substring(0, 12)} ...`);
      await dockerAPI.delete(`/containers/${id}`);
      console.log(`🗑️ Đã xóa container cũ thành công!`);
    } else {
      console.error('❌ Lỗi khi Stop/Remove container:', error.message);
      throw error;
    }
  }
}

/**
 * 4. Tạo Container mới
 */
async function createContainer(imageName, containerName) {
  console.log(`\n[4] Đang tạo container mới từ image ${imageName} ...`);
  try {
    // Body truyền vào theo chuẩn của Docker Engine API
    const createConfig = {
      Image: imageName,
      HostConfig: {
        PortBindings: {
          "80/tcp": [{ "HostPort": "8088" }] // Map cổng 8088 của máy Host vào cổng 80 của Nginx
        }
      }
    };

    const response = await dockerAPI.post(`/containers/create?name=${containerName}`, createConfig);
    const newContainerId = response.data.Id;
    console.log(`✨ Đã tạo container mới với ID: ${newContainerId.substring(0, 12)}`);
    return newContainerId;
  } catch (error) {
    console.error('❌ Lỗi khi tạo container mới:', error.message);
    throw error;
  }
}

/**
 * 5. Khởi chạy Container mới
 */
async function startContainer(id) {
  console.log(`\n[5] Đang khởi động container ${id.substring(0, 12)} ...`);
  try {
    await dockerAPI.post(`/containers/${id}/start`);
    console.log(`🚀 Khởi động thành công! Website Nginx test đang chạy tại http://localhost:8088`);
  } catch (error) {
    console.error('❌ Lỗi khi khởi động container:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * HÀM MAIN ĐIỀU PHỐI (ORCHESTRATOR)
 */
async function main() {
  console.log("=== BẮT ĐẦU CHƯƠNG TRÌNH DOCKER API INTERACTOR ===");
  try {
    // 1. Pull Image mới nhất
    await pullImage(IMAGE_NAME);

    // 2. Tìm container cũ
    const oldContainerId = await findContainer(CONTAINER_NAME);

    // 3. Nếu có thì xóa đi
    if (oldContainerId) {
      await stopAndRemoveContainer(oldContainerId);
    }

    // 4. Tạo lại container mới
    const newContainerId = await createContainer(IMAGE_NAME, CONTAINER_NAME);

    // 5. Chạy nó lên
    await startContainer(newContainerId);

    console.log("\n=== HOÀN TẤT TRIỂN KHAI THÀNH CÔNG! ===");
  } catch (error) {
    console.error("\n💥 Đã xảy ra lỗi hệ thống, tiến trình bị hủy bỏ.");
  }
}

// Cấu hình Express Webhook
const app = express();
const PORT = process.env.PORT || 9000;
const SECRET_TOKEN = process.env.SECRET_TOKEN || 'my-secret';

app.post('/webhook', async (req, res) => {
  const token = req.query.token;
  if (token !== SECRET_TOKEN) {
    console.log(`[Webhook] ⛔ Bị từ chối truy cập do sai Token!`);
    return res.status(401).send('Unauthorized');
  }

  console.log(`\n[Webhook] 🟢 Nhận được tín hiệu Auto-Deploy hợp lệ!`);
  // Trả về 202 Accepted ngay lập tức để Webhook caller không bị Timeout
  res.status(202).send('Accepted. Deploying in background...');

  // Kích hoạt tiến trình cập nhật ngầm
  await main();
});

// Khởi chạy Agent
app.listen(PORT, () => {
  console.log(`🎧 Docker Webhook Agent đang lắng nghe tại http://0.0.0.0:${PORT}/webhook`);
  console.log(`🔑 Yêu cầu Token bảo mật: ?token=${SECRET_TOKEN}`);
});
