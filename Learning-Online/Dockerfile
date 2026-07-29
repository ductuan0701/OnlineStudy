# Stage 1: Build ứng dụng React ra các tài nguyên tĩnh
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
ARG REACT_APP_BASE_URL=/api
ENV REACT_APP_BASE_URL=$REACT_APP_BASE_URL
RUN npm run build

# Stage 2: Phục vụ giao diện bằng Nginx siêu nhẹ
FROM nginx:alpine
WORKDIR /usr/share/nginx/html
# Xóa các tệp HTML mặc định của Nginx
RUN rm -rf ./*
# Copy tệp tĩnh từ stage build
COPY --from=builder /app/build ./
# Copy cấu hình Nginx nội bộ cho React Router SPA
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
ENTRYPOINT ["nginx", "-g", "daemon off;"]
