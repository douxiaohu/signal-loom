# 第三方许可与归属

项目自身的代码和文档采用根目录 [MIT 许可证](LICENSE)，许可文本也随前端发布到 [`/licenses/signal-loom-MIT.txt`](frontend/public/licenses/signal-loom-MIT.txt)。第三方代码、字体及依赖继续适用各自的原始许可，项目 MIT 许可证不替代这些许可。

## delineate

- 上游：[appautomaton/delineate](https://github.com/appautomaton/delineate)
- Copyright (c) 2026 appautomaton
- 许可：MIT
- 本项目使用：Assembly 手部动画引擎及样式、Climate Garden 植物绘图、Alfama 风景绘图及样式。
- 原始许可：[源码许可](frontend/src/vendor/delineate/LICENSE)与[可分发插画许可](frontend/public/artwork/LICENSE-delineate.txt)。
- 改动和文件对应关系见[集成说明](frontend/src/vendor/delineate/README.md)。

## Geist 字体

- 上游：[vercel/geist-font](https://github.com/vercel/geist-font)，由 `@fontsource-variable/geist` 提供。
- Copyright 2024 The Geist Project Authors
- 许可：SIL Open Font License 1.1（OFL-1.1）。字体本身不改为 MIT。
- 原始许可随前端静态资源发布：[geist-OFL-1.1.txt](frontend/public/licenses/geist-OFL-1.1.txt)，部署后可通过 `/licenses/geist-OFL-1.1.txt` 获取。

## 分享二维码

- `qrcode`（[soldair/node-qrcode](https://github.com/soldair/node-qrcode)），MIT，用于在本机生成分享二维码。
- 浏览器实现依赖 `dijkstrajs`，保留其 MIT 许可。
- 原始许可随前端分发：[qrcode-MIT.txt](frontend/public/licenses/qrcode-MIT.txt)与[dijkstrajs-MIT.txt](frontend/public/licenses/dijkstrajs-MIT.txt)。不调用外部二维码服务，不上传消息内容。

## 包管理器依赖

构建与测试依赖 picomatch 使用本地安全修补副本（上游 4.0.7，MIT），原始版权与[许可](frontend/vendor/picomatch/LICENSE)保留。来源、补丁范围及恢复上游的条件见[副本说明](frontend/vendor/picomatch/README.md)。该副本不随浏览器或 Go 运行时分发。

依赖版本由 [`go.mod`](go.mod)、[`go.sum`](go.sum)、[`frontend/package.json`](frontend/package.json)和 [`frontend/package-lock.json`](frontend/package-lock.json)记录。每个依赖保留其包内的版权与许可声明。

前端直接依赖的许可包括 MIT（React、React DOM、Radix Slot、Tailwind CSS、clsx）、Apache-2.0（class-variance-authority）、ISC（Lucide）和 OFL-1.1（Geist）。本文件说明直接复用的代码与资源，不是所有传递依赖的法律审查报告。

## 频道内容与导出图片

Telegram 频道的文字、图片、视频，以及用户导出的包含这些内容的分享卡片，可能包含第三方作品。这些内容的权利归原权利人所有，不因项目代码使用 MIT 许可证而变更。
