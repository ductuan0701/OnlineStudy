# Sử dụng image Node.js siêu nhẹ
FROM node:18-alpine

# Thư mục làm việc trong container
WORKDIR /usr/src/app

# Copy các file cấu hình package
COPY package*.json ./

# Cài đặt thư viện (chỉ production)
RUN npm install --only=production

# Copy toàn bộ mã nguồn
COPY . .

# Expose cổng Webhook
EXPOSE 9000

# Chạy Agent
CMD ["node", "index.js"]
