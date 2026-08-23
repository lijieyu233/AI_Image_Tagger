# 图库 · AI Image Tagger

本地相册识图分类（电脑端）。把手机里一堆图变成「自动打标 + 按标签筛选」的本地图库。

技术栈：**Electron + Node 24（内置 SQLite）+ Vue3 + CLIP（本地推理）**。原图不搬家，软件只建索引 + 缩略图。全程可离线，隐私不出本机。

方案文档见 [docs/](./docs/00-方案总览.md)。

## 已实现

- 导入：扫描目录、sha256 + 感知哈希去重、EXIF（拍摄时间/机型/GPS）、规则标（截图/微信/全景/来源目录）、缩略图。
- **HEIC 解码**：iPhone 照片直接入库出缩略图（无需先转 JPG）。
- **CLIP 内容打标**：本地零样本模型对词表打标（猫/风景/夜景…），带置信度；低于阈值进「待确认」。默认走 hf-mirror.com 镜像，模型缓存到 `data/models`。
- **反馈阈值**：人手驳回过某标签，自动抬高它的打标阈值（越驳回越严格）。
- 数据库：SQLite（WAL），`photos / tags / photo_tags / feedback / jobs` 五表，词表 `config/tags.json` 可改（含每个标签的英文 CLIP 提示句）。
- 查看器：标签树 + 智能相册（收件箱/未分类/待确认/重复/可能证件）、AND/OR 筛选、网格、灯箱、加/删标签、快捷键。
- 脚本：`adb_pull.ps1`（Android 一键拉相册）、`run.ps1`（一键启动）。
- Electron 外壳 + electron-builder 打包配置（`npm run dist`）。

## 运行

```powershell
npm install                       # 首次

npm run build:web                 # 构建前端
npm start                         # 方式一：浏览器 http://127.0.0.1:47910
npm run electron                  # 方式二：Electron 桌面窗口
powershell -File scripts\run.ps1  # 方式三：一键脚本
```

导入后点「自动打标 (CLIP)」即可本地推理打标。首次会下载 CLIP 模型（约 150MB，走镜像），之后离线可用。

## 打包成桌面应用（exe）

```powershell
# 1. 准备运行时：内置 Node + 后端依赖（独立目录，避免和构建工具混在一起）
Copy-Item "C:\Program Files\nodejs\node.exe" runtime\node.exe
npm install --prefix runtime

# 2. 构建前端 + 打包
npm run build:web
npm run dist        # 生成解包版 release/win-unpacked/（快，可先验证）
npm run dist:win    # 生成安装包 release/*.exe（nsis）
```

打包产物结构：`resources/` 内自带 `node/node.exe`、`node_modules/`、`backend/`、`config/`、`web/dist/`，数据存到 `%APPDATA%/AI Image Tagger/data`。开发态则用系统 Node 跑 `backend/`。

> 注：打包脚本在终端直接 `npm run dist` 即可；若在某些把 `node` 包装成 Electron 的环境里跑（会设 `ELECTRON_RUN_AS_NODE=1`），需用真实 node.exe 执行：`& "C:\Program Files\nodejs\node.exe" node_modules\electron-builder\cli.js --dir`。

## 目录结构

```
backend/src/   Node 后端（导入、DB、CLIP 打标、HTTP API）
web/           Vue3 查看器（Vite 构建到 web/dist）
electron/      Electron 外壳（main.cjs）
config/tags.json  受控词表 + CLIP 提示句（改文件即可加词）
scripts/       adb_pull.ps1 / run.ps1
runtime/       node.exe（打包用，npm run dist 前复制）
data/          library.db + thumbs/ + inbox/ + models/（运行时生成）
```

## API 摘要

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v1/import` | 扫目录入库（完成后自动触发 CLIP 打标） |
| POST | `/v1/tag` | 对未打标图片跑 CLIP |
| GET | `/v1/photos` | 筛选（tags、op=and/or、smart=...） |
| GET | `/v1/photos/{id}` | 单图 + 标签 + 近似重复 |
| PUT | `/v1/photos/{id}/tags` | 人手增删标签 |
| GET | `/v1/tags` / `/v1/stats` | 词表计数 / 概览 |
| GET | `/v1/thumbs/{id}` / `/v1/files/{id}` | 缩略图 / 原图 |
| POST | `/v1/export` | 当前筛选复制到目标目录 |

## 说明与边界

- 打标阈值在 `config/tags.json` 的 `threshold`（默认 0.24），可调。
- 文档类标签（身份证/发票等）默认不送任何云端，只走本地 CLIP + 人手。
- 难例 VLM（百炼 Qwen-VL）为可选项，需 `DASHSCOPE_API_KEY`，本版未接（纯本地已够用）。
- 人脸实名默认不做（涉及隐私），第一期只做人脸簇。
- 完全相同文件（sha256 相同）不重复入库；近似重复（phash 相近）进「重复」相册。
