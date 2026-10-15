# RTCamera 纯前端试用版

更新：2026-10-15。程序和模型打包为静态文件，MCAP 使用浏览器本地 File API 读取。当前试用站点部署在 Cloudflare Workers；同一份静态产物也支持 Cloudflare Pages Direct Upload。

**在线试用：[MultiMCAP 网页播放器](https://multimcap.rtcamera.workers.dev/)**

当前 Worker 名称为 `multimcap`，账号子域名为 `rtcamera`。账号子域名由 Cloudflare 控制台管理，修改它会影响该账号下所有 Worker 的 `workers.dev` 地址。

## GitHub 自动部署到 Cloudflare Workers

源码仓库：[lanjunjie250/multimcap](https://github.com/lanjunjie250/multimcap)，SSH 远端地址为 `git@github.com:lanjunjie250/multimcap.git`。

这条路径使用 GitHub 保存源码，由 Cloudflare Workers Builds 构建并托管网站。自动部署使用仓库根目录的 `package.json` 和 `wrangler.json`。

部署使用以下名称：

| 设置项 | 目标值 |
| --- | --- |
| Worker 名称（`wrangler.json` 中的 `name`） | `multimcap` |
| 账号 Workers 子域名 | `rtcamera` |
| 目标网址 | `https://multimcap.rtcamera.workers.dev/` |

`wrangler.json` 的 `name` 必须与控制台的 Worker 名称一致。发布目录固定为 `web_pages/dist/`。

1. 将项目源码推送到上述仓库的 `main` 分支。需要保留整个 `web_pages/` 源码及 `data_pipeline/offline/rtcamera_offline/` 中的共享分析模块、CSS 和 `assets.json`；不要只上传 `dist/` 或发布 ZIP。模型和 WASM 会在构建时按固定版本下载、校验，不需要提交缓存目录。
2. 进入 [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)，打开 `multimcap` Worker。
3. 在该 Worker 中进入 **Settings → Builds → Connect**，授权并选择 GitHub 仓库 `lanjunjie250/multimcap`。
4. 设置以下构建参数，保存并触发一次部署：

| 设置项 | 值 |
| --- | --- |
| Root directory | 仓库根目录 `.` |
| Production branch | `main` |
| Build command | 留空；Wrangler 的构建钩子会运行 `npm run build` |
| Deploy command | `npx wrangler@4.151.0 deploy` |
| Preview command（启用预览时） | `npx wrangler@4.151.0 preview` |
| Environment variable | `NODE_VERSION=22` |
| Build environment | Node.js 22+、Python 3 |

部署工具固定为 Wrangler 4.151.0，要求 Node.js 22+；本地仅构建仍支持 Node.js 20+。

根目录保持为仓库根目录，构建才能读取 `data_pipeline/` 下的共享资源。仓库根目录的 `wrangler.json` 配置了构建钩子和 `web_pages/dist/` 发布目录，默认部署命令会准备并校验资源、运行解析测试、生成静态文件。保留 `web_pages/wrangler.json` 兼容已有的显式 `--config web_pages/wrangler.json` 配置，该入口同样会先构建。

**检查 Deploy command 中是否存在 `--assets` 参数。请使用表中的完整命令，移除 `--assets web_pages`、`--assets .` 等源码目录覆盖参数。** 此类参数会覆盖配置文件的发布目录。直接发布 `web_pages/` 会缺少构建生成的 CSS、`analysis/` 和模型资源，造成页面样式异常、脚本 404。

构建完成后，`web_pages/dist/` 应有 `index.html`、`player.css`、`analysis/`、`mcap/` 和 `assets/`。上线后检查 `/player.css`、`/analysis/scheduler.js`、`/assets/manifest.json` 均返回 200；`/package.json` 和 `/wrangler.json` 应返回 404。

连接完成后，向生产分支推送代码会触发 Cloudflare 构建和发布，不必再手动上传 ZIP，也不需要在 GitHub Actions 中配置 Cloudflare Token。

官方说明：[Wrangler 构建钩子](https://developers.cloudflare.com/workers/wrangler/custom-builds/)、[Workers Builds 与现有 Worker 绑定 GitHub](https://developers.cloudflare.com/workers/ci-cd/builds/)、[workers.dev 地址规则](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)、[构建环境](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

## 本地打包后上传到 Cloudflare Pages

已打包的文件：`release/rtcamera-pages-trial.zip`。压缩包约 12.1 MiB，展开后约 29.2 MiB，包含 MediaPipe JS、WASM 和手部模型；不包含任何录像。

1. 登录 Cloudflare，进入 **Workers & Pages → Create application → Pages → Use direct upload / Upload assets**。控制台标签可能调整，选择 Pages 的“直接上传”。
2. 项目名可用 `rtcamera-offline-trial`；如果名称已占用，换一个名称。
3. 上传 `release/rtcamera-pages-trial.zip`，或拖入整个 `dist/` 文件夹。ZIP 根目录已经是 `index.html`，无需再套一层目录。
4. 点击部署，打开控制台给出的 `https://<项目名>.pages.dev/`。
5. 点击“打开本机文件”，选择 `.mcap`，或把文件拖入页面。
6. 第一次打开先建立本地索引，再显示首组画面。手部检测默认关闭，开启后从同一个站点加载模型。

更新时，在同一个 Pages 项目中创建新部署，上传重新生成的 ZIP 即可。Direct Upload 项目不使用 GitHub 自动部署；如果以后需要 Git 集成，按 Cloudflare 的要求另建项目。

**不要上传整个源码目录，也不要把录像 ZIP 当成部署 ZIP。** `release/rtcamera-pages-trial.zip` 是网页发布包；用户自己的 `.mcap` 只需在已打开的网页中选择。

## 本地构建与预览

要求 Node.js 20+、Python 3。试用版使用浏览器原生 ES modules 和 Node 构建脚本，不需要安装 npm 依赖。

```bash
cd web_pages
npm run fetch-assets
npm test
npm run package
npm run preview
```

在浏览器打开 `http://127.0.0.1:4173/`。预览服务只提供静态文件，不接收录像上传。退出按 Ctrl+C；修改端口可用 `PORT=4174 npm run preview`。

请通过 HTTP 本地预览或 Pages 的 HTTPS 地址打开，直接双击 `dist/index.html` 会受到浏览器的模块跨域限制。

- `npm run fetch-assets`：按原项目 `assets.json` 下载并校验固定版本资源。已存在且校验正确的资源直接复用。
- `npm run build`：只将发布文件放入 `dist/`，逐项验证资源 SHA-256，拒绝超过 25 MiB 的单文件和录像文件。
- `npm run package`：构建后生成 Direct Upload ZIP，根目录包含 `index.html`。
- 构建时可通过 `RTCAMERA_OFFLINE_ASSETS=/path/to/assets` 指向已有的完整资源目录。
- `build-manifest.json` 记录部署资源的名称和大小；构建和打包不需要访问 Cloudflare 账号。

手部检测模块和 CSS 在构建时从原 Python 包的 `web/` 目录复制，并调整资源 URL，保持同一套分析实现。

## 界面与操作

- 首页选择或拖入本机 `.mcap`，显示实际索引进度，可随时取消；解析错误会留在文件卡片上。
- 桌面版优先显示多路画面，可收起时间轴以增加画面高度；单路画面支持聚焦与缩放。
- 窄屏使用单列画面，播放控制随滚动保持可见，时间轴默认收起，点击“展开轨道”即可查看。
- 空格播放/暂停，左右方向键逐帧；在按钮、选择框和输入框中保留控件自身的键盘行为。Esc 关闭文件信息、时间戳单独查看或单路聚焦。
- 网页主题位于 `web_pages/player.css`，构建时与共享播放器样式合并，不修改 Python 本地版界面。

## 当前支持范围

| 功能 | 试用版状态 |
| --- | --- |
| 单个本地 MCAP，包含一到多路视频 | 支持 |
| MCAP 顶层 Message、未压缩 Chunk | 支持 |
| 无 Summary/无 Chunk Index 的标准 MCAP | 支持，通过扫描建立索引；文件仍须有合法 Footer |
| H.264/H.265 | 取决于当前浏览器/系统的 WebCodecs 支持，打开时探测；硬件偏好失败会尝试自动选择 |
| 纳秒时间戳、SBR2 v3/v4、IMU/encoder 时间轴 | 支持 |
| 暂停、倍速、逐帧、定位、多路布局、全屏、同帧偏差 | 支持 |
| 手部检测 | 已接入原分析模块、打包模型；完整 Pages 资源加载和效果仍待部署后验收 |
| zstd/lz4 压缩 Chunk、ZIP、分段会话导入 | 暂不支持，页面明确提示 |
| 下载合并 MCAP、OpenCV 解码回退 | 使用原 Python 本地版 |
| 断网后重新打开整个站点 | 暂无 Service Worker 离线安装保证；录像处理本身不需要网络 |

读取缓冲默认 4 MiB，单次消息读取上限 32 MiB。索引仍随消息数增长，试用版限制总消息 100 万、视频帧 25 万；超出后明确报错。这些是软件保护上限，不能等同于所有设备都能承受的容量。GB 级录像、30 分钟播放和大陆多运营商访问尚未验收。

本地索引在独立 Worker 中执行，可取消。关闭/更换文件会终止导入 Worker、关闭 decoder 和检测 Worker、清除帧队列及文件引用。页面刷新后需要重新选择本地文件，不自动保存录像。

## 已完成的验证

详见 [试用版验证记录](VERIFICATION.md)。包括解析单元测试、Python/JS 对照、六路 H.265 浏览器播放、快速定位和同步帧检查。HTTP/Pages 生产部署和手部检测实机回归仍需单独完成。

可用自己的样本重跑 Python/JS 对照：

```bash
node scripts/check_sample.mjs /path/to/recording.mcap
```

对照仅适用于旧 Python 版也支持的文件；不把旧版本的“sequence 回退即同步”行为作为新版本的同步证据。

## 发布后检查

1. 在关闭代理的网络上打开实际部署地址；一次成功不能证明所有大陆网络都可访问。
2. 浏览器 Network 面板检查 `.js`、`.mjs`、`.wasm`、`.task` 均成功，资源请求应来自同一个站点。
3. 打开一个小型 MCAP，确认文件名、多路画面、时间轴和逐帧可用。
4. 打开较大的真实录像，观察索引耗时和内存；不要先假定支持任意大小文件。
5. 打开手部检测，确认模型加载、画面和骨架同帧；失败时关闭检测，普通播放应继续可用。
6. 打开第二个文件，确认画面和时间戳已更换。
7. Network 面板不应出现录像上传 POST 请求；本版没有 `/api/upload` 或其他录像上传接口。

参考：Cloudflare [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)、[Pages 限制](https://developers.cloudflare.com/pages/platform/limits/)、[MCAP 规范](https://mcap.dev/spec)。
