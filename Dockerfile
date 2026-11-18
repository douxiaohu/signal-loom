# 声明在第一个 FROM 之前的 ARG 才能用在后面各阶段的 FROM 里。
# go.mod 要求 Go 1.27.4+（依赖项的最低版本），所以构建镜像必须与之匹配；
# 镜像标签拉取失败时可用 --build-arg GO_VERSION=<可用的更新版本> 覆盖。
ARG GO_VERSION=1.27.4

# Stage 1: 构建 React 19 前端
FROM node:22-alpine AS frontend-builder
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/vendor/picomatch ./vendor/picomatch
RUN npm ci
COPY frontend ./
RUN npm run build

# Stage 2: 编译 Go 二进制服务
# GOTOOLCHAIN=local：版本不够就直接失败，而不是在构建时临时下载工具链。
FROM golang:${GO_VERSION}-alpine AS go-builder
WORKDIR /build
ENV GOTOOLCHAIN=local

# 缓存依赖层
COPY go.mod go.sum ./
RUN go mod download && go mod verify

# 复制 Go 源码并编译
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o telegram-radar ./cmd/server

# Stage 3: 最小化轻量运行时 (Alpine 极简镜像)
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

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["/app/telegram-radar"]
