# Stage 1: Build ứng dụng React ra các tài nguyên tĩnh
# Pinned version of node:20-alpine
FROM node@sha256:4a0224d081efb09fdd3f5dd1702f1ba8f7850228bb988a20caec572cf9f14db4 AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
ARG REACT_APP_BASE_URL=/api
ENV REACT_APP_BASE_URL=$REACT_APP_BASE_URL
RUN npm run build

# Stage 2: Phục vụ giao diện bằng Nginx siêu nhẹ
# Pinned version of nginx:alpine
FROM nginx@sha256:4c0fdaa8b6341bfdeca5f18f7837462c80cff90527ee35ef185571e1c327beac
WORKDIR /usr/share/nginx/html
# Xóa các tệp HTML mặc định của Nginx
RUN rm -rf ./*
# Copy tệp tĩnh từ stage build
COPY --from=builder /app/build ./
# Copy cấu hình Nginx nội bộ cho React Router SPA
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
ENTRYPOINT ["nginx", "-g", "daemon off;"]
