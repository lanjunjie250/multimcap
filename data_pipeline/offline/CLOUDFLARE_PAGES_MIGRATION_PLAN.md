# RTCamera Offline Player：迁移到 Cloudflare Pages 的可执行方案

日期：2026-10-14；更新：2026-10-15

目标：把播放器的网页代码发布到 Cloudflare Pages（使用 `pages.dev` 入口），让用户在浏览器中直接打开本地 `.mcap` 文件；录制文件、解析过程、视频帧和手部检测数据都留在用户设备上，不通过服务器上传。

本方案以当前 `data_pipeline/offline/rtcamera_offline/` 为基础，保留现有界面和播放交互，逐步替换 Python HTTP API。第一版先支持单个 `.mcap`，确认大文件、本地解析和六路回放稳定后，再接入 `.zip` 和分段录像。

## 试用版落实状态（2026-10-15）

首轮试用按 **Cloudflare Pages Direct Upload，本地构建并手动上传**准备。用户随后通过 Cloudflare Workers 发布了[在线试用站点](https://bitter-fog-bed8.lanjunjiezj.workers.dev/)。

后续 GitHub 自动部署的准备配置已补充为 Workers Builds：`web_pages/wrangler.json`，部署命名已确定：Worker 为 `multimcap`，账号子域名由 `lanjunjiezj` 改为 `rtcamera`，目标地址为 `https://multimcap.rtcamera.workers.dev/`。详见 [GitHub 自动部署说明](../../web_pages/README.md#github-自动部署到-cloudflare-workers)。源码已推送至 GitHub 仓库 `lanjunjie250/multimcap` 的 `main` 分支；Cloudflare 尚未绑定该仓库，也未修改线上账号子域名、重命名 Worker 或发布到新地址。

- 新入口和操作说明：[web_pages/README.md](../../web_pages/README.md)。
- 验证记录：[web_pages/VERIFICATION.md](../../web_pages/VERIFICATION.md)。
- 发布包：`web_pages/release/rtcamera-pages-trial.zip`，解压后的站点为 `web_pages/dist/`。
- 已实现本地 Worker 顺序索引、未压缩 MCAP 视频和传感器解析、WebCodecs 多路播放；固定版本手部模型随站点打包。
- 为便于本地试用，首版使用零 npm 依赖的静态构建脚本，复用原分析模块和 CSS，暂不引入 Vite 和 MCAP npm 依赖。解析保持 MCAP 格式和现有业务语义，后续按性能/压缩格式需求再评估替换。
- 试用版统一采用本地顺序扫描建索引，不宣称通过 Summary 即可得到完整视频关键帧和 SBR2 索引；按需 Summary 快速路径属于后续优化。
- ZIP、分段会话、压缩 Chunk、GB 级性能、Pages HTTPS 资源路径和手部检测完整实机验收仍按后续阶段推进。

下文保留原 Cloudflare Pages 迁移路线；当前线上站点和 GitHub 自动部署准备以本节及 `web_pages/README.md` 为准。Vite、Summary 快速路径和后续格式支持仍属于待实施计划。

## 1. 迁移后的边界

### 保留的功能

- 六路视频网格、单路聚焦、全屏和录屏展示。
- 播放、暂停、倍速、拖动、逐帧和时间轴缩放。
- MCAP `publish_time` 纳秒显示、传感器时间戳、同步帧 ID 和当前同帧偏差。
- WebCodecs 解码优先、浏览器不支持时给出明确提示。
- MediaPipe 手部关键点、Worker 调度、GPU/CPU 回退、seek 后丢弃旧结果。
- `frame_key = recording_id + stream_id + frame_index` 的显示帧身份约束。

### 第一版暂不迁移

- 服务器文件浏览：`/api/files`、`/api/open`。
- 云端上传：`/api/upload`。
- Python/OpenCV JPEG 解码回退。
- 浏览器中调用项目的 C++ `mcap_merge`。
- “下载合并 MCAP”：浏览器不能直接复用当前服务端合并器。

这意味着 Pages 版本的主入口是“打开本机文件”。旧 Python 服务继续保留，作为完整 ZIP、H.265 不兼容浏览器和诊断工具的本地后端。

## 2. 目标目录

新增一个独立的 Pages 静态站点目录，避免把 Python 包数据目录直接当成发布目录：

```text
web_pages/
  index.html
  player.css
  player.js
  mcap/
    reader.js              # 文件末尾/Footer、Summary、Chunk Index 读取
    readable.js            # File.slice() 的按需 IReadable 适配器
    records.js             # Schema、Channel、Message、Chunk、SBR2 解析
    video.js               # CompressedVideo/CompressedImage payload 解析
    metadata.js            # stream metadata、sensor stream、alignment
    zip.js                 # 第二阶段：ZIP/segments.json
  analysis/
    alignment.js           # 复用现有实现
    continuity.js           # 复用现有实现
    motion.js               # 复用现有实现
    overlay.js              # 复用现有实现
    scheduler.js            # 复用现有实现
    hand_landmarks.worker.js
  assets/
    vision_bundle.mjs
    wasm/...
    hand_landmarker.task
    LICENSE
  _headers                # MIME、缓存和安全响应头
  _redirects              # 单页入口回退（如需要）
  package.json
  package-lock.json
  vite.config.js           # 使用 Vite；输出 dist/
```

迁移完成后，`web_pages/dist/` 才是 Pages 的发布目录。原来的 Python 资源仍由 `rtcamera_offline` 使用，不直接删除。

## 3. 建议技术选型

- 构建：Vite + 原生 JavaScript/TypeScript；不引入 React，先保持现有 DOM 和 CSS。
- MCAP：优先使用 Foxglove 官方 TypeScript MCAP 包；若其默认索引模型无法表达本项目的 SBR2 元数据，则保留项目自有解析器，并只复用其 MCAP record 读取基础。
- 文件读取：`File` / `Blob.slice()`，每次读取有限大小的 `ArrayBuffer`。不得调用 `file.arrayBuffer()` 读取整个录像。
- 解压：第一版只接受未压缩 Chunk；第二阶段增加 `@mcap/support` 的 zstd/lz4 handler，并为压缩块设置大小上限。
- 视频：复用现有 WebCodecs `VideoDecoder` 路径，packet 数据直接来自 File slice；不在浏览器端生成整段临时视频文件。
- 手部检测：复用 `web/analysis/`，将绝对 URL 改成相对 URL，保证 Pages 的 preview 分支也能加载资源。
- 部署：本地打包后使用 Cloudflare Pages Direct Upload；试用入口为 `<project>.pages.dev`。

## 4. 关键数据流

```text
<input type=file>
      │
      ▼
LocalFileSession(File)
      │ 只读 slice(offset, length)
      ▼
Footer → Summary Offset → Chunk Index / Statistics
      │
      ├─ 有索引：按 chunk offset 定位时间范围
      └─ 无索引：后台顺序扫描，逐步建立本地索引
      │
      ▼
项目 MCAP 适配层：Schema / Channel / SBR2 / video payload
      │
      ▼
统一 recording metadata
      │
      ├─ StreamPlayer → WebCodecs → Canvas
      ├─ sensor timeline
      └─ HandScheduler → Worker → overlay canvas
```

浏览器端 `recording_id` 使用随机 UUID；`generation` 在打开新文件、seek、切换相机和关闭检测时递增。所有异步读取完成后必须检查 generation，过期结果直接释放并丢弃。

## 5. 分阶段实施

### P0：建立前端工程和部署空壳

工作：

1. 建 `web_pages/`、`package.json`、Vite 配置和 `dist/` 构建脚本。
2. 把 `index.html`、`player.css`、`player.js` 和 `web/analysis/` 复制到新目录，先只修正资源路径。
3. 把 `assets.json` 中的固定资源复制到 `web_pages/assets/`，保留 SHA-256 清单和许可证。
4. 在本地构建试用包；Pages 账号中的新建项目和实际上传由用户在控制台操作。
5. 在中国大陆电信、联通、移动网络各测试一次 `https://<project>.pages.dev/`、WASM 和模型下载。

完成条件：

- `npm run build` 退出码为 0。
- `dist/index.html`、`dist/player.js`、WASM 和模型均能加载。
- 关闭代理时页面仍可访问；若不同运营商结果不同，记录域名和时间，不把单次成功当作稳定性保证。

### P1：本地 FileReadable 与 MCAP 尾部读取

新增 `mcap/readable.js`：

```js
export class FileReadable {
  constructor(file) { this.file = file; }
  async read(offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('invalid offset');
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('invalid length');
    const end = Math.min(this.file.size, offset + length);
    return new Uint8Array(await this.file.slice(offset, end).arrayBuffer());
  }
  get size() { return this.file.size; }
}
```

实际实现可按所选 `@mcap/browser` API 适配，但必须保持“读取范围受控”的接口。

解析顺序：

1. 校验头部和尾部 MCAP magic。
2. 从文件末尾读取 Footer 和 trailing magic。
3. 根据 `summary_start`、`summary_offset_start` 读取 Summary Offset 和 Summary。
4. 优先读取 Statistics、Schema、Channel、Chunk Index。
5. 对无 Summary 或无 Chunk Index 的文件显示“正在建立本地索引”，顺序扫描 Data Section。
6. 对压缩 Chunk 暂时返回可操作错误：“当前版本需要未压缩 Chunk”，不能静默显示空文件。

完成条件：

- 能从本地文件读取文件名、大小、消息数（有 Statistics 时）、Topic、起止时间。
- 不产生网络上传请求；浏览器 Network 面板没有录像 POST 请求。
- 读取 1 GB 测试文件时，JS 堆不随文件大小线性增长；记录索引大小和峰值内存。
- 尾部损坏、Footer 越界、记录长度越界均显示错误并释放当前 session。

### P2：复刻项目的 MCAP 业务索引

把 Python `recording.py` 的业务规则迁移到浏览器模块，不直接把 Python 逻辑逐行翻译：

- `Schema` / `Channel`：建立 `schemaId`、`channelId` 映射。
- 视频 Topic：支持当前 `/compressed` 和 `/video/encoded`。
- payload：支持现有 `foxglove.CompressedVideo` 与项目使用的 compressed video schema。
- H.264：解析 Annex-B NAL，识别 SPS 和 IDR，生成 `avc1.*` codec 字符串。
- H.265：识别随机访问 NAL，生成 H.265 codec family；浏览器不支持时明确提示。
- SBR2 metadata：迁移 `global_frame_sequence`、`sync_pulse_id`、`clock_generation`、`sync_epoch` 和 IMU/encoder descriptor 解析。
- 相机名称：保持 `camera_names.py` 当前 A1/A2/A3、B1/B2/B3、C2、D2 规则；建议将规则写成前端测试 fixture，避免 Python 和 JS 漂移。
- alignment：复用现有 `analysis/alignment.js` 的 BigInt 计算，不使用 Number 保存纳秒时间戳。

统一输出格式保持与当前 `metadata()` 兼容：

```js
{
  recording_id, name, size_bytes, duration,
  streams: [{ id, label, topic, codec, web_codec,
    frame_count, times, timestamps_ns, sequences, frame_ids,
    sync_frame_ids, global_frame_sequences,
    clock_generations, sync_epochs, keyframes }],
  sensor_streams, topics, alignment
}
```

完成条件：

- 同一测试 MCAP 在 Python 版和 Pages 版产生相同的 stream label、frame count、timestamp、frame ID 和 alignment。
- `displayed_alignment` 现有测试继续通过，17 ns 差异不被 Number 舍入。
- 同步 metadata 缺失时不把相同 sequence 当成同步证据。

### P3：替换 `/api/packets` 和 `/api/frame`

把现有 `StreamPlayer` 改为直接调用 `LocalRecording`：

1. 根据索引中的 `data_offset`、`data_length` 调用 `FileReadable.read()`。
2. 组装现有 `RTPK` 等价的内存结构，或直接把 `EncodedVideoChunk` 所需的 Uint8Array 传给解码器。
3. 从目标帧前最近的 keyframe 开始预取；每路只保留有限的 ready frame。
4. `VideoFrame`、`ImageBitmap` 在显示、取消、错误、切换文件时都执行 `close()`。
5. 浏览器不支持 WebCodecs 时，第一版禁止伪装成可用的 JPEG 回退；显示“请使用支持 H.264 WebCodecs 的浏览器”。

完成条件：

- 单路 H.264 能播放、暂停、seek、逐帧。
- 六路 H.264 能同时播放，目标时间前后没有错帧。
- 快速 seek 20 次后，页面没有未处理的旧请求覆盖新画面。
- Network 面板只看到 HTML/JS/WASM/模型请求，没有 `.mcap` 上传请求。

### P4：迁移手部检测

1. 复制现有 `analysis/`，把 `/assets/...` 和 `/analysis/...` 改成站点相对路径。
2. Worker 接收真实 `ImageBitmap`，继续使用 `frame_key`、`generation` 和 `request_id`。
3. 检测结果只绑定实际显示帧，不用当前播放头猜测来源。
4. seek、换文件、关闭检测时清理 Worker、模型、WebGL context 和 bitmap。
5. 对模型缺失、WASM 失败、GPU context lost 提供 CPU 回退或关闭检测选项。

完成条件：

- 现有 `hand_motion.mjs`、`hand_scheduler.mjs`、`hand_continuity.mjs` 通过。
- 浏览器回归覆盖暂停、逐帧、正反向 seek、单路选择、缩放、关闭后迟到结果和模型初始化失败。
- `hand_landmarker.task` 加载失败时普通视频仍可播放。

### P5：ZIP 和分段录像

浏览器 ZIP 支持单独做成 `mcap/zip.js`，不把大 ZIP 全部解压到内存：

1. 读取 ZIP Central Directory。
2. 校验 `session.json`、`segments.json`、路径、相机列表和成员数量。
3. 使用流式/有界解压；每个 MCAP 以 Blob/File 视图或临时 IndexedDB 块保存。
4. 首先支持 `ZIP_STORED`；再增加 `DEFLATE`；zstd/lz4 只在明确有浏览器 handler 后启用。
5. 分段录像仍保持多段索引，不在浏览器中伪造一个完整合并 MCAP。
6. 继续显示每段边界和同步缺口；不提供当前 Python/C++ 的“下载合并 MCAP”。

完成条件：

- 合法单段 ZIP、合法分段 ZIP 能播放。
- 路径穿越、重复文件、缺少相机、未完成 segment、超出大小上限均被拒绝。
- ZIP 解压峰值内存和临时存储有实测记录。

### P6：发布、回归和交付

发布配置建议：

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "node --test test/**/*.test.mjs",
    "deploy": "npm run build && wrangler pages deploy dist --project-name rtcamera-offline"
  }
}
```

以后使用 Git 集成时的参数（当前试用不需要，Direct Upload 项目改用 Git 集成需另建项目）：

- Root directory：`web_pages`
- Build command：`npm ci && npm run build`
- Build output directory：`dist`
- Production branch：`main`
- 不配置 Functions；这是静态站点。

Direct Upload 或 CI 的等价命令：

```bash
cd web_pages
npm ci
npm run build
npx wrangler pages deploy dist --project-name rtcamera-offline
```

发布前检查：

- `dist/` 不包含录制文件、测试样本、源码地图中的敏感路径或未授权模型。
- 站点资源没有单文件超过 Pages 限制；当前模型/WASM 清单逐项检查大小。
- `Content-Type` 正确：`.wasm` 为 `application/wasm`，`.mjs` 为 JavaScript，`.task` 为二进制。
- `_headers` 设置长期缓存给带版本的静态资源，HTML 使用短缓存。
- 通过 Pages preview URL 和 production `pages.dev` URL 各做一次完整浏览器回归。
- 记录中国大陆电信、联通、移动访问结果以及模型加载耗时；结果按日期记录。

## 6. 测试矩阵

### 自动测试

新增 `web_pages/test/`：

- `footer.test.mjs`：Footer、magic、summary offset 边界。
- `records.test.mjs`：Schema、Channel、Chunk、Message 长度校验。
- `sbr2.test.mjs`：v3/v4、descriptor、clock generation、sync epoch。
- `camera_names.test.mjs`：新旧相机名、topic fallback、排序。
- `alignment.test.mjs`：BigInt 纳秒差异、pulse=0、epoch/clock mismatch。
- `generation.test.mjs`：旧异步读取结果不能提交到新文件。
- `zip_security.test.mjs`：路径穿越、重复成员、缺失相机和 segment 状态。

### 浏览器测试

使用 Playwright 或现有 CDP 流程验证：

1. 打开单个 MCAP。
2. 播放/暂停/逐帧/倍速。
3. 快速往返 seek。
4. 六路同步显示和当前同帧偏差。
5. 手部检测开关、单路选择、缩放和模型失败。
6. 打开第二个文件时第一个文件所有 decoder、Worker、bitmap 和索引引用释放。
7. 刷新页面后重新选择文件；断网后在缓存命中时检查静态资源行为。

### 真实样本

至少准备：

- 1 个小型 H.264 MCAP，用于单元测试和 CI。
- 1 个多路、10 秒以上 H.264 MCAP，用于浏览器回归。
- 1 个 1 GB 以上长录制，用于内存/seek 测试。
- 1 个包含 SBR2 v3/v4、IMU、encoder 和丢帧的样本。
- 1 个 H.265 样本，记录目标浏览器是否支持。
- 1 个合法分段 ZIP 和 1 组恶意 ZIP fixture。

真实录像不得提交到 Git；测试脚本从本地环境变量读取路径，例如：

```bash
RTCAMERA_SAMPLE_MCAP=/data/samples/test.mcap npm run test:e2e
```

## 7. 性能和内存验收指标

这些是验收目标，开始 P1 前先用实际样本测基线，不把目标当成已达成事实：

- 解析阶段不把整个文件复制成 ArrayBuffer；单次读取块默认为 1–8 MiB，可按测量调整。
- 关闭检测时，播放帧率相对本地 Python 版下降不超过 5%。
- 六路播放时每路最多保留有限 decoder queue 和 ready frames；缓存大小可在诊断面板查看。
- 随机 seek 的读取量应接近“关键帧到目标帧”的 GOP 大小，不应每次扫描到文件末尾。
- 索引内存、WASM 内存、VideoFrame 数量和 Worker 数量全部有上限或可观测计数。
- 1 GB 和 4 GB 文件分别记录：解析耗时、首次画面耗时、seek P50/P95、JS heap、ArrayBuffer、GPU memory（可得时）和页面崩溃情况。
- 如果浏览器对超大 `Blob.slice()`、WebCodecs 或 WASM 有限制，文档中按浏览器给出明确上限，不宣称支持所有 GB 级文件。

## 8. 风险和处理顺序

| 风险 | 影响 | 处理方式 |
| --- | --- | --- |
| MCAP 没有 Summary/Chunk Index | 首次打开需顺序扫描，不能立即随机定位 | 显示索引进度；首版先支持有索引文件；无索引作为 P1 fallback |
| Chunk 使用 zstd/lz4 | 浏览器无法直接解压 | P1 明确报错；P5 接入官方 handler 并限制解压比 |
| H.265 浏览器不支持 | 无法显示视频 | 检测 `VideoDecoder.isConfigSupported()`，提示使用兼容浏览器或旧 Python 服务 |
| 六路索引占用内存过大 | 页面崩溃 | 使用稀疏索引/TypedArray；测量后限制最大文件或最大帧数 |
| 中国大陆线路不稳定 | 用户打不开或模型加载慢 | 用 `pages.dev` 做入口；静态资源带版本和缓存；必要时提供自定义域名或独立镜像 |
| ZIP 解析安全问题 | 路径穿越或内存耗尽 | 复用现有校验规则，浏览器端重新实现并做恶意 fixture |
| SBR2 解析迁移错误 | 同步帧显示错误 | Python/JS 双实现对照，同一 MCAP 比较 JSON 摘要 |

## 9. 交付顺序和提交建议

按下面顺序拆提交，任何阶段都可回滚：

1. `pages: add static shell and build`。
2. `pages: add bounded FileReadable and footer reader`。
3. `pages: port MCAP metadata and video index`。
4. `pages: play local H264 MCAP with WebCodecs`。
5. `pages: port hand analysis and browser regression`。
6. `pages: add ZIP stored/deflate support`。
7. `pages: add deployment docs and performance report`。

每个提交都必须保留 Python 版可运行；Pages 版通过功能开关或独立入口使用，不在 P1 阶段删除旧 API。

## 10. 第一周执行清单

### 第 1 天

- 建 `web_pages/` 和 Vite 工程。
- 复制界面、CSS、analysis 模块。
- 下载并校验 MediaPipe 资源。
- 建 Pages 项目并部署静态空壳。

### 第 2 天

- 实现 `FileReadable`、Footer、Summary Offset。
- 加 Footer/record 边界测试。
- 在浏览器中显示文件大小和 MCAP 格式诊断。

### 第 3 天

- 实现 Schema、Channel、video payload 和 H.264 keyframe 索引。
- 将 Python 版 metadata 输出保存成 fixture，建立 JS 对照测试。

### 第 4 天

- 接通 WebCodecs 单路播放。
- 完成 seek、逐帧和 generation 取消。
- 验证无 `.mcap` 上传请求。

### 第 5 天

- 接通六路播放、sensor timeline 和 displayed alignment。
- 接入手部 Worker。
- 部署 preview，跑浏览器回归和 1 GB 内存测试。

第 1 周结束时，如果 P1–P3 已通过，才决定是否继续迁移 ZIP；如果本地大文件性能或 H.265 支持不满足要求，保留“Pages 纯前端 + Python 本地服务”双入口，不阻塞现有工具使用。

## 11. 参考资料

- MCAP 格式规范：<https://mcap.dev/spec>
- MCAP 实现和 TypeScript 包：<https://github.com/foxglove/mcap>
- Cloudflare Pages 构建配置：<https://developers.cloudflare.com/pages/configuration/build-configuration/>
- Cloudflare Pages Git 集成：<https://developers.cloudflare.com/pages/get-started/git-integration/>
- Cloudflare Pages Direct Upload：<https://developers.cloudflare.com/pages/get-started/direct-upload/>
- Cloudflare Pages 限制：<https://developers.cloudflare.com/pages/platform/limits/>
- MediaPipe Hand Landmarker：<https://developers.google.com/mediapipe/solutions/vision/hand_landmarker/web_js>
- WebCodecs：<https://www.w3.org/TR/webcodecs/>
