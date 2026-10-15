import {cp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const shared = path.resolve(root, '../data_pipeline/offline/rtcamera_offline');
const dist = path.join(root, 'dist');
await rm(dist, {recursive: true, force: true});
await mkdir(dist, {recursive: true});
for (const file of ['index.html', 'player.js']) await cp(path.join(root, file), path.join(dist, file));
await cp(path.join(root, 'mcap'), path.join(dist, 'mcap'), {recursive: true});
await cp(path.join(root, 'public'), dist, {recursive: true});
const css = await readFile(path.join(shared, 'web/player.css'), 'utf8');
const browserCss = await readFile(path.join(root, 'player.css'), 'utf8');
await writeFile(path.join(dist, 'player.css'), css + '\n' + browserCss);
await mkdir(path.join(dist, 'analysis'), {recursive: true});
for (const file of await readdir(path.join(shared, 'web/analysis'))) {
  let code = await readFile(path.join(shared, 'web/analysis', file), 'utf8');
  if (file === 'scheduler.js') code = code.replace("new Worker('/analysis/hand_landmarks.worker.js')", "new Worker(new URL('./hand_landmarks.worker.js', import.meta.url))");
  if (file === 'hand_landmarks.worker.js') {
    code = code.replace("'/assets/hand_landmarker.task'", "new URL('../assets/hand_landmarker.task', self.location.href).href")
      .replace("import('/assets/vision_bundle.mjs')", "import(new URL('../assets/vision_bundle.mjs', self.location.href).href)")
      .replace("import('/analysis/motion.js')", "import(new URL('./motion.js', self.location.href).href)")
      .replace("forVisionTasks('/assets/wasm')", "forVisionTasks(new URL('../assets/wasm', self.location.href).href)");
  }
  await writeFile(path.join(dist, 'analysis', file), code);
}
const manifest = JSON.parse(await readFile(path.join(shared, 'assets.json'), 'utf8'));
const assetRoot = process.env.RTCAMERA_OFFLINE_ASSETS || path.join(root, '.cache/assets');
for (const entry of manifest.files) {
  const bytes = await readFile(path.join(assetRoot, entry.path)).catch(() => { throw Error('缺少模型资源，请先运行 npm run fetch-assets：' + entry.path); });
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw Error('资源 SHA-256 不匹配：' + entry.path);
  const target = path.join(dist, 'assets', entry.path); await mkdir(path.dirname(target), {recursive: true}); await writeFile(target, bytes);
}
await writeFile(path.join(dist, 'assets/manifest.json'), JSON.stringify(manifest, null, 2));
const files = [];
async function inspect(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await inspect(full);
    else {
      const size = (await stat(full)).size;
      if (size > 25 * 1024 * 1024 || /\.(mcap|zip|py|map)$/i.test(entry.name)) throw Error('禁止发布的文件：' + full);
      files.push({path: path.relative(dist, full), bytes: size});
    }
  }
}
await inspect(dist);
await writeFile(path.join(root, 'build-manifest.json'), JSON.stringify({built_at: new Date().toISOString(), files}, null, 2) + '\n');
console.log(`已构建 ${files.length} 个静态文件，${(files.reduce((n, f) => n + f.bytes, 0) / 1024 / 1024).toFixed(1)} MiB → ${dist}`);
