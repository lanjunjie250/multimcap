# RTCamera Offline：离线工具整理、硬件加速与手部关键点计划

日期：2026-09-30。原始设计计划；首版现已实现，当前状态、取舍和待验证项见 [README](README.md) 与 [实施报告](../../debug/offline-hand-landmarks-20260930/REPORT.md)。下文硬件现状为计划时的只读基线。

## 1. 目标与边界

统一离线工具的职责：读取录制 ZIP → 校验和合并 MCAP → 多路图像与传感器时间轴回放 → 可选的手部关键点叠加。

- 产品名称：**RTCamera Offline**；Python 包名：`rtcamera_offline`；算法标识：`hand_landmarks`；界面名称：**手部关键点**。
- 运行位置为本地主机。在线采集、Jetson ISP、录制协议继续由现有在线链路负责。
- 按阶段交付，保留旧入口兼容；不进行全仓库搬迁。
- 首版包含检测开关、多路调度、GPU 路径验证和性能报告；批量关键点导出、姿态写回 MCAP、手势识别、跨相机三维重建不属于首版。

## 2. 已核实的现状

| 现有位置 | 职责与发现 | 后续安排 |
| --- | --- | --- |
| `data_pipeline/tools/mcap_archive.py` | 有界解包，检查 manifest、路径、文件数量、大小等 | 迁入离线包 `archive.py`，保留校验语义 |
| `data_pipeline/tools/mcap_session.py` | 主机分析入口，调用检查器和合并器，生成报告 | 迁入 `session.py`，保留旧 CLI |
| `data_pipeline/tools/mcap_player.py` | MCAP 索引、HTTP、ZIP 导入和 JPEG 回退集中在一个文件 | 按职责拆为 `recording.py`、`server.py`、`decode.py` |
| `data_pipeline/tools/mcap_player.{html,js,css}` | WebCodecs、多路画面、时间轴、传感器时间戳 | 收入独立 `web/`，复用现有交互 |
| `data_pipeline/tools/mcap_merge.cpp`、`mcap_inspect.cpp` | C++ 合并与校验，依赖现有 MCAP 库 | 暂留原位，避免牵动在线构建 |
| `data_pipeline/tools/mcap_play.py` | GStreamer 命令行回放/解码验证 | 保留其独立诊断用途，不与 Web 播放器混为同一入口 |
| `data_pipeline/tests/test_mcap_player.py`、`test_mcap_tools.py` | 当前解析、ZIP、合并和接口回归测试 | 首阶段保留并运行；新增功能测试收于离线目录 |
| `data_pipeline/MCAP_STORAGE.md` | 录制、离线合并、时间轴说明 | 保留格式规范，后续链接到离线使用说明 |

当前性能关注点：

1. WebCodecs 已设置 `hardwareAcceleration: 'prefer-hardware'`，不能把它等同于硬件解码已实测启用。
2. JPEG 回退的 `_restart()` 会从目标关键帧把后续码流一直写到文件末尾；重复向后定位会产生大量重复磁盘写入和解码工作，应改为有界 GOP/顺序解码缓存。
3. ZIP 解包、合并、解析目前在打开请求中同步完成；UI 缺少这些阶段的细分进度与取消机制。
4. MCAP 文件使用 mmap，但帧索引、metadata JSON 和浏览器数组仍随录制长度增长，需要测量长录制内存，而不能宣称整体恒定内存。
5. 前端绘制完 `VideoFrame` 后立即 `close()`。检测必须在关闭前取得自己的受控引用，并携带实际帧身份，不能事后按当前播放头猜帧。
6. 当前 service 固定了旧录制路径、LAN 地址和 8091 端口。新入口以 localhost 为默认，浏览器能力按实际访问方式测试。

## 3. 本机硬件与加速策略

只读探测：Ryzen 7 6800H（8 核/16 线程）、约 22 GiB 系统可见内存、RTX 3060 Mobile / Max-Q、AMD Rembrandt 核显，两块 NVMe（约 477 GiB 和 1.9 TiB）。

**当前 RTX 3060 使用 nouveau；`nvidia-smi` 不在 PATH。尚未验证 CUDA、NVDEC 或浏览器 GPU 推理可用。** 显存容量不根据型号推定。探测时系统已有较多内存占用和 swap 使用，工作池与缓存不能按全部物理内存分配。

原始记录：[`host-inventory.txt`](../../debug/offline-hand-landmarks-20260930/host-inventory.txt)。

| 工作 | 资源安排 | 验证要求 |
| --- | --- | --- |
| ZIP 解包、MCAP 合并 | NVMe 顺序 I/O；必要时对独立文件做有界 CPU 并发 | 测量耗时、吞吐、峰值 RSS、临时磁盘空间；保持同步帧合并规则 |
| 图像解码 | 优先现有 WebCodecs 硬件路径；保留 CPU 兼容路径 | 分 H.264/H.265 实测，记录浏览器媒体诊断与实际 GPU |
| 手部推理 | 首选浏览器 MediaPipe GPU delegate，后台 Worker 执行 | 用固定样本比较 GPU/CPU 延迟，核实所选适配器和负载 |
| 叠加显示 | 独立透明 canvas，由浏览器合成 | 测试尺寸、缩放、单路聚焦与高 DPI 对齐 |

GPU 优先针对真正计算密集的解码和推理。压缩码流合并主要是解析、排序和 I/O，先做性能分析，不为了提高 GPU 占用而把合并改成解码再编码。

实施 P0 需单独完成独显驱动/浏览器能力检查。如需启用 NVIDIA 专有驱动和重启，将其作为独立环境变更步骤安排，不能把安装 Python GPU 包当成驱动准备完成。浏览器可能选到 AMD 核显，必须记录；CPU 回退可用于功能开发，但不能据此宣告独显加速验收通过。

首版优先使用已有浏览器解码出的图像，避免为了推理在 Python 中再解码同一段视频。只有浏览器路线在目标环境不成立、性能不达标或后续需要无界面批处理时，再评估 `ONNX Runtime + CUDA` 后端；该路线还需验证模型转换、前后处理一致性及 CUDA/cuDNN 兼容性，不预设 TensorRT 为首版依赖。

## 4. 目标目录与迁移方式

```text
data_pipeline/
  offline/
    PLAN.md                         # 本计划
    README.md                       # 安装、启动、硬件诊断、使用方法
    pyproject.toml                  # 独立离线包；核心与可选依赖分开
    rtcamera_offline/
      __init__.py
      __main__.py                   # serve / analyze / doctor
      archive.py                    # ZIP 校验与解包
      session.py                    # 检查、合并、阶段任务管理
      recording.py                  # MCAP 索引、帧身份和 packet 读取
      decode.py                     # 服务端兼容解码和有界缓存
      server.py                     # HTTP API、静态资源、会话生命周期
      diagnostics.py                # 主机能力探测
      web/
        index.html
        player.css
        player.js                   # 页面组装和用户操作
        playback.js                 # 多路解码、播放时钟、seek
        timeline.js                 # 时间轴与传感器读数
        analysis/
          scheduler.js              # 调度、世代隔离、资源上限
          hand_landmarks.js         # 模型适配与统一结果结构
          hand_landmarks.worker.js  # 推理运行环境
          overlay.js                # 坐标变换、关键点与骨架绘制
        vendor/                     # 固定版本 JS/WASM 与许可证
    models/
      manifest.json                 # 模型来源、版本、SHA-256、许可证
    scripts/
      fetch_assets.py               # 准备并校验离线运行资源
    tests/
      test_lifecycle.py
      test_decode_cache.py
      hand_landmarks_browser.cjs
  tools/
    mcap_player.py                  # 保留兼容启动入口
    mcap_session.py                 # 保留兼容 CLI
    mcap_archive.py                 # 过渡兼容导入，唯一实现位于新包
    mcap_merge.cpp                  # 继续复用
    mcap_inspect.cpp                # 继续复用
    rtcamera-mcap-player.service    # 兼容服务名，后续更新启动方式
debug/
  offline-hand-landmarks-20260930/   # 本轮主机探测、测试与性能原始证据
```

- 此树为目标结构，不提前生成空模块。先迁移现有逻辑，再拆出本次真实需要的边界。
- 推荐新命令名 `rtcamera-offline`，子命令 `serve`、`analyze`、`doctor`；旧启动方式在迁移期继续可用。
- `tools/` 中的兼容层不复制业务代码。显式处理源码运行和安装运行两种导入路径，不依赖启动工作目录。
- 安装时将 Web 资源作为包数据，模型默认放在主机数据目录（如 `$XDG_DATA_HOME/rtcamera-offline/models`），结果缓存放 `$XDG_CACHE_HOME/rtcamera-offline`；未设置 XDG 变量时采用标准用户目录回退。
- 模型权重、缓存、录制文件和基准原始数据不混入源码。JS/WASM 可随发行包安装，版本、校验和及许可留档；运行时不依赖 CDN，准备好资源后可断网使用。
- 迁移时统一更新 CMake 安装清单、静态资源查找、service 和测试导入；保留旧资源 URL 兼容映射。安装目录下也要验证 `mcap_merge` 的查找，不能继续只依赖源码相对路径。

## 5. 手部检测模块

### 模型与执行

首选 **MediaPipe Hand Landmarker**：每只手 21 个关键点，首版默认最多两只手，可配置。输出关键点、骨架连线和左右手分类；分类分数仅按模型实际提供的含义展示，不伪造逐关键点置信度。单目模型的深度值不作为本项目已标定的三维测量。

模型实例按需加载；推理在 Worker 中执行。先完成 GPU delegate 在目标浏览器和 Worker 中的可行性验证。首个正确性版本采用无跨帧状态的 IMAGE 模式，有界共享实例处理多路帧；性能优化时再考虑按相机独立的 VIDEO 实例。不能让不同相机共享 VIDEO 跟踪状态，也不能让倒退 seek 的时间戳直接进入旧跟踪器。

VIDEO 路径如启用：录制时间保留为纳秒字符串，内部使用局部相对时间；seek/换文件重建跟踪状态。检测时间与 MCAP 时间的映射显式保存，不更改原始消息时间戳。

### 帧身份与数据流

```text
ZIP → 校验/解包 → 原有 C++ 合并器 → merged_output.mcap
                                       ↓
                                  MCAP 帧索引
                                       ↓
                         WebCodecs / JPEG 兼容解码
                                       ↓
                       受控帧引用 + 精确 frame_key
                          ↙                    ↘
                     图像画布            推理调度 → Worker
                          ↖                    ↓
                            同帧关键点透明叠加
```

`frame_key` 至少包含 `recording_id + stream_id + frame_index`，附带 `publish_time_ns`、可用的 `clock_generation/sync_epoch/global_frame_sequence`。请求额外携带 `generation`（打开/seek/开关世代）和 `request_id`。不能只用相机标签、墙钟时间或可能重复的 frame_id 标识帧。

- 结果必须绑定实际解码显示的帧；相对微秒时间不能作为唯一身份，需有 packet 帧序号到解码输出的对应关系。迟到结果可进入对应帧缓存，不能覆盖另一个时刻的画面。
- 在播放预取窗口内提前调度，使用短而有界的帧/结果缓存；每路最多一个待处理任务，总在途数量受限。首先保证选中/可见相机，同时避免其他相机长期饥饿。
- 推理赶不上时跳过未处理任务并展示检测覆盖率；没有同帧结果时不沿用旧骨架。不得通过无限增大队列制造越来越迟的叠加。
- 暂停或单步时补算当前帧并稳定保留结果；向前/向后 seek、换文件、切换开关均丢弃旧世代结果。
- 结果缓存键还包括模型版本及参数摘要；无手结果也缓存。首版使用有界内存 LRU，不先引入全量结果数据库。
- `VideoFrame`/`ImageBitmap` 在成功、取消和错误路径均关闭；模型停用后释放 Worker/GPU 资源。图像输入来自原始帧，不把已经画上骨架的 canvas 再送入算法。
- 打开新录制与正在服务的帧请求之间建立明确的生命周期保护，旧 recording 不能在异步请求仍使用 mmap/decoder 时被关闭。

### 用户操作

- 工具栏新增“手部关键点”总开关，默认关闭；高级项提供相机选择、最多手数和检测质量/频率设置。
- 开启时按需加载资源并显示加载/运行状态；关闭立即清除叠加、停止提交任务并释放算法资源。
- 画面上只叠加关键点与连线，左右手用不同颜色；底图与叠加层共享裁剪、缩放、旋转/镜像变换。左右手含义用非镜像样本核验。
- 时间轴播放、拖动、倍速、逐帧与单路聚焦继续可用。首版无需额外增加“检测结果时间轴”。
- 页面显示检测速率、推理耗时、正在分析/无手/错误等必要状态；硬件与后端细节集中在诊断面板。
- 模型缺失、初始化失败或 GPU 上下文丢失时给出明确状态，允许 CPU 降级或关闭算法，普通回放继续可用。
- 合并输出保留原始录制内容，关键点作为派生显示结果；首版不烧录进视频，不添加姿态 topic。

## 6. 分阶段实施与验收

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| P0：基线与 GPU 可行性 | 固定实际 ZIP/MCAP 样本；测单路/六路导入、回放、seek；验证双 GPU、浏览器解码和 Worker GPU 推理；必要时单独完成独显驱动环境准备 | CPU/GPU 实际路径和基线报告齐全；若仅有 CPU 回退，GPU 项明确未完成 |
| P1：结构整理 | 建离线包与兼容入口；分离后端/Web 职责；整理安装、资源、运行目录和说明 | 原有 `test_mcap_player.py`、`test_mcap_tools.py` 及源码/安装启动检查通过；ZIP、MCAP、下载和时间轴行为一致 |
| P2：功能接入 | Worker、帧协议、检测开关、模型本地资源、透明叠加、暂停/seek/错误处理 | 单路和多路正确叠加；无手清空；关闭无推理；回退路径同样正确；断网运行 |
| P3：性能优化 | 同帧预取、调度和缓存；改造 JPEG 重复写整段码流问题；导入后台任务与阶段进度；按证据选择有限并发 | 与 P0 同样样本对比；队列、显存、RSS 有上限；性能收益可复现；独显使用有实测证据 |
| P4：回归与交付 | 长录制、快速拖动、循环切换、两种编码、资源缺失和 GPU 失败测试；更新离线使用文档 | 功能回归和性能报告完成；已知限制有记录；另一个智能体的在线改动保持完整 |

建议性能预算（P0 测量后冻结，不作为已达到的承诺）：

- 关闭检测时，回放帧率相对基线下降不超过 5%；未触发模型推理与持续 GPU 计算。
- 开启检测时，UI 操作响应 P95 小于 100 ms，播放帧率相对基线下降目标不超过 10%；不足时调整分析频率/画面范围并明确报告覆盖率。
- 暂停帧在模型预热后，关键点出现延迟 P95 目标小于 200 ms；显示帧与检测帧身份匹配率必须为 100%。
- 报告单路与六路每路解码/显示/检测 FPS、推理 P50/P95、结果命中率、跳过任务数、seek P95、CPU/GPU 利用率、显存/RSS 和临时空间峰值。不能只汇总六路 FPS 掩盖某一路饥饿。
- 至少连续回放 30 分钟并检查内存稳定性；用已有长录制做随机定位，确认定位 I/O 不再与“到文件末尾的剩余长度”成比例。
- 精度使用包含单手、双手、左右手、遮挡、快速运动、小手目标和无手的真实录制片段验收。现有历史样本是否包含这些场景尚未确认；不足时明确列出所缺样本。
- 自动化重点覆盖异步错帧、开关取消、资源释放、坐标变换、ZIP 安全边界和合并同步不变量；真实模型效果与硬件加速另做浏览器实测，不能用 mock 测试替代。

## 7. 与在线工作的协作边界

勘察时在线相关未提交改动包括 `data_pipeline/src/preview_frames.hpp`、`rtcamera_pipeline.cpp`、`tools/rtisp_preview.py`，以及新建 `live_preview_output.hpp`、`persistent_recorder.hpp`。本计划不修改这些文件。

实施主要落在 `data_pipeline/offline/`，按阶段调整旧离线入口。`data_pipeline/CMakeLists.txt`、`MCAP_STORAGE.md` 和服务配置属于潜在共享文件，每次修改前重新检查工作区最新差异，只改离线相关段落。保留现有 ZIP manifest 与同步字段兼容性，不要求在线智能体为手部检测修改录制协议。

## 8. 选型依据

- [Google Hand Landmarker 说明](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)：手部关键点任务与模型。
- [Google 官方 Worker 示例](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/workers/hand-landmarker.worker.ts)：Worker 中创建 GPU/CPU delegate，区分 IMAGE/VIDEO 输入并管理 bitmap。
- [W3C WebCodecs](https://www.w3.org/TR/webcodecs/)：`prefer-hardware` 是偏好提示，不能单独作为硬件加速证明。
- [ONNX Runtime CUDA Execution Provider](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)：后续原生 GPU 后端的依赖与兼容性依据。

上述为选型依据。固定库/模型版本、目标浏览器可用性和实际加速效果在 P0 形成记录后再确定。
