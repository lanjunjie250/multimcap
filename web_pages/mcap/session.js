import {FileReadable} from './readable.js';
import {openSessionArchive} from './zip.js';
import {mergedExport} from './write.js';

export class LocalRecording {
  static async open(file, {signal, onProgress = () => {}} = {}) {
    let archive=null;
    try {
      signal?.throwIfAborted();
      if(/\.zip$/i.test(file.name))archive=await openSessionArchive(file,{signal,onProgress});
      const result=await new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('已取消', 'AbortError')); return; }
        const worker = new Worker(new URL('./index.worker.js', import.meta.url), {type: 'module'});
        const finish = () => { worker.terminate(); signal?.removeEventListener('abort', abort); };
        const abort = () => { finish(); reject(new DOMException('已取消', 'AbortError')); };
        signal?.addEventListener('abort', abort, {once: true});
        worker.onerror = event => { finish(); reject(Error(event.message || 'MCAP 索引 Worker 启动失败')); };
        worker.onmessage = ({data}) => {
          if (data.type === 'progress') onProgress(data.progress);
          else if (data.type === 'ready') { finish(); resolve(data.result); }
          else if (data.type === 'error') { finish(); reject(Error(data.error)); }
        };
        worker.postMessage(archive?{files:archive.files,groups:archive.groups,info:{name:file.name,size:file.size}}:{file});
      });
      return new LocalRecording(archive?archive.files:file,result,archive?.close);
    } catch(error) { await archive?.close().catch(()=>{});throw error; }
  }
  constructor(file, result,cleanup=null) {
    this.metadata=result.metadata;this.locators=result.locators;this.files=Array.isArray(file)?file:[file];
    this.readers=this.files.map(f=>new FileReadable(f));this.reader=this.readers[0];this.closed=false;this.cleanup=cleanup;
    this.exportData=result.records?result:null;
  }
  async packets(streamId, start, count) {
    if (this.closed) throw new DOMException('文件已关闭', 'AbortError');
    const frames = this.locators[streamId], stream = this.metadata.streams[streamId];
    if (!frames || !Number.isInteger(start) || start < 0 || start > frames.length || !Number.isInteger(count) || count < 1 || count > 12) throw Error('帧读取参数无效');
    const result = [];
    for (let index = start; index < Math.min(frames.length, start + count); index++) {
      const loc = frames[index], bytes = await this.readers[loc.file??0].read(loc.offset, loc.length);
      result.push({index, key: stream.keyframes.includes(index), data: bytes.slice()});
    }
    return result;
  }
  exportMerged(){
    if(this.closed)throw new DOMException('文件已关闭','AbortError');
    if(!this.metadata.merged_download||!this.exportData)throw Error('此录像不能导出单个合并 MCAP');
    return mergedExport(this.files,this.exportData,()=>this.closed);
  }
  close() {
    if(this.closed)return Promise.resolve();this.closed=true;
    for(const reader of this.readers)reader.close();this.locators=[];this.metadata=null;this.files=[];this.exportData=null;
    const cleanup=this.cleanup;this.cleanup=null;return cleanup?cleanup().catch(error=>console.warn('本地 ZIP 临时文件清理失败',error)):Promise.resolve();
  }
}
