# Stage 1: 构建 React 19 前端
FROM node:22-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

# Stage 2: 编译 Go 二进制服务
FROM golang:1.24-alpine AS go-builder
WORKDIR /build
ENV GOTOOLCHAIN=auto

# 缓存依赖层
COPY go.mod go.sum ./
RUN go mod download

# 复制 Go 源码并编译
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o telegram-radar ./cmd/server

# Stage 3: 最小化轻量运行时 (Alpine 极简镜像，约 30MB)
FROM alpine:3.20

ARG APP_UID=1000
ARG APP_GID=1000

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -g ${APP_GID} app \
    && adduser -D -u ${APP_UID} -G app app

WORKDIR /app

# 复制 Go 二进制文件与前端静态构建产物
COPY --from=go-builder /build/telegram-radar /app/telegram-radar
COPY --from=frontend-builder /frontend/dist /app/frontend/dist

RUN mkdir -p /app/data /app/data/media-cache \
    && chown -R app:app /app

USER app

EXPOSE 8000

ENV PORT=8000 \
    APP_ENV=production

CMD ["/app/telegram-radar"]
