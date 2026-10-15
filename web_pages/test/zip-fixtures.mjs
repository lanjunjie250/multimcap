import {File} from 'node:buffer';
import {deflateRawSync} from 'node:zlib';
import {crc32} from '../mcap/zip.js';
const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const str=s=>Buffer.concat([u32(Buffer.byteLength(s)),Buffer.from(s)]);
const record=(op,b)=>Buffer.concat([Buffer.from([op]),u64(b.length),b]);
const magic=Buffer.from([0x89,0x4d,0x43,0x41,0x50,0x30,0x0d,0x0a]);
export const stamp=1790746431123456789n;
export function cameraBytes({camera=0,pulses=[0,1,2,3],keys=pulses,delta=0n,sync=true,clock=2,epoch=1}={}){
  const topic='/robot/sensor/camera'+camera,schemas=[record(3,Buffer.concat([u16(1),str('foxglove.CompressedImage'),str('protobuf'),u32(0)]))];
  for(const [id,suffix,encoding] of [[1,'/compressed','protobuf'],[2,'/metadata/raw','application/octet-stream']])schemas.push(record(4,Buffer.concat([u16(id),u16(1),str(topic+suffix),str(encoding),u32(0)])));
  const messages=[];
  for(const [i,pulse] of pulses.entries()){
    const timestamp=stamp+delta+BigInt(pulse)*33333333n+BigInt(camera*17),header=id=>Buffer.concat([u16(id),u32(i+7),u64(timestamp),u64(timestamp)]);
    const nal=Buffer.from([0,0,1,0x67,0x42,0xe0,0x1e,0,0,1,keys.includes(pulse)?0x65:0x41,camera,pulse&255]);
    const video=Buffer.concat([Buffer.from([0x12,nal.length]),nal,Buffer.from([0x1a,4]),Buffer.from('h264')]);
    messages.push(record(5,Buffer.concat([header(1),video])));
    if(sync){const meta=Buffer.alloc(92);meta.write('SBR2');meta.writeUInt16LE(4,4);meta.writeUInt16LE(88,6);meta.writeUInt32LE(92,8);meta.writeBigUInt64LE(BigInt(pulse),40);meta.writeUInt32LE(clock,68);meta.writeUInt32LE(epoch,32);messages.push(record(5,Buffer.concat([header(2),meta])));}
  }
  return Buffer.concat([magic,record(1,Buffer.concat([str(''),str('fixture')])),...schemas,...messages,record(15,u32(0)),record(2,Buffer.alloc(20)),magic]);
}
export function zipFile(entries,{zip64=false,name='session.zip',comment=''}={}){
  const local=[],central=[];let offset=0;
  for(const entry of entries){
    const bytes=Buffer.from(entry.bytes??''),compressed=entry.method===8?deflateRawSync(bytes):bytes,filename=Buffer.from(entry.name),flags=entry.flags??0,method=entry.method??0,crc=entry.crc??crc32(bytes);
    const localExtra=zip64?Buffer.concat([u16(1),u16(16),u64(bytes.length),u64(compressed.length)]):Buffer.alloc(0);
    const extra=zip64?Buffer.concat([u16(1),u16(24),u64(bytes.length),u64(compressed.length),u64(offset)]):Buffer.alloc(0);
    const member=Buffer.concat([u32(0x04034b50),u16(zip64?45:20),u16(flags),u16(method),Buffer.alloc(4),u32(flags&8?0:crc),u32(zip64?0xffffffff:flags&8?0:compressed.length),u32(zip64?0xffffffff:flags&8?0:bytes.length),u16(filename.length),u16(localExtra.length),filename,localExtra,compressed,...(flags&8?[u32(0x08074b50),u32(crc),zip64?u64(compressed.length):u32(compressed.length),zip64?u64(bytes.length):u32(bytes.length)]:[])]);
    central.push(Buffer.concat([u32(0x02014b50),u16(0x031e),u16(zip64?45:20),u16(flags),u16(method),Buffer.alloc(4),u32(crc),u32(zip64?0xffffffff:compressed.length),u32(zip64?0xffffffff:bytes.length),u16(filename.length),u16(extra.length),u16(0),u16(0),u16(0),u32(entry.mode??0),u32(zip64?0xffffffff:offset),filename,extra]));
    local.push(member);offset+=member.length;
  }
  const directory=Buffer.concat(central),notes=Buffer.from(comment),end=Buffer.concat([u32(0x06054b50),u16(0),u16(0),u16(zip64?65535:entries.length),u16(zip64?65535:entries.length),u32(zip64?0xffffffff:directory.length),u32(zip64?0xffffffff:offset),u16(notes.length),notes]);
  const extraEnd=zip64?Buffer.concat([u32(0x06064b50),u64(44),u16(45),u16(45),u32(0),u32(0),u64(entries.length),u64(entries.length),u64(directory.length),u64(offset),u32(0x07064b50),u32(0),u64(offset+directory.length),u32(1)]):Buffer.alloc(0);
  return new File([...local,directory,extraEnd,end],name);
}
export function sessionZip({method=0,zip64=false,pulses=[[0,1,2,3],[0,1,2,3]],keys=pulses,segments=1,missing=null,rows=null,segmentDelta=1000000000n}={}){
  const entries=[{name:'session/session.json',bytes:JSON.stringify({status:'complete',cameras:['A1','A2']}),method}];
  if(segments>1||rows)entries.push({name:'session/segments.json',bytes:JSON.stringify({segments:rows??Array.from({length:segments},(_,i)=>({index:i+1,directory:'segment-'+String(i+1).padStart(6,'0'),status:'complete'}))}),method});
  for(let segment=0;segment<segments;segment++)for(let camera=0;camera<2;camera++){
    const relative=(segments>1||rows?'segment-'+String(segment+1).padStart(6,'0')+'/':'')+'A'+(camera+1)+'.mcap';
    if(relative!==missing)entries.push({name:'session/'+relative,bytes:cameraBytes({camera,pulses:pulses[camera],keys:keys[camera],delta:BigInt(segment)*segmentDelta}),method});
  }
  return zipFile(entries,{zip64});
}
