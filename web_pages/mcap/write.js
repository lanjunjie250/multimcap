/** Stream an ordinary MCAP from a virtual merge. Payloads remain local slices;
 * only schema/channel IDs and record headers are rewritten. */
const magic=new Uint8Array([0x89,0x4d,0x43,0x41,0x50,0x30,0x0d,0x0a]);
const u16=n=>{const b=new Uint8Array(2);new DataView(b.buffer).setUint16(0,n,true);return b;};
function header(op,size){const b=new Uint8Array(9);b[0]=op;new DataView(b.buffer).setBigUint64(1,BigInt(size),true);return b;}
function string(value){const text=new TextEncoder().encode(value),bytes=new Uint8Array(4+text.length);new DataView(bytes.buffer).setUint32(0,text.length,true);bytes.set(text,4);return bytes;}
export function mergedExport(files,result,isClosed=()=>false){
  const schemas=new Map(),channels=new Map(),definitions=[];let schemaId=1,channelId=1;
  for(const d of result.definitions.filter(d=>d.opcode===3)){
    const key=d.file+':'+d.id;if(schemas.has(key))throw Error('MCAP 包含重复 schema 定义，无法导出');
    schemas.set(key,schemaId);definitions.push({...d,newId:schemaId++});
  }
  for(const d of result.definitions.filter(d=>d.opcode===4)){
    const mapped=d.schema?schemas.get(d.file+':'+d.schema):0;
    if(mapped===undefined)throw Error('MCAP channel 引用了未知 schema');
    channels.set(d.file+':'+d.id,channelId);definitions.push({...d,newId:channelId++,newSchema:mapped});
  }
  if(schemaId>65536||channelId>65536)throw Error('合并后的 schema/channel 数量超出 MCAP 范围');
  const records=[...result.records].sort((a,b)=>BigInt(a.publish)<BigInt(b.publish)?-1:BigInt(a.publish)>BigInt(b.publish)?1:a.file-b.file||a.offset-b.offset);
  const profile=string(''),library=string('MultiMCAP browser merge');
  const messageBytes=records.reduce((n,r)=>n+9+r.length,0),chunk=new Uint8Array(40),chunkView=new DataView(chunk.buffer);
  let firstLog=null,lastLog=null;for(const r of records){const n=BigInt(r.log);if(firstLog===null||n<firstLog)firstLog=n;if(lastLog===null||n>lastLog)lastLog=n;}
  chunkView.setBigUint64(0,firstLog??0n,true);chunkView.setBigUint64(8,lastLog??0n,true);chunkView.setBigUint64(16,BigInt(messageBytes),true);chunkView.setBigUint64(32,BigInt(messageBytes),true);
  const size=16+9+profile.length+library.length+13+29+49+definitions.reduce((n,d)=>n+9+d.length,0)+records.reduce((n,r)=>n+9+r.length,0);
  async function* bytes(blob){const reader=blob.stream().getReader();try{while(true){if(isClosed())throw new DOMException('录像已关闭','AbortError');const part=await reader.read();if(part.done)break;yield part.value;}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
  async function* generate(){
    yield magic;yield header(1,profile.length+library.length);yield profile;yield library;
    for(const d of definitions){
      yield header(d.opcode,d.length);yield u16(d.newId);
      if(d.opcode===4)yield u16(d.newSchema);
      yield* bytes(files[d.file].slice(d.offset+(d.opcode===4?4:2),d.offset+d.length));
    }
    // An uncompressed Chunk also supports the original RTCamera merge tool.
    yield header(6,40+messageBytes);yield chunk;
    for(const r of records){yield header(5,r.length);yield u16(channels.get(r.file+':'+r.channel));yield* bytes(files[r.file].slice(r.offset+2,r.offset+r.length));}
    yield header(15,4);yield new Uint8Array(4);yield header(2,20);yield new Uint8Array(20);yield magic;
  }
  const iterator=generate();
  const stream=new ReadableStream({async pull(controller){try{if(isClosed())throw new DOMException('录像已关闭','AbortError');const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(next.value);}catch(error){controller.error(error);}},async cancel(){await iterator.return();}});
  return {stream,size,name:result.metadata.name.replace(/\.zip$/i,'')+'-merged.mcap'};
}
