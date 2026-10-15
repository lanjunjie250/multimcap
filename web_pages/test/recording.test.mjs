import assert from 'node:assert/strict';
import test from 'node:test';
import {File} from 'node:buffer';
import {FileReadable} from '../mcap/readable.js';
import {indexRecording, routeLabel} from '../mcap/recording.js';
import {LocalRecording} from '../mcap/session.js';

const u16 = n => {const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const u32 = n => {const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64 = n => {const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const str = s => Buffer.concat([u32(Buffer.byteLength(s)),Buffer.from(s)]);
const record = (op, bytes) => Buffer.concat([Buffer.from([op]),u64(bytes.length),bytes]);
const magic = Buffer.from([0x89,0x4d,0x43,0x41,0x50,0x30,0x0d,0x0a]);
const schema = record(3,Buffer.concat([u16(1),str('foxglove.CompressedImage'),str('protobuf'),u32(0)]));
function channel(id,topic,metadata={}) {
 const values=Buffer.concat(Object.entries(metadata).flatMap(([k,v])=>[str(k),str(v)]));
 return record(4,Buffer.concat([u16(id),u16(1),str(topic),str(id%2?'protobuf':'application/octet-stream'),u32(values.length),values]));
}
const stamp=1790746431123456789n;
function fixture({chunk=false,sync=true,pulse=0n,clock=2,epoch=1,compression='',damaged=false}={}) {
 const schemas=[schema],messages=[];
 for(let i=0;i<2;i++) {
  const base='/robot0/sensor/camera'+i,id=i*2+1;
  schemas.push(channel(id,base+'/compressed'));
  schemas.push(channel(id+1,base+'/metadata/raw',{camera_id:'A'+i,logical_vc:String(i)}));
  const nal=Buffer.from([0,0,1,0x67,0x42,0xe0,0x1e,0,0,1,0x65,0x88]);
  const video=Buffer.concat([Buffer.from([0x12,nal.length]),nal,Buffer.from([0x1a,4]),Buffer.from('h264')]);
  const header=target=>Buffer.concat([u16(target),u32(7),u64(stamp+BigInt(i*17)),u64(stamp+BigInt(i*17))]);
  messages.push(record(5,Buffer.concat([header(id),video])));
  if(sync){
   const bytes=Buffer.alloc(92);bytes.write('SBR2');bytes.writeUInt16LE(4,4);bytes.writeUInt16LE(88,6);bytes.writeUInt32LE(bytes.length,8);
   bytes.writeBigUInt64LE(pulse,40);bytes.writeUInt32LE(Array.isArray(clock)?clock[i]:clock,68);bytes.writeUInt32LE(Array.isArray(epoch)?epoch[i]:epoch,32);
   messages.push(record(5,Buffer.concat([header(id+1),bytes])));
  }
 }
 let body=Buffer.concat(messages);
 if(chunk||compression)body=record(6,Buffer.concat([u64(stamp),u64(stamp+17n),u64(body.length),u32(0),str(compression),u64(body.length),body]));
 const bytes=Buffer.concat([magic,record(1,Buffer.concat([str(''),str('test')])),...schemas,body,record(15,u32(0)),record(2,Buffer.concat([u64(0),u64(0),u32(0)])),magic]);
 if(damaged)bytes[bytes.length-1]=0;
 return new File([bytes],'test.mcap');
}

test('bounded reads, exact range checks, cache and close',async()=>{
 const reader=new FileReadable(new Blob([Buffer.alloc(1024)]),{windowBytes:64,maxReadBytes:128});
 await reader.read(0,9);await reader.read(9,9);assert.equal(reader.bytesRead,64);
 await assert.rejects(reader.read(1020,8),/越界/);await assert.rejects(reader.read(0,129),/32 MiB/);
 reader.close();await assert.rejects(reader.read(0,1),{name:'AbortError'});
});
test('legacy route names, exact nanoseconds and pulse zero survive',async()=>{
 const result=await indexRecording(fixture());
 assert.deepEqual(result.metadata.streams.map(s=>s.label),['A1','A2']);
 assert.equal(result.metadata.streams[0].timestamps_ns[0],String(stamp));
 assert.deepEqual(result.metadata.streams[0].sync_frame_ids,['0']);
 assert.equal(result.metadata.alignment.common_frames,1);assert.equal(result.metadata.alignment.max_span_ns,17);
 assert.equal(result.metadata.streams[0].web_codec,'avc1.42E01E');
 const session=new LocalRecording(fixture(),result),packets=await session.packets(0,0,1);
 assert.equal(packets[0].key,true);assert.deepEqual([...packets[0].data.subarray(0,4)],[0,0,1,0x67]);
 session.close();await assert.rejects(session.packets(0,0,1),{name:'AbortError'});
});
test('unchunked and uncompressed chunked absolute offsets produce identical payloads',async()=>{
 for(const chunk of [false,true]){
  const file=fixture({chunk}),result=await indexRecording(file),session=new LocalRecording(file,result);
  assert.equal(result.metadata.streams.length,2);assert.equal(result.metadata.message_count,4);
  const packets=await session.packets(1,0,1);assert.equal(packets[0].data.length,12);session.close();
 }
});
test('missing synchronization does not invent evidence from sequence numbers',async()=>{
 const {metadata}=await indexRecording(fixture({sync:false}));
 assert.equal(metadata.alignment.common_frames,0);assert.deepEqual(metadata.streams[0].sync_frame_ids,[null]);
});
test('damaged magic, compressed chunks and index limits fail explicitly',async()=>{
 await assert.rejects(indexRecording(fixture({damaged:true})),/尾损坏/);
 await assert.rejects(indexRecording(fixture({compression:'zstd'})),/暂不支持 zstd/);
 await assert.rejects(indexRecording(fixture(),()=>{},{maxMessages:1}),/消息数上限/);
 await assert.rejects(indexRecording(fixture(),()=>{},{maxFrames:1}),/视频帧上限/);
});
test('camera label routing matches existing Python mapping',()=>{
 assert.equal(routeLabel('/camera/A0/metadata/raw',{logical_vc:'2'}),'A3');
 assert.equal(routeLabel('/robot0/sensor/camera7/compressed'),'D2');
 assert.equal(routeLabel('/camera/C1/metadata/raw',{logical_vc:'0'}),'C1');
});

test('different clock generations and epochs cannot share a synchronization pulse',async()=>{
 for(const options of [{clock:[2,3]},{epoch:[1,2]}]){
  const {metadata}=await indexRecording(fixture(options));assert.equal(metadata.alignment.common_frames,0);
 }
});
test('Footer offsets and truncation are rejected',async()=>{
 let bytes=Buffer.from(await fixture().arrayBuffer());
 bytes.writeBigUInt64LE(BigInt(bytes.length+100),bytes.length-37+9);
 await assert.rejects(indexRecording(new File([bytes],'bad.mcap')),/Footer/);
 bytes=Buffer.from(await fixture().arrayBuffer());bytes[bytes.length-37]=255;
 await assert.rejects(indexRecording(new File([bytes],'bad.mcap')),/Footer/);
});
test('cancelling a local import terminates its worker and rejects late completion',async()=>{
 const original=globalThis.Worker, workers=[];
 globalThis.Worker=class{constructor(){workers.push(this);}postMessage(){}terminate(){this.terminated=true;}};
 try{
  const controller=new AbortController(),pending=LocalRecording.open(fixture(),{signal:controller.signal});
  const rejected=assert.rejects(pending,{name:'AbortError'});controller.abort();await rejected;
  assert.equal(workers[0].terminated,true);
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(LocalRecording.open(fixture(),{signal:aborted.signal}),{name:'AbortError'});
  assert.equal(workers.length,1);
 }finally{globalThis.Worker=original;}
});
