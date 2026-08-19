# Sử dụng image Node.js siêu nhẹ
FROM node:18-alpine

# Thư mục làm việc trong container
WORKDIR /usr/src/app

# Cài đặt Docker CLI & Docker Compose để gọi ngược ra máy Host
RUN apk add --no-cache docker-cli docker-cli-compose

# Copy các file cấu hình package
COPY package*.json ./

# Cài đặt thư viện (chỉ production);
RUN npm install --only=production

# Copy toàn bộ mã nguồn
COPY . .

# Expose cổng Webhook
EXPOSE 9000

CMD ["node", "index.js"]
