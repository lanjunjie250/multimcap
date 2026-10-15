/** Virtual session merge: retain source offsets, align each camera group, then
 * join complete segments without copying or uploading encoded video bytes. */
import {indexRecording,timing} from './recording.js';

const arrayFields=['timestamps_ns','log_timestamps_ns','sequences','frame_ids','sync_frame_ids','global_frame_sequences','clock_generations','sync_epochs'];
const syncKey=(s,i)=>s.sync_frame_ids[i]===null?null:s.clock_generations[i]+':'+s.sync_epochs[i]+':'+s.sync_frame_ids[i];
const messageKey=(topic,seq,stamp)=>topic+'\0'+seq+'\0'+stamp;
const append=(target,values)=>{for(const value of values)target.push(value);};
function summary(streams){
  const maps=streams.map(s=>new Map(s.sync_frame_ids.flatMap((_,i)=>syncKey(s,i)===null?[]:[[syncKey(s,i),BigInt(s.timestamps_ns[i])]]))),spans=[];
  if(maps.length>1)for(const [key,stamp] of maps[0])if(maps.every(m=>m.has(key))){let min=stamp,max=stamp;for(const map of maps){const n=map.get(key);if(n<min)min=n;if(n>max)max=n;}spans.push(Number(max-min));}
  spans.sort((a,b)=>a-b);
  return {common_frames:spans.length,min_span_ns:spans[0]||0,max_span_ns:spans.at(-1)||0,p95_span_ns:spans[Math.round((spans.length-1)*.95)]||0,exact_frame_counts:new Set(streams.map(s=>s.frame_count)).size===1};
}
function selectedRow(row,indices,start){
  const selected={...row};
  for(const key of arrayFields)if(row[key])selected[key]=indices.map(i=>row[key][i]);
  Object.assign(selected,timing(indices.map(i=>({publish:BigInt(row.timestamps_ns[i]),log:BigInt(row.log_timestamps_ns[i]),sequence:row.sequences[i]})),start));
  if(row.kind==='video'){
    const keys=new Set(row.keyframes);selected.keyframes=indices.flatMap((i,j)=>keys.has(i)?[j]:[]);selected.frame_count=indices.length;selected.fps=selected.median_interval_ns?1e9/selected.median_interval_ns:0;
  }else selected.message_count=indices.length;
  return selected;
}
function allIndices(row){return row.timestamps_ns.map((_,i)=>i);}
function commonInterval(rows){
  const maps=rows.map(s=>{
    const map=new Map();
    for(let i=0;i<s.frame_count;i++){
      const key=syncKey(s,i);
      if(key===null||s.clock_generations[i]===null||s.sync_epochs[i]===null)throw Error('ZIP 相机缺少 SBR2 同步身份，无法按旧版规则合并');
      if(map.has(key))throw Error('ZIP 相机包含重复同步帧');map.set(key,i);
    }
    if(new Set(s.clock_generations).size!==1)throw Error('ZIP 分段内相机 clock generation 发生变化');
    return map;
  });
  const common=[...maps[0].keys()].filter(k=>maps.every(m=>m.has(k))).map(key=>({key,parts:key.split(':').map(BigInt)})).sort((a,b)=>{
    for(let i=0;i<3;i++)if(a.parts[i]!==b.parts[i])return a.parts[i]<b.parts[i]?-1:1;return 0;
  });
  let best=[],run=[];
  for(const entry of common){const previous=run.at(-1);if(previous&&(entry.parts[0]!==previous.parts[0]||entry.parts[1]!==previous.parts[1]||entry.parts[2]!==previous.parts[2]+1n)){if(run.length>best.length)best=run;run=[];}run.push(entry);}
  if(run.length>best.length)best=run;
  if(!best.length)throw Error('ZIP 中各相机没有共同同步帧');
  const keyframes=rows.map(s=>new Set(s.keyframes));
  const first=best.findIndex(e=>maps.every((m,i)=>keyframes[i].has(m.get(e.key))));
  if(first<0)throw Error('ZIP 连续公共帧内没有共同关键帧起点');
  const keys=best.slice(first).map(e=>e.key);
  return {indices:maps.map(m=>keys.map(key=>m.get(key))),common:common.length,selected:keys.length};
}
function selectGroup(results,group){
  const inputs=group.files.map(({index})=>({file:index,...results[index]}));
  const videos=inputs.flatMap(input=>input.metadata.streams.map(row=>({row,input})));
  if(group.cameras&&(inputs.some(input=>input.metadata.streams.length!==1)||new Set(videos.map(v=>v.row.label)).size!==inputs.length))throw Error('ZIP 相机文件与视频路数不一致');
  const alignment=group.cameras?commonInterval(videos.map(v=>v.row)):null;
  const streams=[],sensors=[],records=[],definitions=[];
  videos.forEach(({row,input},i)=>{
    const indices=alignment?alignment.indices[i]:allIndices(row);
    streams.push({row,indices,file:input.file,locators:indices.map(j=>input.locators[row.id][j])});
  });
  for(const input of inputs){
    const video=streams.filter(s=>s.file===input.file),complete=video.every(s=>s.indices.length===s.row.frame_count),allowed=new Set();
    const pulses=new Set(video.flatMap(s=>s.indices.map(i=>s.row.sync_frame_ids[i])));
    const first=video.reduce((a,s)=>BigInt(s.row.timestamps_ns[s.indices[0]])<a?BigInt(s.row.timestamps_ns[s.indices[0]]):a,BigInt(video[0].row.timestamps_ns[video[0].indices[0]]));
    const last=video.reduce((a,s)=>BigInt(s.row.timestamps_ns[s.indices.at(-1)])>a?BigInt(s.row.timestamps_ns[s.indices.at(-1)]):a,first);
    for(const s of video)for(const i of s.indices)allowed.add(messageKey(s.row.topic,s.row.sequences[i],s.row.timestamps_ns[i]));
    for(const row of input.metadata.sensor_streams){
      const indices=allIndices(row).filter(i=>complete||(row.frame_ids[i]!=='0'||pulses.has('0')?pulses.has(row.frame_ids[i]):BigInt(row.timestamps_ns[i])>=first&&BigInt(row.timestamps_ns[i])<=last));
      sensors.push({row,indices});for(const i of indices)allowed.add(messageKey(row.topic,row.sequences[i],row.timestamps_ns[i]));
    }
    const knownTopics=new Set([...input.metadata.streams,...input.metadata.sensor_streams].map(s=>s.topic));
    append(records,input.records.filter(r=>complete||allowed.has(messageKey(r.topic,r.sequence,r.publish))||(!knownTopics.has(r.topic)&&BigInt(r.publish)>=first&&BigInt(r.publish)<=last)).map(r=>({...r,file:input.file})));
    append(definitions,input.definitions.map(d=>({...d,file:input.file})));
  }
  return {streams,sensors,records,definitions,alignment,group};
}
export function mergeIndexes(results,groups,{name='local.zip',size=0,maxMessages=1_000_000,maxFrames=250_000}={}){
  const selected=groups.map(group=>selectGroup(results,group)),records=selected.flatMap(s=>s.records),definitions=selected.flatMap(s=>s.definitions);
  if(records.length>maxMessages||selected.reduce((n,s)=>n+s.streams.reduce((m,v)=>m+v.indices.length,0),0)>maxFrames)throw Error('ZIP 索引超过消息数或视频帧上限，请按分段导入');
  let start=null,end=null;
  for(const r of records){const t=BigInt(r.publish);if(start===null||t<start)start=t;if(end===null||t>end)end=t;}
  if(start===null)throw Error('ZIP 没有可播放消息');
  const labels=selected[0].streams.map(s=>s.row.label).sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
  for(const segment of selected)if(segment.streams.map(s=>s.row.label).sort().join('\0')!==[...labels].sort().join('\0'))throw Error('ZIP 各分段相机列表不一致');
  const locators=[];
  const streams=labels.map((label,id)=>{
    const chunks=selected.map(segment=>segment.streams.find(s=>s.row.label===label)),first=chunks[0].row,joined={...first,keyframes:[]};
    for(const key of arrayFields)joined[key]=[];
    let count=0,last=null;
    const locations=[];
    for(const chunk of chunks){
      if(chunk.row.codec!==first.codec||chunk.row.web_codec!==first.web_codec)throw Error('ZIP 相机在分段之间更换了编码');
      const row=selectedRow(chunk.row,chunk.indices,start);
      if(last!==null&&BigInt(row.timestamps_ns[0])<=last)throw Error('ZIP 分段时间戳重叠或倒退，无法安全串联');last=BigInt(row.timestamps_ns.at(-1));
      for(const key of arrayFields)append(joined[key],row[key]);
      append(joined.keyframes,row.keyframes.map(i=>i+count));count+=row.frame_count;
      append(locations,chunk.locators.map(location=>({...location,file:chunk.file})));
    }
    locators.push(locations);
    return {...selectedRow({...joined,frame_count:count},allIndices(joined),start),id};
  });
  const sensorMap=new Map();
  for(const segment of selected)for(const {row,indices} of segment.sensors){
    if(!indices.length)continue;
    const key=row.topic+'\0'+row.source;let joined=sensorMap.get(key);
    if(!joined){joined={...row,timestamps_ns:[],log_timestamps_ns:[],sequences:[],frame_ids:[]};sensorMap.set(key,joined);}
    for(const i of indices)for(const field of ['timestamps_ns','log_timestamps_ns','sequences','frame_ids'])joined[field].push(row[field][i]);
  }
  const sensor_streams=[...sensorMap.values()].sort((a,b)=>a.topic.localeCompare(b.topic)||a.source.localeCompare(b.source)).map((row,i)=>{
    const indices=allIndices(row).sort((a,b)=>BigInt(row.timestamps_ns[a])<BigInt(row.timestamps_ns[b])?-1:BigInt(row.timestamps_ns[a])>BigInt(row.timestamps_ns[b])?1:0);
    return {...selectedRow(row,indices,start),id:'sensor-'+i};
  });
  const topicMap=new Map();
  for(const input of results)for(const topic of input.metadata.topics){
    if(!topicMap.has(topic.topic))topicMap.set(topic.topic,{...topic,rows:[]});
    else if(topicMap.get(topic.topic).schema!==topic.schema||topicMap.get(topic.topic).encoding!==topic.encoding)throw Error('ZIP 同名 Topic 的 schema 或编码不同');
  }
  for(const r of records)topicMap.get(r.topic).rows.push(r);
  const topics=[...topicMap.values()].sort((a,b)=>a.topic.localeCompare(b.topic)).map(({rows,...topic},i)=>{
    rows.sort((a,b)=>BigInt(a.publish)<BigInt(b.publish)?-1:BigInt(a.publish)>BigInt(b.publish)?1:0);
    const stats=timing(rows.map(r=>({publish:BigInt(r.publish),log:BigInt(r.log),sequence:r.sequence})),start);
    return {...topic,id:i,messages:rows.length,first_time_ns:rows[0]?.publish??null,last_time_ns:rows.at(-1)?.publish??null,min_interval_ns:stats.min_interval_ns,median_interval_ns:stats.median_interval_ns,max_interval_ns:stats.max_interval_ns,rate_hz:stats.median_interval_ns?1e9/stats.median_interval_ns:0,log_publish_mismatches:rows.filter(r=>r.log!==r.publish).length,source_count:sensor_streams.filter(s=>s.topic===topic.topic).length};
  });
  const segmentAlignments=selected.map(segment=>summary(segment.streams.map(s=>selectedRow(s.row,s.indices,start))));
  const alignment={common_frames:segmentAlignments.reduce((n,s)=>n+s.common_frames,0),min_span_ns:Math.min(...segmentAlignments.map(s=>s.min_span_ns)),max_span_ns:Math.max(...segmentAlignments.map(s=>s.max_span_ns)),p95_span_ns:Math.max(...segmentAlignments.map(s=>s.p95_span_ns)),exact_frame_counts:new Set(streams.map(s=>s.frame_count)).size===1,log_publish_alignment:topics.every(t=>!t.log_publish_mismatches)};
  return {metadata:{recording_id:crypto.randomUUID(),name,path:'本地 ZIP / '+name,size_bytes:size,start_time_ns:String(start),end_time_ns:String(end),start_timestamp_ns:String(start),end_timestamp_ns:String(end),duration:Number(end-start)/1e9,message_count:records.length,parse_ms:results.reduce((n,r)=>n+r.metadata.parse_ms,0),merged_download:groups.length===1,streams,sensor_streams,topics,alignment,segments:groups.map((g,i)=>({index:g.index,directory:g.directory,status:'complete',common_frames_total:selected[i].alignment?.common??segmentAlignments[i].common_frames,aligned_common_frames:selected[i].alignment?.selected??segmentAlignments[i].common_frames})),local_diagnostics:{reader:'local-zip-virtual-merge',files:results.length,segments:groups.length,bytes_read:results.reduce((n,r)=>n+r.metadata.local_diagnostics.bytes_read,0)}},locators,records,definitions};
}
export async function indexArchive(files,groups,info,onProgress=()=>{},options={}){
  const results=[],total=files.reduce((n,f)=>n+f.size,0);let completed=0,messages=0,frames=0;
  const maxMessages=options.maxMessages??1_000_000,maxFrames=options.maxFrames??250_000;
  for(const [i,file] of files.entries()){
    if(messages>=maxMessages||frames>=maxFrames)throw Error('ZIP 索引超过消息数或视频帧上限，请按分段导入');
    const result=await indexRecording(file,p=>onProgress({...p,stage:'index',bytes:completed+p.bytes,total,entry:groups.flatMap(g=>g.files).find(f=>f.index===i)?.name}),{...options,maxMessages:maxMessages-messages,maxFrames:maxFrames-frames,captureRecords:true});
    results.push(result);completed+=file.size;messages+=result.metadata.message_count;frames+=result.metadata.streams.reduce((n,s)=>n+s.frame_count,0);
    if(messages>(options.maxMessages??1_000_000)||frames>(options.maxFrames??250_000))throw Error('ZIP 索引超过消息数或视频帧上限，请按分段导入');
  }
  return mergeIndexes(results,groups,{...info,...options});
}
