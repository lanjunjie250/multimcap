# RTCamera Offline Player

用于在普通 Linux PC 上查看和分析 MCAP、ZIP 及分段录像，不需要 Jetson 相机硬件。

源码仓库：[lanjunjie250/multimcap](https://github.com/lanjunjie250/multimcap)。

**在线试用：[MultiMCAP 网页播放器](https://multimcap.rtcamera.workers.dev/)**

网页版在浏览器中读取本地 `.mcap` 或录像 `.zip`，录像不会上传到服务器。网页版支持单个 MCAP，以及多相机、分段录像会话 ZIP；在本机自动解包、按公共同步帧对齐并播放。MCAP 内部压缩 Chunk 仍暂不支持。

## 启动

```bash
python3 data_pipeline/offline/scripts/rtcamera-offline serve \
  --host 127.0.0.1 \
  --port 8090 \
  --root /path/to/this/package \
  --root /path/to/recordings
```

然后打开 `http://127.0.0.1:8090/`。

也可以直接在网页中打开或上传 `.zip`、`.mcap` 文件。

要求：Python 3、Linux；程序使用 Python 标准库，`mcap_inspect` 已包含在 `data_pipeline/tools/` 中。

## 纯前端网页版

当前试用站点部署在 Cloudflare Workers，源码由 GitHub 管理。仓库根目录运行 `npm run build` 可生成完整站点；默认 `wrangler deploy` 会先构建，再发布 `web_pages/dist/`。也可将相同静态文件手动上传到 Cloudflare Pages。

- [GitHub 自动部署到 Cloudflare Workers](web_pages/README.md#github-自动部署到-cloudflare-workers)
- [试用与手动上传说明](web_pages/README.md)
- [迁移方案](data_pipeline/offline/CLOUDFLARE_PAGES_MIGRATION_PLAN.md)
- [验证记录与当前限制](web_pages/VERIFICATION.md)

发布包位于 `web_pages/release/rtcamera-pages-trial.zip`。网页版在浏览器本地处理 MCAP、Stored/Deflate ZIP 和完整分段会话，支持 ZIP64；单段会话也可下载合并 MCAP。需要浏览器不支持的视频编码或其他完整兼容能力时，使用上述 Python 入口。
