# Stage 1: Build ứng dụng React ra các tài nguyên tĩnh
# Pinned version of node:20-alpine
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
ARG REACT_APP_BASE_URL=/api
ENV REACT_APP_BASE_URL=$REACT_APP_BASE_URL
RUN npm run build

# Stage 2: Phục vụ giao diện bằng Nginx siêu nhẹ
# Pinned version of nginx:alpine
FROM nginx@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752
WORKDIR /usr/share/nginx/html
# Xóa các tệp HTML mặc định của Nginx
RUN rm -rf ./*
# Copy tệp tĩnh từ stage build
COPY --from=builder /app/build ./
# Copy cấu hình Nginx nội bộ cho React Router SPA
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
ENTRYPOINT ["nginx", "-g", "daemon off;"]
