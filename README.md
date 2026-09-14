# 图库 · AI Image Tagger

本地相册识图分类（电脑端）。把手机里一堆图变成「自动打标 + 按标签筛选」的本地图库。

技术栈：**Electron + Node 24（内置 SQLite）+ Vue3 + CLIP（本地推理）**。原图不搬家，软件只建索引 + 缩略图。全程可离线，隐私不出本机。

方案文档见 [docs/](./docs/00-方案总览.md)。

## 已实现

- 导入：扫描目录、sha256 + 感知哈希去重、EXIF（拍摄时间/机型/GPS）、规则标（截图/微信/全景/来源目录）、缩略图。
- **HEIC 解码**：iPhone 照片直接入库出缩略图（无需先转 JPG）。
- **CLIP 内容打标**：本地零样本模型对词表打标（猫/风景/夜景…），带置信度；低于阈值进「待确认」。默认走 hf-mirror.com 镜像，模型缓存到 `data/models`。
- **反馈阈值**：人手驳回过某标签，自动抬高它的打标阈值（越驳回越严格）。
- **打标决策**（`backend/src/tagging.js` 纯函数）：每组最多 2 个、全图最多 4 个、组内相对 margin 限流；全部略低于阈值时进「待确认」而非静默丢弃；批量跑完按各组分数分布自动校准每组阈值（写入 `config/tags.json`，组内设 `"threshold_manual": true` 可锁定）。提示句支持 prompt ensemble（每标签多句取均值）。
- **分类向导**：点「开始分类」先选范围（只分新图 / 全部重新分）与方式（⚡ 本地快速 / 🧠 AI 增强），跑完出**分类报告**（处理数、标签数、没把握数，一键去把关）。
- **待确认审阅流**：侧栏「模型没把握」进入刷题式审阅——大图 + 建议标签逐个 ✓/✗，键盘 1=全对 2=全不对 →=下一张；认可标签升级为人工确认（保留模型置信度），驳回记反馈并自动抬阈值。
- **可解释性**：缩略图角标 ⚡（本地）/ 🧠（云端）/「?」（有待确认）；灯箱「📊 查看模型 top5 分数」展示候选与各自有效阈值；打标 job 返回命中统计；设置页三档把握要求 + 效果预估。
- **词表组开关**：「标签管理」按组卡片化，每组可停用（模型不再自动打该组）；设置页同款开关。
- **AI 增强（云端 VLM，默认关）**：设置页配置服务商（阿里云百炼 Qwen-VL / OpenAI 兼容）与 API Key（存本机 `data/settings.json`，接口永远掩码返回）；只送「待确认」难例或单图复判，输出仅限词表内标签（禁词扫描），证件/发票组默认不上传（可显式放开）；打 🧠 角标。无 Key 完全不影响本地主路径。
- **网格快捷纠错**：缩略图 hover 出现 👎，勾选错误标签一键移除。
- 数据库：SQLite（WAL），`photos / tags / photo_tags / feedback / jobs` 五表，词表 `config/tags.json` 可改（含每个标签的英文 CLIP 提示句）。
- 查看器：标签树 + 智能相册（新导入/还没分类/模型没把握/疑似重复/证件发票）、AND/OR 筛选、网格、灯箱（置信度显示 + 删除确认）、加/删标签、快捷键。
- 导入三种方式：**文件夹**（弹系统选择器）、**本地文件**（多选上传）、**拖拽**（文件/文件夹拖入主区域）；空库时有三步引导。
- **异步分类 + 进度视图**：点「开始分类」立即返回，后台跑 CLIP，主区域显示进度条与处理计数，可轮询 `jobs` 表。
- **搜索**：按标签名关键字搜索，左侧建议词 + 计数。
- **批量操作**：Ctrl/⌘ 多选，批量加标签 / 导出 / 删除；导出与文件导入收进工具栏「▾」菜单。
- 前端结构：`App.vue`（壳）+ `composables/useLibrary.js`（共享状态）+ `views/`（Home / Progress / Review / Settings / Vocab / Wizard）。
- 脚本：`adb_pull.ps1`（Android 一键拉相册）、`run.ps1`（一键启动）。
- Electron 外壳 + electron-builder 打包配置（`npm run dist`）；后端启动失败/前端未构建会弹窗提示而非白屏。

## 运行

```powershell
npm install                       # 首次

npm run build:web                 # 构建前端
npm start                         # 方式一：浏览器 http://127.0.0.1:47910
npm run electron                  # 方式二：Electron 桌面窗口
powershell -File scripts\run.ps1  # 方式三：一键脚本
```

导入后点「启动分类 (CLIP)」即可本地推理打标。首次会下载 CLIP 模型（约 150MB，走镜像），之后离线可用。

## 回归测试

```powershell
npm test        # Node 24 跑 backend/test（node --test 自动发现 *.test.js）
```

共 29 个用例：18 个服务冒烟（导入/去重/重导入/规则标/筛选/搜索/统计/设置/异步分类与 job 轮询/文件上传/词表增删/导出（含按 ids）/删除，隔离数据目录，不下载模型）+ 11 个打标决策层单测（组内上限/相对 margin/待审兜底/分数窄带防护/互斥/阈值校准/分数统计）。

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
| POST | `/v1/import` | 扫目录入库（仅建索引 + 规则标；CLIP 打标需另点「启动分类」） |
| POST | `/v1/import-files` | 上传本地文件/多文件（multipart）入库 |
| POST | `/v1/tag` | 异步启动 CLIP 打标，立即返回 `{jobId,status}` |
| GET | `/v1/jobs/{id}` | 轮询打标进度 `{id,type,status,total,done,error}` |
| GET | `/v1/photos` | 筛选（tags、op=and/or、smart、q 关键字、from/to） |
| GET | `/v1/photos/{id}` | 单图 + 标签 + 近似重复 |
| PUT | `/v1/photos/{id}/tags` | 人手增删标签 |
| POST | `/v1/tags` | 新增词表标签 |
| DELETE | `/v1/tags/{name}` | 删除词表标签（连带清理关联） |
| GET/PUT | `/v1/settings` | 读取 / 保存阈值等设置 |
| GET | `/v1/tags` / `/v1/stats` | 词表计数 / 概览 |
| GET | `/v1/thumbs/{id}` / `/v1/files/{id}` | 缩略图 / 原图 |
| POST | `/v1/export` | 按筛选或指定 `ids` 复制到目标目录 |
| GET | `/v1/photos/{id}/scores` | 单图模型 top5 候选分数（灯箱可解释性） |
| GET | `/v1/tag-preview` | 阈值效果预估（保留标签/照片数） |
| PUT | `/v1/vocab-group` | 词表组开关（disabled，停用的组不再自动打标） |
| POST | `/v1/photos/{id}/confirm` | 人工确认（keep 升级 manual / remove 驳回） |
| POST | `/v1/photos/{id}/classify-vlm` | 单图 AI 增强复判（云端 VLM） |
| POST | `/v1/tag-vlm` | 批量 AI 增强（scope=review/ids，异步 job） |
| GET/PUT | `/v1/ai-settings` | AI 增强配置（Key 只存本地，返回掩码） |
| POST | `/v1/ai-test` | AI 连通性测试 |

## 说明与边界

- 打标阈值在 `config/tags.json` 的 `threshold`（默认 0.24），可调。
- 文档类标签（身份证/发票等）默认不送任何云端，只走本地 CLIP + 人手。
- 难例 VLM（百炼 Qwen-VL）为可选项，需 `DASHSCOPE_API_KEY`，本版未接（纯本地已够用）。
- 人脸实名默认不做（涉及隐私），第一期只做人脸簇。
- 完全相同文件（sha256 相同）不重复入库；近似重复（phash 相近）进「重复」相册。
