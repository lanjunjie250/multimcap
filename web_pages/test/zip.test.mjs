import assert from 'node:assert/strict';
import test from 'node:test';
import {File} from 'node:buffer';
import {crc32,readZipDirectory,openSessionArchive} from '../mcap/zip.js';
import {indexArchive} from '../mcap/merge.js';
import {indexRecording} from '../mcap/recording.js';
import {LocalRecording} from '../mcap/session.js';
import {cameraBytes,zipFile,sessionZip} from './zip-fixtures.mjs';
async function open(file,options={}){const archive=await openSessionArchive(file,options);try{return new LocalRecording(archive.files,await indexArchive(archive.files,archive.groups,{name:file.name,size:file.size}),archive.close);}catch(error){await archive.close();throw error;}}
test('CRC32 matches the published check value and supports incremental chunks',()=>{
  const bytes=new TextEncoder().encode('123456789');assert.equal(crc32(bytes),0xcbf43926);assert.equal(crc32(bytes.slice(4),crc32(bytes.slice(0,4))),0xcbf43926);
});
test('stored, deflated and ZIP64 camera sessions preserve exact timing and payloads',async()=>{
  for(const options of [{},{method:8},{zip64:true},{method:8,zip64:true}]){
    const file=sessionZip(options),session=await open(file),m=session.metadata;
    assert.deepEqual(m.streams.map(s=>s.label),['A1','A2']);assert.deepEqual(m.streams.map(s=>s.frame_count),[4,4]);
    assert.equal(m.alignment.common_frames,4);assert.equal(m.alignment.max_span_ns,17);assert.equal(m.streams[0].sync_frame_ids[0],'0');assert.equal(m.message_count,16);
    for(let i=0;i<2;i++){
      const source=new File([cameraBytes({camera:i})],'A'+(i+1)+'.mcap'),single=new LocalRecording(source,await indexRecording(source));
      assert.deepEqual((await session.packets(i,0,4)).map(p=>p.data),(await single.packets(0,0,4)).map(p=>p.data));await single.close();
    }
    await session.close();await assert.rejects(session.packets(0,0,1),{name:'AbortError'});
  }
});
test('merge selects the longest contiguous common interval and a common IDR boundary',async()=>{
  const session=await open(sessionZip({pulses:[[0,1,2,4,5,6,7],[0,1,4,5,6,7]],keys:[[0,2,5],[0,5]]}));
  assert.deepEqual(session.metadata.streams.map(s=>s.sync_frame_ids),[['5','6','7'],['5','6','7']]);
  assert.deepEqual(session.metadata.streams.map(s=>s.keyframes),[[0],[0]]);assert.equal(session.metadata.message_count,12);
  assert.equal(session.metadata.alignment.common_frames,3);await session.close();
});
test('no common pulse, missing synchronization or no common keyframe never invent alignment',async()=>{
  await assert.rejects(open(sessionZip({pulses:[[0,1],[3,4]]})),/没有共同同步帧/);
  await assert.rejects(open(sessionZip({keys:[[],[]]})),/共同关键帧/);
  const files=[{name:'s/session.json',bytes:'{"status":"complete","cameras":["A1","A2"]}'},...['A1','A2'].map((c,i)=>({name:'s/'+c+'.mcap',bytes:cameraBytes({camera:i,sync:false})}))];
  await assert.rejects(open(zipFile(files)),/缺少 SBR2/);
});
test('complete segments join one timeline with rebased offsets and correct keyframes',async()=>{
  const session=await open(sessionZip({segments:2})),m=session.metadata;
  assert.equal(m.segments.length,2);assert.deepEqual(m.streams.map(s=>s.frame_count),[8,8]);assert.deepEqual(m.streams[0].keyframes,[0,1,2,3,4,5,6,7]);
  assert.equal(m.alignment.common_frames,8);assert.equal(m.streams[0].times[4],1);assert.equal(m.message_count,32);assert.equal(m.merged_download,false);
  const packets=await session.packets(0,3,2);assert.equal(packets.length,2);assert.notDeepEqual(packets[0].data,packets[1].data);
  await session.close();
});
test('a single selected segment can carry the full manifest; incomplete cameras are rejected',async()=>{
  const rows=[{index:1,directory:'segment-000001',status:'complete'},{index:2,directory:'segment-000002',status:'complete'}];
  const session=await open(sessionZip({rows}));assert.equal(session.metadata.segments.length,1);await session.close();
  await assert.rejects(open(sessionZip({rows,missing:'segment-000001/A2.mcap'})),/缺少/);
  rows[0].status='deleted';await assert.rejects(open(sessionZip({rows})),/已删除/);
});
test('merged download is standard MCAP with remapped channel IDs and identical video bytes',async()=>{
  const session=await open(sessionZip()),exported=session.exportMerged(),blob=await new Response(exported.stream).blob();assert.equal(blob.size,exported.size);
  const result=await indexRecording(blob),roundTrip=new LocalRecording(blob,result);
  assert.equal(result.metadata.message_count,session.metadata.message_count);
  assert.deepEqual(result.metadata.streams.map(s=>s.timestamps_ns),session.metadata.streams.map(s=>s.timestamps_ns));
  for(let i=0;i<2;i++)assert.deepEqual((await roundTrip.packets(i,0,4)).map(p=>p.data),(await session.packets(i,0,4)).map(p=>p.data));
  await session.close();await roundTrip.close();
});
test('reject unsafe paths, duplicate names, symlinks, encryption, unknown compression and bad CRC',async()=>{
  for(const name of ['/x.mcap','../x.mcap','s/../x.mcap','C:/x.mcap','s\\x.mcap'])await assert.rejects(readZipDirectory(zipFile([{name,bytes:'x'}])),/不安全/);
  await assert.rejects(readZipDirectory(zipFile([{name:'a',bytes:'x'},{name:'a',bytes:'y'}])),/重复/);
  await assert.rejects(readZipDirectory(zipFile([{name:'a',bytes:'x',mode:0xa1ff0000} ])),/非普通/);
  await assert.rejects(readZipDirectory(zipFile([{name:'a',flags:1}])),/加密/);
  await assert.rejects(readZipDirectory(zipFile([{name:'a',method:99}])),/压缩方式/);
  await assert.rejects(openSessionArchive(zipFile([{name:'one.mcap',bytes:cameraBytes(),crc:0}])),/CRC/);
});
test('reject truncated, malformed directories and local-header mismatches',async()=>{
  const file=zipFile([{name:'one.mcap',bytes:cameraBytes()}]);
  await assert.rejects(readZipDirectory(file.slice(0,file.size-1)),/目录/);
  const bytes=new Uint8Array(await file.arrayBuffer());bytes[8]=8;await assert.rejects(readZipDirectory(new File([bytes],'bad.zip')),/不一致/);
  await assert.rejects(readZipDirectory(file,{maxEntries:0}),/限制/);
});
test('ZIP extraction aborts during streaming and memory fallback is bounded',async()=>{
  const controller=new AbortController(),file=sessionZip({method:8});let called=false;
  await assert.rejects(openSessionArchive(file,{signal:controller.signal,onProgress(){called=true;controller.abort();}}),{name:'AbortError'});assert.ok(called);
  await assert.rejects(openSessionArchive(file,{memoryLimit:0,storage:null}),/临时存储/);
});
test('temporary browser storage is cleaned on normal close and failed extraction',async()=>{
  const removed=[],storage={async getDirectory(){return {async getDirectoryHandle(name){return {name,async getFileHandle(){let chunks=[];return {async createWritable(){return new WritableStream({write(b){chunks.push(b);}});},async getFile(){return new Blob(chunks);}};}};},async removeEntry(name){removed.push(name);}};}};
  const archive=await openSessionArchive(sessionZip({method:8}),{storage});assert.equal(removed.length,0);await archive.close();assert.equal(removed.length,1);await archive.close();assert.equal(removed.length,1);
  const file=zipFile([{name:'one.mcap',bytes:cameraBytes(),method:8,crc:0}]);await assert.rejects(openSessionArchive(file,{storage}),/CRC/);assert.equal(removed.length,2);
});
test('a simple ZIP with one MCAP opens without a session manifest',async()=>{
  const session=await open(zipFile([{name:'recording.mcap',bytes:cameraBytes()}]));assert.equal(session.metadata.streams.length,1);assert.equal(session.metadata.streams[0].frame_count,4);await session.close();
});

test('overlapping segments and different synchronization epochs are rejected',async()=>{
  await assert.rejects(open(sessionZip({segments:2,segmentDelta:0n})),/重叠或倒退/);
  const entries=[{name:'s/session.json',bytes:'{"status":"complete","cameras":["A1","A2"]}'},...['A1','A2'].map((c,i)=>({name:'s/'+c+'.mcap',bytes:cameraBytes({camera:i,epoch:i+1})}))];
  await assert.rejects(open(zipFile(entries)),/没有共同同步帧/);
});
test('aggregate ZIP index limits apply across camera files',async()=>{
  const archive=await openSessionArchive(sessionZip());
  try{await assert.rejects(indexArchive(archive.files,archive.groups,{name:'s.zip'},()=>{},{maxMessages:8}),/上限/);await assert.rejects(indexArchive(archive.files,archive.groups,{name:'s.zip'},()=>{},{maxFrames:4}),/上限/);}finally{await archive.close();}
});

test('streaming ZIP data descriptors and end comments use central-directory sizes',async()=>{
  for(const method of [0,8])for(const zip64 of [false,true]){
    const session=await open(zipFile([{name:'one.mcap',bytes:cameraBytes(),method,flags:8}],{zip64,comment:'streamed archive'}));
    assert.equal(session.metadata.streams[0].frame_count,4);await session.close();
  }
});
