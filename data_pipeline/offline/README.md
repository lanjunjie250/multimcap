# RTCamera Offline

本地主机上的 ZIP/MCAP 合并、多路时间轴回放和可选手部关键点检测。在线采集代码仍位于 `data_pipeline/src/` 与 `tools/rtisp_preview*`；本目录只负责离线处理。

## 快速启动

在仓库根目录运行：

```bash
cmake -S data_pipeline -B data_pipeline/build-host -DRTCAMERA_BUILD_PIPELINE=OFF
cmake --build data_pipeline/build-host --target mcap_merge mcap_inspect -j 4
python3 data_pipeline/offline/scripts/rtcamera-offline fetch-assets
python3 data_pipeline/offline/scripts/rtcamera-offline serve --browser
```

页面地址为 `http://127.0.0.1:8090/`。可打开/上传 `.zip` 或 `.mcap`；普通 ZIP 会经过校验、解包、同步合并和索引。分段 ZIP 会校验 `segments.json`，逐段合并并在播放器内建立统一时间轴；多段录制不会伪造一个整 session 的“下载合并 MCAP”，单段 ZIP 仍支持该下载。阶段任务在后台执行，页面显示实际阶段，不伪造百分比。

本次开发时 8090 已有旧播放器及用户上传文件，因此旧会话予以保留；开发时新版运行于 `http://127.0.0.1:8092/`；重启后已由用户服务自动启动于 **`http://127.0.0.1:8090/`**。需要同样端口时，在启动命令中加 `--port 8092`。兼容期保留旧 `tools/mcap_player.{html,js,css}`，供未重启的旧进程继续使用；新入口始终使用 `offline/rtcamera_offline/web/` 的资源。

也可直接指定录制及工作磁盘：

```bash
python3 data_pipeline/offline/scripts/rtcamera-offline serve /path/session.zip \
  --work-dir /path/to/spacious/disk --browser
```

`--root` 可重复设置允许读取的本地目录；`--merger` 可指定 C++ 合并器。临时目录需容纳解包文件和各 segment 的合并输出；退出服务会清除临时文件，请先下载需要保留的合并结果。

分段边界可在主机上单独检查：

```bash
python3 data_pipeline/offline/scripts/rtcamera-offline check-segments /path/session
```

该检查逐路确认首帧是随机访问帧，并报告首帧同步 pulse；它不会修改录制文件。

旧命令继续可用：`python3 data_pipeline/tools/mcap_player.py`、`python3 data_pipeline/tools/mcap_session.py`。

相机名称与 preview 一致，按 A1/A2/A3、B1/B2/B3、Cn、Dn 排序。命名规则集中在 `camera_names.py`：优先读取 MCAP channel 中的相机身份及零基硬件 VC，将旧录制名称统一显示为 VC + 1；没有身份元数据时按当前采集器的 topic 索引映射回退（0–7 对应 A1/A2/A3/B1/B2/B3/C2/D2）。视频、时间轴、IMU/encoder 和检测相机选择使用同一名称。ZIP 同时接受新的一基文件名和旧 A0/B0 等文件名；原始录制内容与合并输出的 topic 不改写。

## 多路画面与全屏

六路画面在横屏自动使用 3×2 网格，窄屏/竖屏使用 2×3，随窗口尺寸重新分配可用高度。点击分析栏右侧“画面全屏”可放大整个多路播放器，保留播放控制、时间轴和检测开关；点击“退出全屏”或按 Esc 返回。图像保持原始比例，关键点叠加同步缩放。时间戳详情默认收起，可用“展开时间戳”或“单独查看时间戳”查看。

## 录屏展示

打开录制后点击 **录屏展示 → 画面全屏**。推荐横屏 1920×1080：左侧六路 3×2 画面，右侧显示各路完整时间戳、同步帧 ID 和大号“同帧时间戳跨度”；末三位纳秒数字着色，图像下方的时间戳也同步放大。再次点击“退出录屏展示”恢复普通布局。该模式只调整回放展示，不启动系统录屏或修改录制数据。

数值绑定当前实际显示的图像，以 BigInt 计算最大与最小 publish_time 之差；仅当可见相机的同步脉冲 ID、clock generation 和 sync epoch 全部一致时显示跨度。定位、异步解码或检测使画面暂不同帧时显示“—”，不会沿用上一帧数值。缺少同步元数据的旧录制不把相同采集序号当成同步证据；单路聚焦不计算跨相机跨度。

宣传录屏可先播放双手张开、握拳、翻转和交叉的动作；开启“手部关键点”，最多手数选 2。六路检测建议 0.25× 起步。随后暂停，等待六路画面就绪，用上一帧/下一帧展示一致的同步帧 ID 及时间戳跨度。当前异步检测不保证六路同时更新，连续播放期间跨度可能暂时显示“—”。展示的是录制时间戳对齐，不能直接称作绝对时钟精度或曝光同步精度。

指标回归：`node data_pipeline/offline/tests/displayed_alignment.mjs`。布局、GPU 及图像/时间戳对应验证见 [录屏展示验证](../../debug/offline-showcase-20260930/REPORT.md)。

## 手部关键点

- 默认关闭。勾选“手部关键点”后加载模型，在图像上叠加 21 个关键点和连线；所有手固定使用青绿色，不随左右手分类、置信度或返回顺序变色。可选全部可见相机或指定相机，最多检测 1、2 或 4 只手。
- 支持暂停、单步、倍速、拖动、图像缩放和单路聚焦。检测结果绑定文件 ID、相机 ID 和帧索引；原始纳秒时间戳仍由 MCAP 提供。
- GPU Worker 为每路相机维护独立的 VIDEO 跟踪模型，使用录制的帧时间（毫秒）。拖动、倒退、换文件或改变检测相机时清空跟踪状态，关闭旧模型并释放图形上下文，防止跨相机、跨录制串用。每个 Worker 最多维护两路 VIDEO 模型，另留一个 IMAGE 模型用于局部补检，六路相机使用三个 Worker 并发推理，以避开浏览器单 Worker 的 WebGL 上下文限额；每 Worker 一个在途任务，每路最多一个待处理快照和一个待显示帧，最多缓存 240 个结果。GPU 上下文丢失会明确报错，不能伪装成零只手。
- 检测开启且模型就绪后，新图像与同帧检测结果一起显示；等待时保留上一组完整图像和骨架，避免换图后先清空再补画导致闪烁。每路最多等待 750 ms，超时恢复显示且清空无对应结果的骨架。偶发漏检时按掌部位置关联，可短时保留缺失手的最近关键点，最多连续两个检测结果且不超过 120 ms **录制时间**，包括双手中仅一只漏检的情况；界面标注“短时估计”，保留原始 source frame key，不把估计伪装成新检测。超过窗口、seek、换文件/相机、关闭或模型异常均清空。持续暂停时保留该帧的显示结果，倍速不会延长录制时间窗口。推理跟不上时降低图像更新频率并跳过中间帧，时间轴继续运行；暂停后补算当前帧。首次开启和定位后各路模型需要短暂预热。
- 运动漏检恢复：整图保留 0.5 检测/存在/跟踪阈值。当近期已检测到的手丢失时，按掌部位置和近期速度预测当前图像中的搜索区域，裁成 384×384 后进行独立 IMAGE 推理；局部掌部检测阈值 0.35，存在阈值仍为 0.5。仅接受当前位置附近且不与已有手重复的真实新检测，坐标映射回原图。局部首次未检出时，额外旋转 90° 补检一次并逆变换坐标；每帧最多一个区域、两次局部推理，历史最多 350 ms；无检测就不产生补检关键点。它与“短时估计”不同：补检使用当前帧像素，来源仍为当前帧。诊断面板提供补检尝试数、找回手数、耗时及实际 delegate。
- 关闭即清空叠加、终止 Worker 并释放模型资源；模型缺失或推理失败不影响普通回放。
- 算法只派生显示结果，合并 MCAP 的原始图像和传感器消息不被修改。首版不导出关键点，也不做跨相机三维重建。

## 硬件与浏览器

```bash
python3 data_pipeline/offline/scripts/rtcamera-offline doctor
```

`--browser` 优先启动 Chrome/Chromium 的独立用户目录，避免被已有浏览器进程吞掉显卡环境设置；发现可用的 NVIDIA 驱动后设置 PRIME offload。浏览器找不到时使用系统默认浏览器。本机已在用户缓存目录准备了官方 Chrome，用于验证 H.264 WebCodecs；不修改系统默认浏览器。

解码和推理是两个独立能力：

1. 解码先尝试 WebCodecs 硬件偏好，再尝试 WebCodecs 自动选择，最后回退到 OpenCV JPEG。H.265 是否支持取决于浏览器、驱动与平台。
2. 手部推理优先 GPU delegate，失败时回退 CPU；若图形设备是 SwiftShader/llvmpipe 等软件渲染器，直接使用 CPU。
3. “检测诊断”显示实际图形 renderer、delegate、耗时与各路完成数量。GPU delegate 标签不等于使用 NVIDIA 独显；需要 renderer 显示 NVIDIA，并结合 `nvidia-smi` 核验。

OpenCV 兼容路径需要 `cv2`，可在独立 Python 环境安装 `pip install '.[decode]'`。各路解码线程数限制为 2，临时文件只包含目标 GOP，重复帧使用 12 帧 JPEG 缓存；不同相机可并行解码。

当前主机（2026-09-30）：Ubuntu 签名的 **595.91.07 / 595-open** 已安装，Secure Boot 保持开启。用户已手动重启，`nvidia-smi` 正常。现已验证 RTX 3060 的 GPU delegate 和真实手部推理；浏览器使用 ANGLE Vulkan，显式复用 Worker 的 OffscreenCanvas。重启前的 AMD 数据仍保留为历史基线。

重启后运行：

```bash
cat /proc/sys/kernel/random/boot_id
nvidia-smi
python3 data_pipeline/offline/scripts/rtcamera-offline doctor
python3 data_pipeline/offline/scripts/rtcamera-offline serve --browser
```

开启检测后检查“检测诊断”的 renderer，以及 `nvidia-smi` 中的浏览器进程。重启前 boot ID 记录在本轮报告中。若仍失败，保留 `nvidia-smi`、`lsmod`、`modinfo nvidia` 和内核日志，再定位；无需关闭 Secure Boot。

PRIME 配置依据：[NVIDIA 多 GPU 主机文档](https://docs.nvidia.com/datacenter/tesla/driver-installation-guide/optimus-laptops-and-multi-gpu-desktop-systems.html)。

## 安装与离线资源

可安装为独立 Python 包：

```bash
python3 -m venv data_pipeline/offline/.venv
data_pipeline/offline/.venv/bin/pip install './data_pipeline/offline[decode]'
data_pipeline/offline/.venv/bin/rtcamera-offline fetch-assets
data_pipeline/offline/.venv/bin/rtcamera-offline serve --browser
```

也支持 CMake 安装，离线包及 Web 资源随 `bin/rtcamera_offline/` 安装，旧入口与 `rtcamera-offline` 同时保留。`mcap_merge`、`mcap_inspect` 先查源码构建目录，再查 PATH。

JS/WASM/模型的固定版本、URL、SHA-256 在 `rtcamera_offline/assets.json` 中。`fetch-assets` 下载并校验，播放期间仅访问本地服务。默认资源目录为 `$XDG_DATA_HOME/rtcamera-offline/assets`，未设置时使用 `~/.local/share/rtcamera-offline/assets`；可用 `RTCAMERA_OFFLINE_ASSETS` 覆盖。模型和大二进制不放进 Git。

算法代码在 `web/analysis/`；录制解析在 `recording.py`；ZIP 验证在 `archive.py`；兼容解码在 `decode.py`；HTTP、导入任务和录制生命周期在 `server.py`。`web/player.js` 暂保留原有播放与时间轴协调逻辑，避免为本次功能引入第二套播放器。

## 验证

```bash
python3 -m unittest discover -s data_pipeline/tests -p 'test_mcap_*.py'
python3 -m unittest discover -s data_pipeline/offline/tests -p 'test_*.py'
```

`tests/hand_landmarks_browser.cjs` 检查真实模型、像素叠加、帧身份、暂停/seek/逐帧、开关取消、缩放和缺模型回退。需要 Playwright 及一段前半有手、后半无手的本地 MCAP；测试样本制作方法和本轮证据见 [实施与验证报告](../../debug/offline-hand-landmarks-20260930/REPORT.md)。

```bash
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
PLAYWRIGHT_CHROMIUM=/path/to/chrome HEADLESS=0 \
OFFLINE_URL=http://127.0.0.1:8093/ OFFLINE_REPORT=/path/to/results \
node data_pipeline/offline/tests/hand_landmarks_browser.cjs
```

RTX 3060 已完成重启后 GPU 推理验收，并以真实六路手部录制完成连续跟踪和回放稳定性回归；仍需 30 分钟连续播放与更多双手/遮挡/小目标录制精度测试。导入支持阶段进度，尚未提供中途取消按钮。

手部稳定性回归：`node data_pipeline/offline/tests/hand_scheduler.mjs` 验证时间戳、取消、相机公平调度及快照释放。`tests/hand_playback_regression.js` 可通过浏览器 CDP 的 Runtime.evaluate（awaitPromise=true）在已加载至少三路、10 秒以上录制的页面运行，检查原子显示、倒退/逐帧、切换相机、开关和模型失败恢复。真实录制对比、运行方法及原始证据见 [20260930 手部稳定性报告](../../debug/hand-stability-20260930/REPORT.md)。

运动算法回归：`node data_pipeline/offline/tests/hand_motion.mjs`；真实六路同帧序列的原始推理对比见 [运动漏检优化报告](../../debug/hand-motion-20260930/REPORT.md)。
