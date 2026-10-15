/** Local ZIP/ZIP64 reader. Stored members remain slices of the original file;
 * deflated members stream to a temporary browser file (bounded Blob fallback). */
import {FileReadable} from './readable.js';

const MAX_ENTRIES=4096, MAX_MANIFEST=1024*1024, MEMORY_LIMIT=128*1024*1024;
const decoder=new TextDecoder('utf-8',{fatal:true});
const dv=b=>new DataView(b.buffer,b.byteOffset,b.byteLength);
const u16=(b,i)=>dv(b).getUint16(i,true),u32=(b,i)=>dv(b).getUint32(i,true);
const safe=n=>{if(n>BigInt(Number.MAX_SAFE_INTEGER))throw Error('ZIP 大小或偏移超出安全范围');return Number(n);};
const u64=(b,i)=>safe(dv(b).getBigUint64(i,true));
const cancelled=signal=>signal?.throwIfAborted();
const crcTable=Uint32Array.from({length:256},(_,i)=>{for(let j=0;j<8;j++)i=(i>>>1)^((i&1)?0xedb88320:0);return i>>>0;});
export function crc32(bytes,previous=0){let crc=(previous^0xffffffff)>>>0;for(const b of bytes)crc=(crc>>>8)^crcTable[(crc^b)&255];return (crc^0xffffffff)>>>0;}
function pathName(name,directory=false){
  const value=directory?name.replace(/\/$/,''):name;
  if(!value||value.includes('\\')||value.includes('\0')||value.startsWith('/')||/^[A-Za-z]:/.test(value)||value.split('/').some(s=>!s||s==='.'||s==='..'))throw Error('ZIP 包含不安全的路径');
  return value;
}
export async function readZipDirectory(file,{signal,maxEntries=MAX_ENTRIES}={}){
  const reader=new FileReadable(file),entries=[];
  try{
    cancelled(signal);
    if(file.size<22)throw Error('ZIP 文件不完整');
    const tailOffset=Math.max(0,file.size-65557),tail=await reader.read(tailOffset,file.size-tailOffset);
    cancelled(signal);
    let end=-1;
    for(let i=tail.length-22;i>=0;i--)if(u32(tail,i)===0x06054b50&&i+22+u16(tail,i+20)===tail.length){end=i;break;}
    if(end<0)throw Error('ZIP 中央目录缺失或文件被截断');
    if(u16(tail,end+4)||u16(tail,end+6)||u16(tail,end+8)!==u16(tail,end+10))throw Error('暂不支持分卷 ZIP');
    let count=u16(tail,end+10),size=u32(tail,end+12),offset=u32(tail,end+16),boundary=tailOffset+end;
    if(count===65535||size===0xffffffff||offset===0xffffffff){
      if(boundary<20)throw Error('ZIP64 locator 缺失');
      const locator=await reader.read(boundary-20,20);
      if(u32(locator,0)!==0x07064b50||u32(locator,4)||u32(locator,16)!==1)throw Error('ZIP64 locator 无效或使用分卷');
      const at=u64(locator,8);
      if(at>boundary-76)throw Error('ZIP64 目录偏移越界');
      const header=await reader.read(at,56);
      if(u32(header,0)!==0x06064b50||u64(header,4)<44||at+12+u64(header,4)>boundary-20||u32(header,16)||u32(header,20)||u64(header,24)!==u64(header,32))throw Error('ZIP64 目录无效');
      count=u64(header,32);size=u64(header,40);offset=u64(header,48);boundary=at;
    }
    if(!count||count>maxEntries||size>32*1024*1024||offset>boundary-size)throw Error('ZIP 文件数、目录大小或偏移超出限制');
    const bytes=await reader.read(offset,size),names=new Set();let cursor=0;
    for(let i=0;i<count;i++){
      cancelled(signal);
      if(cursor+46>bytes.length||u32(bytes,cursor)!==0x02014b50)throw Error('ZIP 中央目录记录损坏');
      const nameLength=u16(bytes,cursor+28),extraLength=u16(bytes,cursor+30),commentLength=u16(bytes,cursor+32),next=cursor+46+nameLength+extraLength+commentLength;
      if(next>bytes.length)throw Error('ZIP 目录记录被截断');
      const name=decoder.decode(bytes.subarray(cursor+46,cursor+46+nameLength)),directory=name.endsWith('/');
      pathName(name,directory);
      if(names.has(name))throw Error('ZIP 包含重复文件名：'+name);names.add(name);
      const flags=u16(bytes,cursor+8),method=u16(bytes,cursor+10),mode=u32(bytes,cursor+38)>>>16,type=mode&0xf000;
      if(flags&0x41)throw Error('暂不支持加密 ZIP');
      if(![0,8].includes(method))throw Error('ZIP 压缩方式不支持，请使用 Stored 或 Deflate');
      if(type&&type!==(directory?0x4000:0x8000))throw Error('ZIP 包含符号链接或非普通文件');
      const entry={name,directory,flags,method,crc:u32(bytes,cursor+16),compressedSize:u32(bytes,cursor+20),size:u32(bytes,cursor+24),localOffset:u32(bytes,cursor+42)};
      let disk=u16(bytes,cursor+34),extraAt=cursor+46+nameLength,zip64=false;
      while(extraAt<cursor+46+nameLength+extraLength){
        if(extraAt+4>cursor+46+nameLength+extraLength)throw Error('ZIP extra 字段损坏');
        const tag=u16(bytes,extraAt),length=u16(bytes,extraAt+2),limit=extraAt+4+length;
        if(limit>cursor+46+nameLength+extraLength)throw Error('ZIP extra 字段越界');
        if(tag===1){
          zip64=true;let at=extraAt+4;
          for(const key of ['size','compressedSize','localOffset'])if(entry[key]===0xffffffff){if(at+8>limit)throw Error('ZIP64 extra 字段缺失');entry[key]=u64(bytes,at);at+=8;}
          if(disk===65535){if(at+4>limit)throw Error('ZIP64 disk 字段缺失');disk=u32(bytes,at);}
        }
        extraAt=limit;
      }
      if(disk||(!zip64&&[entry.size,entry.compressedSize,entry.localOffset].includes(0xffffffff)))throw Error('ZIP64 字段缺失或使用分卷');
      if(entry.localOffset>offset-30||entry.size>64*1024**3||(directory&&entry.size)||(!method&&entry.size!==entry.compressedSize))throw Error('ZIP 成员大小或偏移无效');
      const local=await reader.read(entry.localOffset,30);
      if(u32(local,0)!==0x04034b50||u16(local,6)!==flags||u16(local,8)!==method)throw Error('ZIP 本地头与中央目录不一致');
      const localNameLength=u16(local,26),localExtraLength=u16(local,28);
      entry.offset=entry.localOffset+30+localNameLength+localExtraLength;
      if(entry.offset>offset-entry.compressedSize||decoder.decode(await reader.read(entry.localOffset+30,localNameLength))!==name)throw Error('ZIP 本地文件名或内容范围无效');
      entries.push(entry);cursor=next;
    }
    if(cursor!==bytes.length)throw Error('ZIP 中央目录长度不匹配');
    return entries.filter(entry=>!entry.directory);
  }finally{reader.close();}
}
function outputStream(file,entry){
  const input=file.slice(entry.offset,entry.offset+entry.compressedSize).stream();
  if(entry.method===0)return input;
  try{return input.pipeThrough(new DecompressionStream('deflate-raw'));}
  catch{throw Error('此浏览器不支持 ZIP 解压，请升级 Chrome/Edge 或先解压为 MCAP');}
}
async function copyChecked(file,entry,sink,{signal,onBytes=()=>{}}={}){
  let size=0,crc=0;
  const checking=new TransformStream({transform(chunk,controller){
    cancelled(signal);size+=chunk.byteLength;
    if(size>entry.size)throw Error('ZIP 解压大小超过声明：'+entry.name);
    crc=crc32(chunk,crc);onBytes(chunk.byteLength);controller.enqueue(chunk);
  },flush(){if(size!==entry.size||crc!==entry.crc)throw Error('ZIP 内容长度或 CRC 校验失败：'+entry.name);}});
  await outputStream(file,entry).pipeThrough(checking).pipeTo(sink,{signal});
}
async function smallEntry(file,entry,signal){
  if(entry.size>MAX_MANIFEST)throw Error('ZIP 会话清单超过 1 MiB');
  const chunks=[];await copyChecked(file,entry,new WritableStream({write:b=>chunks.push(b)}),{signal});
  try{return JSON.parse(await new Blob(chunks).text());}catch{throw Error('ZIP 会话清单不是有效 JSON');}
}
function validateSession(manifest){
  const cameras=manifest?.cameras;
  if(!['complete','error'].includes(manifest?.status)||!Array.isArray(cameras)||cameras.length<2||cameras.some(c=>typeof c!=='string'||!/^[A-D][0-3]$/.test(c))||new Set(cameras).size!==cameras.length)throw Error('ZIP 会话未完成或相机清单无效');
  return cameras;
}
function validateSegments(manifest,cameras){
  if((manifest?.schema_version??1)!==1||!Array.isArray(manifest?.segments)||!manifest.segments.length)throw Error('ZIP 分段清单无效');
  const indices=new Set(),directories=new Set();
  for(const row of manifest.segments){
    if(!Number.isInteger(row?.index)||row.index<1||indices.has(row.index)||typeof row.directory!=='string'||!/^segment-\d{6}$/.test(row.directory)||directories.has(row.directory)||!['complete','deleted'].includes(row.status))throw Error('ZIP 分段清单包含重复或未完成分段');
    indices.add(row.index);directories.add(row.directory);
    if(row.files!==undefined){
      if(!row.files||typeof row.files!=='object'||Array.isArray(row.files)||Object.keys(row.files).some(c=>!cameras.includes(c)))throw Error('ZIP 分段相机清单无效');
      for(const [camera,item] of Object.entries(row.files))if(!item||typeof item!=='object'||(item.name??camera+'.mcap')!==camera+'.mcap')throw Error('ZIP 分段文件名与相机不一致');
    }
  }
  return manifest.segments;
}
/** Only filesystem operations target a fresh, opaque temporary directory. ZIP
 * paths are never passed to the filesystem, even after validation. */
export async function openSessionArchive(file,{signal,onProgress=()=>{},memoryLimit=MEMORY_LIMIT,storage=globalThis.navigator?.storage}={}){
  let directory=null,root=null,release=()=>{};const blobs=[];
  const cleanup=async()=>{try{if(directory){const name=directory.name;directory=null;await root.removeEntry(name,{recursive:true});}}finally{release();}};
  const locks=globalThis.navigator?.locks;
  async function temporaryDirectory(){
    // A live tab holds a lock; only abandoned app directories are removed.
    if(locks&&typeof root.entries==='function')for await(const [name] of root.entries())if(/^multimcap-[0-9a-f-]{36}$/.test(name))await locks.request('multimcap-zip:'+name,{ifAvailable:true},async lock=>{if(lock)await root.removeEntry(name,{recursive:true}).catch(()=>{});});
    const name='multimcap-'+crypto.randomUUID();
    if(locks){
      let ready,failed;const acquired=new Promise((resolve,reject)=>{ready=resolve;failed=reject;}),held=new Promise(resolve=>{release=resolve;});
      locks.request('multimcap-zip:'+name,async()=>{ready();await held;}).catch(failed);await acquired;
    }
    return root.getDirectoryHandle(name,{create:true});
  }
  try{
    const entries=await readZipDirectory(file,{signal}),byName=new Map(entries.map(e=>[e.name,e]));
    const manifests=entries.filter(e=>e.name==='session.json'||e.name.endsWith('/session.json'));
    let groups;
    if(!manifests.length&&entries.length===1&&/\.mcap$/i.test(entries[0].name))groups=[{directory:'',index:1,entries:[entries[0]],cameras:null}];
    else{
      if(manifests.length!==1)throw Error('请导入包含 session.json 的录像 ZIP，或仅包含一个 MCAP 的 ZIP');
      const manifestEntry=manifests[0],prefix=manifestEntry.name.slice(0,-'session.json'.length);
      if(prefix&&(!/^[A-Za-z0-9_.-]+\/$/.test(prefix)||prefix==='./'||prefix==='../'))throw Error('ZIP 必须包含一个安全的会话目录');
      if(entries.some(e=>!e.name.startsWith(prefix)))throw Error('ZIP 包含多个会话目录');
      const manifest=await smallEntry(file,manifestEntry,signal),cameras=validateSession(manifest),segmentEntry=byName.get(prefix+'segments.json');
      const allowed=new Set([prefix+'session.json',prefix+'validation.json']);
      if(segmentEntry){
        allowed.add(segmentEntry.name);
        const rows=validateSegments(await smallEntry(file,segmentEntry,signal),cameras);
        const actual=new Set(entries.map(e=>e.name.slice(prefix.length).split('/')[0]).filter(n=>/^segment-\d{6}$/.test(n)));
        groups=rows.filter(row=>actual.has(row.directory)).sort((a,b)=>a.directory.localeCompare(b.directory)).map(row=>{
          if(row.status!=='complete')throw Error('ZIP 包含未完成或已删除的分段');
          return {...row,cameras,entries:cameras.map(camera=>byName.get(prefix+row.directory+'/'+camera+'.mcap'))};
        });
        if(!groups.length||groups.length!==actual.size)throw Error('ZIP 没有完整分段或包含未登记分段');
      }else groups=[{directory:'',index:1,cameras,entries:cameras.map(camera=>byName.get(prefix+camera+'.mcap'))}];
      for(const group of groups)for(const entry of group.entries){if(!entry)throw Error('ZIP 缺少清单中的相机 MCAP');allowed.add(entry.name);}
      if(entries.some(entry=>!allowed.has(entry.name)))throw Error('ZIP 包含会话清单之外的文件');
      const validation=byName.get(prefix+'validation.json');
      if(validation)await smallEntry(file,validation,signal);
    }
    const selected=groups.flatMap(group=>group.entries),total=selected.reduce((sum,e)=>sum+e.size,0),deflated=selected.filter(e=>e.method===8).reduce((sum,e)=>sum+e.size,0);
    if(total>64*1024**3)throw Error('ZIP 展开后超过 64 GiB 上限');
    if(deflated){
      try{root=await storage?.getDirectory();}catch(error){if(signal?.aborted)throw error;}
      if(root){directory=await temporaryDirectory();}
      else if(deflated>memoryLimit)throw Error('此浏览器无法使用本地临时存储；压缩 ZIP 展开超过 128 MiB，请使用 Chrome/Edge 或先解压');
    }
    let completed=0,lastProgress=0;
    for(const [i,entry] of selected.entries()){
      cancelled(signal);
      const report=()=>onProgress({stage:'extract',bytes:completed,total,entry:entry.name,entries:selected.length});
      report();
      const onBytes=count=>{completed+=count;if(performance.now()-lastProgress>100){lastProgress=performance.now();report();}};
      let blob;
      if(entry.method===0){
        await copyChecked(file,entry,new WritableStream({write(){}}),{signal,onBytes});
        blob=file.slice(entry.offset,entry.offset+entry.size);
      }else if(directory){
        const handle=await directory.getFileHandle(String(i),{create:true});
        await copyChecked(file,entry,await handle.createWritable(),{signal,onBytes});
        blob=await handle.getFile();
      }else{
        const chunks=[];
        await copyChecked(file,entry,new WritableStream({write:b=>chunks.push(b)}),{signal,onBytes});blob=new Blob(chunks);
      }
      blobs.push(blob);report();
    }
    let index=0;
    const sources=groups.map(group=>({...group,entries:undefined,files:group.entries.map(entry=>({index:index++,name:entry.name}))}));
    return {files:blobs,groups:sources,close:cleanup};
  }catch(error){await cleanup().catch(()=>{});cancelled(signal);if(error.name==='QuotaExceededError')throw Error('浏览器本地临时空间不足，请先解压 ZIP 后使用本地版');throw error;}
}
