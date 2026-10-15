import {FileReadable} from './readable.js';

export class LocalRecording {
  static open(file, {signal, onProgress = () => {}} = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
      const worker = new Worker(new URL('./index.worker.js', import.meta.url), {type: 'module'});
      const finish = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
      const abort = () => { finish(); reject(new DOMException('已取消', 'AbortError')); };
      signal?.addEventListener('abort', abort, {once: true});
      worker.onerror = event => { finish(); reject(Error(event.message || 'MCAP 索引 Worker 启动失败')); };
      worker.onmessage = ({data}) => {
        if (data.type === 'progress') onProgress(data.progress);
        else if (data.type === 'ready') { finish(); resolve(new LocalRecording(file, data.result)); }
        else if (data.type === 'error') { finish(); reject(Error(data.error)); }
      };
      worker.postMessage({file});
    });
  }
  constructor(file, {metadata, locators}) {
    this.metadata = metadata; this.locators = locators; this.reader = new FileReadable(file); this.closed = false;
  }
  async packets(streamId, start, count) {
    if (this.closed) throw new DOMException('文件已关闭', 'AbortError');
    const frames = this.locators[streamId], stream = this.metadata.streams[streamId];
    if (!frames || !Number.isInteger(start) || start < 0 || start > frames.length || !Number.isInteger(count) || count < 1 || count > 12) throw Error('帧读取参数无效');
    const result = [];
    for (let index = start; index < Math.min(frames.length, start + count); index++) {
      const loc = frames[index], bytes = await this.reader.read(loc.offset, loc.length);
      result.push({index, key: stream.keyframes.includes(index), data: bytes.slice()});
    }
    return result;
  }
  close() { this.closed = true; this.reader.close(); this.locators = []; this.metadata = null; }
}
