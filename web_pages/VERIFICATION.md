# Pages 试用版验证记录

日期：2026-10-15。此记录区分代码/本地验证与实际云端部署。首轮代码验证没有登录 Cloudflare、没有发布站点、没有上传录像到外部服务器。用户随后提供了已自行部署的 Workers 试用站点；以下单列本轮配置验证。

## GitHub 自动部署配置验证（2026-10-15）

- 用户提供的[现有 Workers 试用地址](https://bitter-fog-bed8.lanjunjiezj.workers.dev/)返回播放器 HTML；此项仅验证入口响应，不等同于完整云端功能回归。
- `npm run build:cloudflare` 通过：7 项固定资源校验、9 项解析测试、23 个静态文件构建。
- `wrangler.json` 指向有效的 `dist/`，包含首页和 404 页；Worker 目标名已更新为 `multimcap`，目标账号子域名为 `rtcamera`。
- 本轮构建产物与原 Direct Upload ZIP 逐文件一致。README、构建入口和部署配置未改变播放器发布内容。
- Cloudflare 部署说明固定 Wrangler 4.151.0，并要求 Node.js 22+；本机 Node.js 20 仅用于构建验证，未运行 Wrangler 云端部署。
- 尚未连接 GitHub 仓库、修改线上账号子域名、重命名线上 Worker 或发布到目标地址 `https://multimcap.rtcamera.workers.dev/`。

## 解析和文件读取

- `node test/recording.test.mjs`：9 项通过。
- 覆盖有界读取、缓存、关闭后读取拒绝、越界、标准 Footer 检查、未压缩 Chunk 内的绝对偏移、压缩 Chunk 明确拒绝、索引数量上限。
- 覆盖旧相机名映射、超过 Number 精度范围的纳秒时间戳、17 ns 跨相机差异、pulse=0、缺少同步元数据、clock generation/epoch 不同。
- 覆盖导入取消后 Worker 终止、已取消请求拒绝。
- 原项目的 `displayed_alignment.mjs`、`hand_scheduler.mjs`、`hand_continuity.mjs`、`hand_motion.mjs` 均通过。

## 与旧 Python 版对照

使用本机已有真实样本，样本路径和解析 JSON 仅保留在本机/临时目录，不进入发布包。

| 样本 | 大小 | 视频 | 帧数 | 消息数 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 已合并单段 MCAP | 17,613,804 B | 六路 H.265，A1/A2/A3/B1/B2/B3 | 每路 185 | 4,688 | 对照通过 |
| 独立相机 MCAP | 5,287,193 B | 一路 H.265，A1 | 290 | 2,515 | 对照通过 |

逐项比较了相机名称、Topic、编码、帧数、相对时间、原始 publish/log 纳秒时间戳、sequence、frame ID、同步 ID、clock generation、sync epoch、关键帧和 gap 索引；传感器按 source/Topic 对照。每路首帧实际码流的 SHA-256 与 Python mmap 提取结果一致。

六路样本有 185 个公共同步帧，时间戳跨度均为 17 ns。此数值是该样本的录制时间戳跨度，不代表曝光同步精度或绝对时钟精度。

Node 环境本次解析耗时约 0.10 秒（六路）和 0.05 秒（单路），仅供本机参考，不是浏览器或其他设备的性能保证。

## 浏览器验证

当前执行环境禁止终端监听 HTTP 端口，因此使用临时的 `file://` 测试页：内嵌 ES module/Worker 源码，避免文件协议的模块跨域限制。它复用了试用版的业务代码，但改变了模块装载方式，不能替代正式 HTTP/HTTPS 的资源路径验收。临时测试页放在 `.cache/`，不打包发布。

在 Chrome 中使用上述六路真实 H.265 样本验证：

- WebCodecs 能实际解码六路，每路画布 1600×1300。
- 最终构建的首屏定位到首组视频帧，六路均显示索引 0、同帧跨度 17 ns，避免传感器起始时间早于视频时首屏一直等待。
- 连续提交 20 次快速定位后，最后目标约 3.1 秒；六路均显示索引 91，当前同帧跨度 17 ns。
- 下一帧索引 92，再上一帧回到 91。
- 播放约 1.2 秒后暂停，六路推进到索引 126。
- 单路聚焦时只有一路可见；恢复后多路布局可用。
- 图像缩放后，底图和 overlay 使用一致的 `scale(1.25)`。
- 上述检查没有视频解码错误。

手部检测完整运行、模型失败回退和 HTTP/Pages 路径尚未在试用版环境完成实机验收；相关源码和固定版本资源已接入构建，不据此宣称功能已全部验收。

## 发布包

- 共 23 个发布文件，ZIP 大小 12,638,325 B；最大单文件 11,453,626 B。
- HTML/JS/Worker/CSS 与 7 个固定版本模型/JS/WASM/许可证资源一同打包。
- ZIP CRC、根目录、归档文件与 `dist/` 逐字节一致性、模块相对路径均通过检查。
- 7 个资源均与原 `assets.json` 中的大小和 SHA-256 一致。
- 发布 ZIP 的根目录是 `index.html`；不包含 MCAP、原始录制 ZIP、测试数据、Python 后端、开发脚本或临时测试页。
- 页面读取录像的代码没有 HTTP API、XHR、`fetch` 或录像上传接口；模型加载仍会发出对站点静态资源的 GET 请求。

## 待完成

- 在自己的 Pages Direct Upload 项目部署，并验证所有脚本、Worker、WASM 和模型 URL。
- 在该 HTTPS 站点验证手部检测及模型失败回退。
- 完整的新文件切换、取消、检测开关、GPU 上下文失败浏览器回归。
- 1/4 GB 文件内存、定位延迟与 30 分钟连续播放。
- 中国大陆电信、联通、移动线路访问实测。
