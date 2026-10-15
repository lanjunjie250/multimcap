import {LocalRecording} from './mcap/session.js';
import {HandScheduler} from './analysis/scheduler.js';
import {drawHands} from './analysis/overlay.js';
import {displayedAlignment} from './analysis/alignment.js';
import {HandContinuity} from './analysis/continuity.js';
'use strict';

const MAX_READY_FRAMES=12;
const DECODE_AHEAD_SECONDS=0.35;
const PACKET_BATCH=12;
const RENDER_INTERVAL_MS=1000/30;
const SEEK_DEBOUNCE_MS=90;
const $=selector=>document.querySelector(selector);
const cancelImport=$('#cancel-import');
let localRecording=null,importController=null;
const localFileButton=$('#local-file-button'),localFileInput=$('#local-file-input');
const inspector=$('#inspector'),playerRoot=$('#player'),emptyState=$('#empty-state');
const grid=$('#video-grid'),playButton=$('#play-button'),scrubber=$('#scrubber'),timeline=$('#timeline');
const colors=['#168778','#3e73b7','#b57918','#a34b65','#65757a','#6a5ca3'];
let recording=null,players=[],playhead=0,playing=false,rate=1,anchorTime=0,anchorPerformance=0;
let messageTimer=null,seekTimer=null,lastRender=0,issueTimes=[],focusedPlayer=null;
let timelineZoom=1,timelineStart=0,sensorReadouts=[],timestampScale=1;
let showcase=false,showcaseSignature='',showcaseRows=[];

const hands = new HandScheduler(result => {
  for (const player of players) if (analysisApplies(player)) {
    if (player.presentation?.key === result.key) player.presentPending(result);
    else if (player.currentKey === result.key) player.drawHands(result);
  }
}, (status, error = false) => {
  $('#hand-state').textContent = status;
  $('#hand-state').style.color = error ? 'var(--danger)' : '';
  $('#hand-diagnostics').textContent = JSON.stringify({backend: hands.backend || null, workers: hands.lanes.length, completed: hands.completed, skipped: hands.skipped, perStream: hands.perStream, perStreamBackend: hands.perStreamBackend, recovery: hands.recoveryStats}, null, 2);
  if (error) for (const player of players) player.clearHands();
});
function analysisApplies(player) {
  return hands.enabled && !player.tile.hidden && ($('#hand-camera').value === 'all' || $('#hand-camera').value === String(player.stream.id));
}
function resetAnalysis() {
  hands.reset();
  for (const player of players) { player.cancelPresentation(); player.clearHands(); }
}
function refreshAnalysis() {
  resetAnalysis();
  for (const player of players) if (analysisApplies(player) && player.currentKey) hands.offer(player.stream.id, player.currentKey, player.canvas, player.stream.times[player.currentIndex]*1000, true);
}
$('#hand-enabled').addEventListener('change', () => {
  if ($('#hand-enabled').checked) {
    hands.enable(Number($('#hand-count').value));
    refreshAnalysis();
  } else {
    hands.disable();
    for (const player of players) player.clearHands();
    $('#hand-state').textContent = '已关闭';
  }
});
$('#hand-camera').addEventListener('change', refreshAnalysis);
$('#hand-count').addEventListener('change', () => {
  if ($('#hand-enabled').checked) { hands.enable(Number($('#hand-count').value)); refreshAnalysis(); }
});
window.addEventListener('pagehide', () => { hands.disable(); importController?.abort(); localRecording?.close(); });

function formatBytes(value){
  if(value<1024)return value+' B';
  if(value<1024**2)return (value/1024).toFixed(1)+' KiB';
  if(value<1024**3)return (value/1024**2).toFixed(1)+' MiB';
  return (value/1024**3).toFixed(2)+' GiB';
}
function formatTime(value){
  value=Math.max(0,Number(value)||0);const minutes=Math.floor(value/60),seconds=Math.floor(value%60),ms=Math.floor(value*1000)%1000;
  return String(minutes).padStart(2,'0')+':'+String(seconds).padStart(2,'0')+'.'+String(ms).padStart(3,'0');
}
function parseTime(value){
  const parts=String(value).trim().split(':').map(Number);
  if(parts.some(Number.isNaN)||parts.length>3)return null;
  let result=0;for(const part of parts)result=result*60+part;return result;
}
function formatTimestamp(value){
  if(value===null||value===undefined)return '--';
  const ns=BigInt(value),seconds=ns/1000000000n,fraction=String(ns%1000000000n).padStart(9,'0');
  return seconds+'.'+fraction;
}
function formatIntervalNs(value){
  const ns=typeof value==='bigint'?value:BigInt(value||0);
  if(ns>=1000000000n)return (Number(ns)/1e9).toFixed(6)+' s';
  if(ns>=1000000n)return (Number(ns)/1e6).toFixed(6)+' ms';
  if(ns>=1000n)return (Number(ns)/1e3).toFixed(3)+' us';
  return ns+' ns';
}
function showMessage(value,error=false){
  const node=$('#message');node.textContent=value;node.className='message'+(error?' error':'');node.hidden=false;
  clearTimeout(messageTimer);messageTimer=setTimeout(()=>node.hidden=true,5000);
}
function setState(textValue,kind=''){$('#decode-state').className='state '+kind;$('#decode-state span').textContent=textValue;}
function lowerBound(values,target){let low=0,high=values.length;while(low<high){const mid=(low+high)>>1;if(values[mid]<target)low=mid+1;else high=mid;}return low;}
function nearestKeyframe(stream,index){let result=0;for(const keyframe of stream.keyframes){if(keyframe>index)break;result=keyframe;}return result;}
function frameAtOrBefore(stream,time){return Math.max(0,Math.min(stream.times.length-1,lowerBound(stream.times,time+0.000001)-1));}
function messageAtOrBefore(stream,time){return Math.min(stream.times.length-1,lowerBound(stream.times,time+1e-9)-1);}
function displayedStreams(data){return [...data.streams,...data.sensor_streams.filter(stream=>stream.kind!=='metadata')];}

class StreamPlayer{
  constructor(stream,index,useWebCodecs){
    this.stream=stream;this.index=index;this.useWebCodecs=!!useWebCodecs;this.hardwarePreference=useWebCodecs||'no-preference';this.targetIndex=0;this.frames=[];this.nextIndex=0;
    this.fetching=false;this.generation=0;this.drawnTimestamp=-1;this.lastRequested=-1;this.decodedFrames=0;this.drawnFrames=0;this.scale=1;this.metaIndex=-1;
    this.tile=document.createElement('article');this.tile.className='video-tile';
    this.tile.innerHTML='<div class="video-head"><strong></strong><span class="stream-facts"></span><div class="image-tools"><button class="image-zoom-out" type="button" title="缩小图像" aria-label="缩小图像">−</button><button class="image-zoom-reset" type="button" title="恢复图像大小" aria-label="恢复图像大小">1×</button><button class="image-zoom-in" type="button" title="放大图像" aria-label="放大图像">+</button><button class="tile-focus" type="button" title="单路查看" aria-label="单路查看">□</button></div></div><canvas></canvas><div class="frame-meta"><span></span><b></b></div><div class="video-empty">等待解码</div>';
    this.tile.querySelector('strong').textContent=stream.label;
    this.tile.querySelector('.stream-facts').textContent=stream.codec.toUpperCase()+' · '+stream.frame_count+' 帧 · '+stream.fps.toFixed(2)+' fps';
    this.tile.querySelector('.tile-focus').addEventListener('click',()=>setFocusedPlayer(focusedPlayer===this?null:this));
    this.tile.querySelector('.image-zoom-out').addEventListener('click',()=>this.setScale(this.scale/1.25));
    this.tile.querySelector('.image-zoom-reset').addEventListener('click',()=>this.setScale(1));
    this.tile.querySelector('.image-zoom-in').addEventListener('click',()=>this.setScale(this.scale*1.25));
    this.canvas=this.tile.querySelector('canvas');this.context=this.canvas.getContext('2d',{alpha:false});this.overlay=this.tile.querySelector('.video-empty');
    this.frameMeta=this.tile.querySelector('.frame-meta');
    this.handCanvas=document.createElement('canvas');this.handCanvas.className='hand-overlay';this.tile.append(this.handCanvas);
    this.handLabel=document.createElement('span');this.handLabel.className='hand-label';this.handLabel.hidden=true;this.tile.append(this.handLabel);
    this.currentKey=null;this.currentIndex=-1;this.presentation=null;
    this.handContinuity=new HandContinuity();
    grid.append(this.tile);this.decoder=null;
    if(useWebCodecs){
      this.decoder=new VideoDecoder({output:frame=>this.onFrame(frame),error:error=>this.fallbackToJpeg(error)});
      this.configureDecoder();
    }else this.overlay.textContent='浏览器不支持此视频编码';
  }
  setScale(value){this.scale=Math.max(1,Math.min(4,value));this.canvas.style.transform='scale('+this.scale+')';this.handCanvas.style.transform=this.canvas.style.transform;this.tile.querySelector('.image-zoom-reset').textContent=this.scale.toFixed(1).replace('.0','')+'×';}
  frameKey(index){return recording.recording_id+':'+this.stream.id+':'+index;}
  clearHands(){
    this.handContinuity.reset();drawHands(this.handCanvas,null);this.handCanvas.hidden=true;this.handLabel.hidden=true;
    for(const key of ['frameKey','sourceFrameKeys','heldCount','detectedCount'])delete this.handCanvas.dataset[key];
  }
  drawHands(result){
    const visible=this.handContinuity.update(result,this.stream.times[this.currentIndex]*1000,Number($('#hand-count').value));
    drawHands(this.handCanvas,visible);this.handCanvas.hidden=false;this.handLabel.hidden=false;
    this.handLabel.textContent=visible.heldCount?
      '检测 '+visible.detectedCount+' 只 · 短时估计 '+visible.heldCount+' 只':
      visible.hands.length?'检测到 '+visible.hands.length+' 只手':'未检测到手';
    // frameKey identifies the displayed image. sourceFrameKeys separately
    // records the provenance of any landmarks retained from earlier images.
    this.handCanvas.dataset.frameKey=result.key;
    this.handCanvas.dataset.sourceFrameKeys=JSON.stringify(visible.hands.map(hand=>hand.sourceKey));
    this.handCanvas.dataset.heldCount=visible.heldCount;
    this.handCanvas.dataset.detectedCount=visible.detectedCount;
  }
  displayed(index, source, result=null){
    this.currentIndex=index;this.currentKey=this.frameKey(index);this.canvas.dataset.frameKey=this.currentKey;
    if(this.handCanvas.width!==this.canvas.width)this.handCanvas.width=this.canvas.width;
    if(this.handCanvas.height!==this.canvas.height)this.handCanvas.height=this.canvas.height;
    this.updateMeta(index);
    if(analysisApplies(this)){
      result=result||hands.cache.get(this.currentKey);
      if(result)this.drawHands(result);
      else {this.clearHands();hands.offer(this.stream.id,this.currentKey,source,this.stream.times[index]*1000,true);}
    }else this.clearHands();
    updateShowcase();
  }
  cancelPresentation(){if(this.presentation){this.presentation.source.close();this.lastRequested=-1;}this.presentation=null;}
  presentPending(result=null){
    const pending=this.presentation;if(!pending)return;
    this.presentation=null;
    const {index,source}=pending;
    const width=source.displayWidth||source.width||source.codedWidth,height=source.displayHeight||source.height||source.codedHeight;
    if(this.canvas.width!==width||this.canvas.height!==height){this.canvas.width=width;this.canvas.height=height;}
    this.context.drawImage(source,0,0,width,height);
    this.displayed(index,source,result);
    source.close();this.drawnTimestamp=this.stream.times[index];this.drawnFrames++;this.overlay.hidden=true;
  }
  stageFrame(index,source){
    this.cancelPresentation();
    const key=this.frameKey(index);
    this.presentation={key,index,source,started:performance.now()};
    if(!analysisApplies(this)||!hands.ready){this.presentPending();return;}
    const result=hands.cache.get(key);
    if(result)this.presentPending(result);
    else hands.offer(this.stream.id,key,source,this.stream.times[index]*1000,true);
  }
  waitForHands(){
    if(!this.presentation)return false;
    // Keep the previous image AND its matching overlay until the next pair is ready.
    // A stalled model must never stop playback indefinitely.
    if(!analysisApplies(this)||!hands.ready||performance.now()-this.presentation.started>=750){
      this.presentPending();
    }
    return true;
  }
  updateMeta(index){
    if(index===this.metaIndex)return;this.metaIndex=index;
    if(index<0){this.frameMeta.querySelector('span').textContent='等待首帧';this.frameMeta.querySelector('b').textContent='--';return;}
    const timestamp=this.stream.timestamps_ns[index],previous=index?this.stream.timestamps_ns[index-1]:null;
    const frameId=this.stream.frame_ids?.[index]||String(this.stream.sequences[index]);
    const label=document.createElement('small'),stamp=document.createElement('code');
    label.textContent='F'+frameId+' · 采集序号 #'+this.stream.sequences[index]+' · ';
    stamp.textContent=formatTimestamp(timestamp)+' s';
    this.frameMeta.querySelector('span').replaceChildren(label,stamp);
    this.frameMeta.querySelector('b').textContent=previous?'间隔 '+formatIntervalNs(BigInt(timestamp)-BigInt(previous)):'首帧';
  }
  configureDecoder(){this.decoder.configure({codec:this.stream.web_codec,optimizeForLatency:true,hardwareAcceleration:this.hardwarePreference});}
  closeFrames(){for(const frame of this.frames)frame.close();this.frames=[];}
  reset(target){
    this.cancelPresentation();
    this.currentKey=null;this.currentIndex=-1;this.metaIndex=-1;this.clearHands();this.generation++;this.fetching=false;this.lastRequested=-1;this.closeFrames();this.drawnTimestamp=-1;
    const targetIndex=frameAtOrBefore(this.stream,target);this.targetIndex=targetIndex;
    this.nextIndex=nearestKeyframe(this.stream,targetIndex);this.overlay.hidden=false;this.overlay.className='video-empty';this.overlay.textContent='正在定位';
    if(this.decoder){this.decoder.reset();this.configureDecoder();this.fill(target+DECODE_AHEAD_SECONDS);}else this.fail(Error('浏览器不支持 '+this.stream.codec.toUpperCase()+'，请使用支持该编码的 Chrome/Edge 或原本地服务'));
  }
  fail(error){
    this.overlay.hidden=false;this.overlay.className='video-empty video-error';this.overlay.textContent='解码失败';
    showMessage(this.stream.label+': '+error.message,true);
  }
  fallbackToJpeg(error){
    this.generation++;this.cancelPresentation();this.closeFrames();
    if(this.decoder?.state!=='closed')this.decoder?.close();
    this.decoder=null;this.useWebCodecs=false;this.fetching=false;
    if(this.hardwarePreference==='prefer-hardware'){
      this.hardwarePreference='no-preference';this.useWebCodecs=true;
      this.decoder=new VideoDecoder({output:frame=>this.onFrame(frame),error:next=>this.fallbackToJpeg(next)});
      this.reset(playhead);updateDecodeState();return;
    }
    this.fail(Error('浏览器解码失败：'+error.message+'。试用版需要浏览器原生支持该视频编码。'));
  }
  onFrame(frame){
    if(this.destroyed){frame.close();return;}
    this.decodedFrames++;this.frames.push(frame);
    while(this.frames.length>MAX_READY_FRAMES)this.frames.shift().close();
  }
  async fill(until){
    if(!this.decoder||this.fetching||this.nextIndex>=this.stream.times.length||this.decoder.state!=='configured')return;
    const decodedUntil=this.nextIndex?this.stream.times[this.nextIndex-1]:-1;
    if(decodedUntil>=until||this.decoder.decodeQueueSize>=MAX_READY_FRAMES)return;
    const generation=this.generation,start=this.nextIndex;this.fetching=true;
    try{
      const packets=await localRecording.packets(this.stream.id,start,PACKET_BATCH);
      if(generation!==this.generation)return;
      for(const packet of packets){
        this.decoder.decode(new EncodedVideoChunk({type:packet.key?'key':'delta',timestamp:packet.index,data:packet.data}));
      }
      this.nextIndex+=packets.length;
      if(this.nextIndex===this.stream.times.length)await this.decoder.flush();
    }catch(error){if(generation===this.generation)this.fail(error);}finally{if(generation===this.generation)this.fetching=false;}
    if(generation===this.generation&&this.frames.length<MAX_READY_FRAMES)this.fill(until);
  }
  render(time){
    if(this.waitForHands()){if(this.decoder)this.fill(time+DECODE_AHEAD_SECONDS);return;}
    if(!this.decoder)return;
    this.fill(time+DECODE_AHEAD_SECONDS);let selected=null;
    while(this.frames.length&&this.stream.times[this.frames[0].timestamp]<=time+0.012){if(selected)selected.close();selected=this.frames.shift();}
    if(!selected){if(analysisApplies(this)&&this.currentKey)hands.offer(this.stream.id,this.currentKey,this.canvas,this.stream.times[this.currentIndex]*1000,true);return;}
    this.stageFrame(selected.timestamp,selected);
  }
  destroy(){this.destroyed=true;this.cancelPresentation();this.generation++;this.closeFrames();if(this.decoder&&this.decoder.state!=='closed')this.decoder.close();this.tile.remove();}
}

function setFocusedPlayer(player){
  focusedPlayer=player;grid.classList.toggle('focused',!!player);
  for(const item of players){const active=item===player;item.tile.classList.toggle('focused-tile',active);item.tile.hidden=!!player&&!active;item.tile.querySelector('.tile-focus').textContent=active?'▣':'□';item.tile.querySelector('.tile-focus').title=active?'恢复多路':'放大';}
  refreshAnalysis();
  updateShowcase();
}
$('#showcase-toggle').addEventListener('click',()=>{
  showcase=!showcase;setTimestampExpanded(false);
  playerRoot.classList.toggle('showcase',showcase);
  $('#showcase-evidence').hidden=!showcase;
  $('#showcase-toggle').textContent=showcase?'退出录屏展示':'录屏展示';
  $('#showcase-toggle').setAttribute('aria-pressed',String(showcase));
  showcaseSignature='';updateShowcase();layoutVideos();resizeTimeline();
});
function updateShowcase(){
  if(!showcase||!recording)return;
  const visible=players.filter(player=>!player.tile.hidden);
  const signature=visible.map(player=>player.currentKey||'waiting').join('|');
  if(signature===showcaseSignature)return;showcaseSignature=signature;
  if(showcaseRows.length!==visible.length){
    $('#showcase-readouts').replaceChildren();
    showcaseRows=visible.map(()=>{
      const row=document.createElement('div');row.className='showcase-row';
      row.innerHTML='<div><strong></strong><span></span></div><code><span></span><em></em></code><small></small>';
      $('#showcase-readouts').append(row);return row;
    });
  }
  const frames=visible.map(player=>{
    const index=player.currentIndex,stream=player.stream;
    return index<0?null:{timestamp:stream.timestamps_ns[index],pulse:stream.sync_frame_ids?.[index],
      epoch:stream.sync_epochs?.[index],clock:stream.clock_generations?.[index]};
  });
  const alignment=displayedAlignment(frames);
  const messages={single:'单路查看 · 不计算跨相机跨度',waiting:'等待画面',
    unidentified:'录制缺少同步帧标识',mismatch:'各路画面更新中 · 暂停可查看同帧'};
  $('#showcase-span').textContent=alignment.status==='aligned'?alignment.span+' ns':'—';
  $('#showcase-status').textContent=alignment.status==='aligned'?
    visible.length+' 路同帧 · F'+alignment.pulse:messages[alignment.status];
  $('#showcase-evidence').dataset.alignment=alignment.status;
  $('#showcase-source').textContent=recording.name;
  visible.forEach((player,i)=>{
    const row=showcaseRows[i],frame=frames[i],index=player.currentIndex;
    row.dataset.frameKey=player.currentKey||'';
    row.querySelector('strong').textContent=player.stream.label;
    row.querySelector('div span').textContent=frame?.pulse!=null?'F'+frame.pulse:frame?'#'+player.stream.sequences[index]:'等待画面';
    const stamp=frame?formatTimestamp(frame.timestamp):'—';
    row.querySelector('code span').textContent=frame?stamp.slice(0,-3):stamp;
    row.querySelector('em').textContent=frame?stamp.slice(-3):'';
    row.querySelector('small').textContent=alignment.status==='aligned'?
      '距同帧最早时间戳 +'+alignment.offsets[i]+' ns':frame?'当前已显示图像的时间戳':'正在解码';
  });
}
function layoutVideos(){
  const count=players.length;if(!count)return;
  const portrait=grid.clientHeight>grid.clientWidth||grid.clientWidth<800;
  const columns=count===1?1:count<=4?2:portrait?2:count<=6?3:4;
  grid.style.gridTemplateColumns='repeat('+columns+',minmax(0,1fr))';
  grid.style.gridTemplateRows='repeat('+Math.ceil(count/columns)+',minmax(0,1fr))';
}
$('#video-fullscreen').addEventListener('click',async()=>{
  try{
    if(document.fullscreenElement===playerRoot)await document.exitFullscreen();
    else {setTimestampExpanded(false);await playerRoot.requestFullscreen();}
  }catch(error){showMessage('无法进入全屏：'+error.message,true);}
});
document.addEventListener('fullscreenchange',()=>{
  const active=document.fullscreenElement===playerRoot,button=$('#video-fullscreen');
  button.textContent=active?'退出全屏':'画面全屏';button.setAttribute('aria-pressed',String(active));
  layoutVideos();resizeTimeline();
});
$('#timestamp-toggle').addEventListener('click',()=>{
  const panel=$('#sensor-panel'),collapsed=panel.classList.toggle('collapsed');
  $('#timestamp-toggle').textContent=collapsed?'展开时间戳':'收起时间戳';
  $('#timestamp-toggle').setAttribute('aria-expanded',String(!collapsed));
});
function stopPlayers(){resetAnalysis();setFocusedPlayer(null);for(const player of players)player.destroy();players=[];grid.replaceChildren();}
function setPlaying(value){
  if(value&&(!recording||playhead>=recording.duration))seek(0);
  playing=!!value;anchorTime=playhead;anchorPerformance=performance.now();
  playButton.querySelector('span').textContent=playing?'Ⅱ':'▶';playButton.title=playing?'暂停':'播放';playButton.setAttribute('aria-label',playButton.title);
}
function seek(value,reset=true){
  if(!recording)return;playhead=Math.max(0,Math.min(recording.duration,Number(value)||0));anchorTime=playhead;anchorPerformance=performance.now();
  keepPlayheadVisible();if(reset){resetAnalysis();for(const player of players)player.reset(playhead);}updateClock();drawTimeline();
}
function scheduleSeek(value){
  resetAnalysis();seek(value,false);clearTimeout(seekTimer);seekTimer=setTimeout(()=>seek(value,true),SEEK_DEBOUNCE_MS);
}
function updateClock(){
  $('#current-time').textContent=formatTime(playhead);if(document.activeElement!==$('#time-input'))$('#time-input').value=formatTime(playhead);scrubber.value=playhead;updateSensorReadouts();updateCurrentFrameAlignment();updateShowcase();
}
function renderLoop(now){
  requestAnimationFrame(renderLoop);if(now-lastRender<RENDER_INTERVAL_MS)return;lastRender=now;
  if(playing&&recording){playhead=anchorTime+(now-anchorPerformance)/1000*rate;if(playhead>=recording.duration){playhead=recording.duration;setPlaying(false);}keepPlayheadVisible();}
  for(const player of players)player.render(playhead);updateClock();drawTimeline();
}

function timelineStreams(){
  const streams=recording?displayedStreams(recording):[],kind=$('#timeline-filter').value;
  return kind==='all'?streams:streams.filter(stream=>stream.kind===kind);
}
function timelineColor(stream){return colors[displayedStreams(recording).indexOf(stream)%colors.length];}
function updateTimelineTracks(){
  const streams=timelineStreams(),legend=$('#timeline-legend');legend.replaceChildren();
  for(const stream of streams){
    const item=document.createElement('span');item.className='legend-item';item.innerHTML='<i></i><span></span>';
    item.querySelector('i').style.background=timelineColor(stream);
    item.querySelector('span').textContent=stream.label+' · '+(stream.frame_count||stream.message_count)+' 条';legend.append(item);
  }
  $('.timeline-wrap').style.height=Math.max(64,20+streams.length*20)+'px';
  $('.timeline-scroll').scrollTop=0;resizeTimeline();
}
function resizeTimeline(){
  const ratio=devicePixelRatio||1,rect=timeline.getBoundingClientRect(),width=Math.max(1,Math.round(rect.width*ratio)),height=Math.max(1,Math.round(rect.height*ratio));
  if(timeline.width!==width||timeline.height!==height){timeline.width=width;timeline.height=height;}drawTimeline();
}
function timelineBounds(){
  if(!recording)return [0,1];const width=recording.duration/Math.max(1,timelineZoom);
  timelineStart=Math.max(0,Math.min(Math.max(0,recording.duration-width),timelineStart));return [timelineStart,timelineStart+width];
}
function keepPlayheadVisible(){
  if(!recording||timelineZoom===1)return;const [start,end]=timelineBounds(),width=end-start;
  if(playhead<start||playhead>end){timelineStart=Math.max(0,Math.min(recording.duration-width,playhead-width/2));updateScrubberWindow();}
}
function updateScrubberWindow(){
  const [start,end]=timelineBounds();scrubber.min=start;scrubber.max=end;
  $('#timeline-window').textContent=timelineZoom===1?'全时段':formatTime(start)+' - '+formatTime(end)+' · '+timelineZoom.toFixed(0)+'×';
}
function zoomTimeline(factor){
  if(!recording)return;const oldZoom=timelineZoom;timelineZoom=Math.max(1,Math.min(64,timelineZoom*factor));
  const oldWidth=recording.duration/oldZoom,newWidth=recording.duration/timelineZoom;
  const ratio=oldWidth?Math.max(0,Math.min(1,(playhead-timelineStart)/oldWidth)):0.5;
  timelineStart=Math.max(0,Math.min(recording.duration-newWidth,playhead-ratio*newWidth));updateScrubberWindow();drawTimeline();
}
function drawTimeline(){
  const context=timeline.getContext('2d'),ratio=devicePixelRatio||1,width=timeline.width,height=timeline.height;context.clearRect(0,0,width,height);context.save();context.scale(ratio,ratio);
  const lanes=timelineStreams(),[viewStart,viewEnd]=timelineBounds(),viewDuration=Math.max(0.000001,viewEnd-viewStart);
  const cssWidth=width/ratio,cssHeight=height/ratio,left=100,right=8,plotWidth=Math.max(1,cssWidth-left-right),laneHeight=Math.max(12,(cssHeight-20)/Math.max(1,lanes.length));
  context.font='11px Arial';context.textBaseline='middle';
  if(recording){
    for(let i=0;i<lanes.length;i++){
      const stream=lanes[i],y=8+i*laneHeight+laneHeight/2;context.fillStyle='#536165';context.fillText(stream.label.slice(0,14),4,y);
      context.fillStyle='#dce4e4';context.fillRect(left,y-3,plotWidth,6);
      const first=lowerBound(stream.times,viewStart),last=lowerBound(stream.times,viewEnd),stride=Math.max(1,Math.ceil((last-first)/Math.max(1,plotWidth)));
      context.fillStyle=timelineColor(stream);for(let j=first;j<last;j+=stride){const x=left+(stream.times[j]-viewStart)/viewDuration*plotWidth;context.fillRect(x,y-3,Math.max(1,timelineZoom/8),6);}
      context.fillStyle='#c13e47';for(const gap of stream.gaps){const value=stream.times[gap];if(value>=viewStart&&value<=viewEnd){const x=left+(value-viewStart)/viewDuration*plotWidth;context.fillRect(x-1,y-6,2,12);}}
    }
    const x=left+(playhead-viewStart)/viewDuration*plotWidth;context.fillStyle='#15292d';context.fillRect(x-1,2,2,cssHeight-9);
    context.beginPath();context.moveTo(x-5,2);context.lineTo(x+5,2);context.lineTo(x,8);context.fill();
  }
  context.restore();
}
function buildSensorReadouts(data){
  const root=$('#sensor-readouts');root.replaceChildren();sensorReadouts=[];
  for(const stream of displayedStreams(data)){
    const row=document.createElement('div');row.className='sensor-row '+stream.kind;row.innerHTML='<strong></strong><span class="sensor-topic"></span><span class="sensor-sequence"></span><code></code><span class="sensor-previous"></span><b></b>';
    row.querySelector('strong').textContent=stream.label;row.querySelector('.sensor-topic').textContent=stream.topic;root.append(row);sensorReadouts.push({stream,row,index:-2});
  }
}
function updateSensorReadouts(){
  for(const item of sensorReadouts){const stream=item.stream,index=messageAtOrBefore(stream,playhead);if(index===item.index)continue;item.index=index;
    if(index<0){item.row.querySelector('.sensor-sequence').textContent='--';item.row.querySelector('code').textContent='等待首条消息';item.row.querySelector('.sensor-previous').textContent='T-1 --';item.row.querySelector('b').textContent='--';continue;}
    const timestamp=stream.timestamps_ns[index],previous=index?stream.timestamps_ns[index-1]:null;
    const frameId=stream.frame_ids?.[index],frameText=frameId&&frameId!=='0'?'F'+frameId+' · ':'';
    item.row.querySelector('.sensor-sequence').textContent=frameText+'#'+stream.sequences[index];item.row.querySelector('code').textContent='T   '+formatTimestamp(timestamp)+' s';
    item.row.querySelector('.sensor-previous').textContent=previous?'T-1 '+formatTimestamp(previous)+' s':'T-1 --';
    item.row.querySelector('b').textContent=previous?'Δ '+formatIntervalNs(BigInt(timestamp)-BigInt(previous)):'首条消息';
  }
}
function updateCurrentFrameAlignment(){
  const visible=players.filter(player=>!player.tile.hidden);
  const alignment=displayedAlignment(visible.map(player=>{
    const i=player.currentIndex,s=player.stream;
    return i<0?null:{timestamp:s.timestamps_ns[i],pulse:s.sync_frame_ids[i],epoch:s.sync_epochs[i],clock:s.clock_generations[i]};
  }));
  const ok=alignment.status==='aligned';
  $('#fact-current-frame').textContent=ok?'F'+alignment.pulse:'—';
  $('#fact-current-span').textContent=ok?formatIntervalNs(alignment.span):'—';
  $('#timestamp-focus-summary').textContent=ok?'F'+alignment.pulse+' · '+visible.length+' CAM Δ '+formatIntervalNs(alignment.span):'等待同帧同步画面';
}
function setTimestampScale(value){
  timestampScale=Math.max(.8,Math.min(2,Number(value)||1));$('#sensor-panel').style.setProperty('--timestamp-scale',timestampScale);$('#timestamp-zoom-reset').textContent=timestampScale.toFixed(1).replace('.0','')+'×';
}
function setTimestampExpanded(value){
  const panel=$('#sensor-panel'),button=$('#timestamp-expand'),expanded=!!value;panel.classList.toggle('expanded',expanded);document.body.classList.toggle('timestamp-focus',expanded);button.textContent=expanded?'×':'⛶';button.title=expanded?'退出时间戳单独查看':'单独查看时间戳';button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(expanded));
}
function fillInspector(data){
  const fileSummary=$('#file-summary');fileSummary.replaceChildren();
  const fileFacts=[['文件',data.name],['路径',data.path],['大小',formatBytes(data.size_bytes)],['消息总数',data.message_count.toLocaleString()],['开始 publish_time',formatTimestamp(data.start_timestamp_ns)+' s'],['结束 publish_time',formatTimestamp(data.end_timestamp_ns)+' s']];
  for(const [label,value] of fileFacts){const item=document.createElement('div');item.innerHTML='<span></span><code></code>';item.querySelector('span').textContent=label;item.querySelector('code').textContent=value;fileSummary.append(item);}
  const alignment=data.alignment,summary=$('#alignment-summary');summary.replaceChildren();
  const facts=[['公共帧',alignment.common_frames.toLocaleString()],['P95 偏差',formatIntervalNs(alignment.p95_span_ns)],['最大偏差',formatIntervalNs(alignment.max_span_ns)],['帧数一致',alignment.exact_frame_counts?'是':'否'],['时间戳一致',alignment.log_publish_alignment?'是':'否'],['解析耗时',data.parse_ms.toFixed(1)+' ms']];
  for(const [label,value] of facts){const item=document.createElement('div');item.innerHTML='<span></span><strong></strong>';item.querySelector('span').textContent=label;item.querySelector('strong').textContent=value;summary.append(item);}
  const topics=$('#topic-list');topics.replaceChildren();for(const topic of data.topics){const item=document.createElement('div');item.className='topic-row';item.innerHTML='<strong></strong><span></span><i></i><code></code>';item.querySelector('strong').textContent=topic.topic;item.querySelector('span').textContent=(topic.schema||'无 schema')+' · '+topic.encoding;item.querySelector('i').textContent=topic.messages.toLocaleString()+' 条'+(topic.source_count>1?' · '+topic.source_count+' 路源':'');const interval=topic.messages>1?'间隔 '+formatIntervalNs(topic.median_interval_ns)+'（'+formatIntervalNs(topic.min_interval_ns)+' - '+formatIntervalNs(topic.max_interval_ns)+'） · '+topic.rate_hz.toFixed(2)+' Hz':'无间隔';item.querySelector('code').textContent=topic.source_count>1?'聚合消息'+interval+'；单路间隔见拆分行':interval;topics.append(item);}
}
function rebuildIssues(){
  issueTimes=[...new Set(players.flatMap(player=>player.stream.gap_events.map(event=>event.time)))].sort((a,b)=>a-b);
  $('#issue-count').textContent=issueTimes.length+' 个问题';
}
function jumpIssue(direction){
  if(!issueTimes.length)return;let index=lowerBound(issueTimes,playhead+(direction>0?0.001:-0.001));
  if(direction<0)index=Math.max(0,index-1);else index=Math.min(issueTimes.length-1,index);seek(issueTimes[index]);
}
function stepFrame(direction){
  if(!recording||!recording.streams.length)return;const times=recording.streams[0].times;let index=lowerBound(times,playhead);
  if(direction<0){if(index>=times.length||times[index]>=playhead-0.000001)index--;}else if(index<times.length&&times[index]<=playhead+0.000001)index++;
  seek(times[Math.max(0,Math.min(times.length-1,index))]);
}
function updatePerformance(){
  if(!recording)return;const now=performance.now();let output=0,queue=0,maxLag=0;
  for(const player of players){output+=player.drawnFrames;player.drawnFrames=0;queue+=player.frames.length+(player.decoder?.decodeQueueSize||0);if(player.drawnTimestamp>=0)maxLag=Math.max(maxLag,Math.abs(playhead-player.drawnTimestamp));}
  const elapsed=Math.max(0.001,(now-(updatePerformance.last||now-1000))/1000);updatePerformance.last=now;
  $('#performance-state').textContent='输出 '+(output/elapsed).toFixed(1)+' fps · 解码队列 '+queue+' 帧';
  $('#frame-state').textContent='画面偏差 '+(maxLag*1000).toFixed(1)+' ms';
}
function updateDecodeState(){
  if(!players.length)return;
  const accelerated=players.filter(player=>player.useWebCodecs).length;
  const preferred=players.filter(player=>player.useWebCodecs&&player.hardwarePreference==='prefer-hardware').length;
  setState(accelerated===players.length?(preferred===players.length?'WebCodecs · GPU 优先':'WebCodecs · 自动解码'):accelerated?accelerated+'/'+players.length+' 路 WebCodecs':'浏览器不支持此编码',accelerated?'ready':'error');
}

function installRecording(data){
  recording=data;
  $('#hand-camera').replaceChildren(new Option('全部可见相机','all'),...data.streams.map(stream=>new Option(stream.label,String(stream.id))));
  timelineZoom=1;timelineStart=0;inspector.hidden=true;
  $('#download-merged-button').hidden=true;
  $('#recording-name').textContent=data.name;$('#recording-path').textContent=data.path;
  $('#fact-duration').textContent=formatTime(data.duration);$('#fact-size').textContent=formatBytes(data.size_bytes);
  $('#fact-messages').textContent=data.message_count.toLocaleString();$('#fact-start').textContent=new Date(Number(BigInt(data.start_timestamp_ns)/1000000n)).toLocaleString();
  $('#fact-common').textContent=data.alignment.common_frames.toLocaleString();$('#fact-span').textContent=data.alignment.common_frames?formatIntervalNs(data.alignment.max_span_ns):'—';
  $('#total-time').textContent=formatTime(data.duration);updateScrubberWindow();playerRoot.hidden=false;emptyState.hidden=true;$('#inspector-button').disabled=false;
}
async function openLocalFile(file){
  if(!file)return;
  if(!/\.mcap$/i.test(file.name)){showMessage('试用版请选择 .mcap 文件；ZIP 请先用原本地播放器处理',true);return;}
  importController?.abort();
  const controller=new AbortController();importController=controller;
  setPlaying(false);stopPlayers();hands.disable();$('#hand-enabled').checked=false;$('#hand-state').textContent='已关闭';
  localRecording?.close();localRecording=null;recording=null;
  playerRoot.hidden=true;emptyState.hidden=false;$('#inspector-button').disabled=true;
  cancelImport.hidden=false;setState('正在本地建立索引');
  let candidate=null;
  try{
    candidate=await LocalRecording.open(file,{signal:controller.signal,onProgress:({bytes,total})=>setState('本地索引 '+Math.floor(bytes/total*100)+'%')});
    const data=candidate.metadata,support=new Map();
    for(const codec of new Set(data.streams.map(stream=>stream.web_codec))){
      if(!('VideoDecoder' in window))continue;
      for(const preference of ['prefer-hardware','no-preference']){
        try{if((await VideoDecoder.isConfigSupported({codec,optimizeForLatency:true,hardwareAcceleration:preference})).supported){support.set(codec,preference);break;}}catch(_){}
      }
    }
    if(controller.signal.aborted){candidate.close();return;}
    if(!support.size)throw Error('此浏览器不支持录制的视频编码，请尝试 Chrome/Edge 或原本地播放器');
    localRecording=candidate;candidate=null;installRecording(data);
    for(let i=0;i<data.streams.length;i++)players.push(new StreamPlayer(data.streams[i],i,support.get(data.streams[i].web_codec)));
    layoutVideos();updateTimelineTracks();fillInspector(data);buildSensorReadouts(data);rebuildIssues();seek(Math.max(...data.streams.map(stream=>stream.times[0])));
    updatePerformance.last=performance.now();updateDecodeState();showMessage('已在本机载入 '+data.name+'，录像未上传');
  }catch(error){
    candidate?.close();
    if(importController!==controller)return;
    if(error.name==='AbortError'){setState('已取消打开');return;}
    stopPlayers();localRecording?.close();localRecording=null;recording=null;
    playerRoot.hidden=true;emptyState.hidden=false;setState('打开失败','error');showMessage(error.message,true);
  }finally{
    if(importController===controller){cancelImport.hidden=true;importController=null;localFileInput.value='';}
  }
}
localFileButton.addEventListener('click',()=>localFileInput.click());
localFileInput.addEventListener('change',()=>openLocalFile(localFileInput.files[0]));
cancelImport.addEventListener('click',()=>importController?.abort());
window.rtcameraTrial={get metadata(){return recording;},get frames(){return players.map(p=>({stream:p.stream.id,index:p.currentIndex,key:p.currentKey}));}};
$('#inspector-button').addEventListener('click',()=>inspector.hidden=!inspector.hidden);$('#inspector-close').addEventListener('click',()=>inspector.hidden=true);
playButton.addEventListener('click',()=>setPlaying(!playing));$('#back-button').addEventListener('click',()=>seek(playhead-1));$('#forward-button').addEventListener('click',()=>seek(playhead+1));
$('#prev-frame-button').addEventListener('click',()=>stepFrame(-1));$('#next-frame-button').addEventListener('click',()=>stepFrame(1));
$('#prev-issue-button').addEventListener('click',()=>jumpIssue(-1));$('#next-issue-button').addEventListener('click',()=>jumpIssue(1));
$('#timeline-zoom-out').addEventListener('click',()=>zoomTimeline(0.5));$('#timeline-zoom-reset').addEventListener('click',()=>{timelineZoom=1;timelineStart=0;updateScrubberWindow();drawTimeline();});$('#timeline-zoom-in').addEventListener('click',()=>zoomTimeline(2));
$('#timestamp-zoom-out').addEventListener('click',()=>setTimestampScale(timestampScale/1.2));$('#timestamp-zoom-reset').addEventListener('click',()=>setTimestampScale(1));$('#timestamp-zoom-in').addEventListener('click',()=>setTimestampScale(timestampScale*1.2));$('#timestamp-expand').addEventListener('click',()=>setTimestampExpanded(!$('#sensor-panel').classList.contains('expanded')));
$('#timeline-filter').addEventListener('change',updateTimelineTracks);
$('.timeline-scroll').addEventListener('wheel',event=>{if(event.ctrlKey){event.preventDefault();zoomTimeline(event.deltaY<0?2:0.5);}},{passive:false});
scrubber.addEventListener('input',()=>scheduleSeek(scrubber.value));scrubber.addEventListener('change',()=>{clearTimeout(seekTimer);seek(scrubber.value);});
function commitTime(){const input=$('#time-input'),value=parseTime(input.value);if(value===null){showMessage('时间格式无效',true);input.value=formatTime(playhead);}else{seek(value);input.value=formatTime(playhead);}}
$('#time-input').addEventListener('change',commitTime);
$('#time-input').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();commitTime();event.target.blur();}});
$('#speed-select').addEventListener('change',event=>{const wasPlaying=playing;setPlaying(false);rate=Number(event.target.value);if(wasPlaying)setPlaying(true);});
window.addEventListener('keydown',event=>{if(event.target instanceof Element&&event.target.matches('input,select'))return;if(event.key==='Escape'&&$('#sensor-panel').classList.contains('expanded'))setTimestampExpanded(false);else if(event.code==='Space'){event.preventDefault();setPlaying(!playing);}else if(event.key==='ArrowLeft')stepFrame(-1);else if(event.key==='ArrowRight')stepFrame(1);});
let dragDepth=0;const dropOverlay=$('#drop-overlay');
window.addEventListener('dragenter',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();dragDepth++;dropOverlay.hidden=false;}});
window.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
window.addEventListener('dragleave',()=>{dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)dropOverlay.hidden=true;});
window.addEventListener('drop',event=>{event.preventDefault();dragDepth=0;dropOverlay.hidden=true;openLocalFile(event.dataTransfer?.files[0]);});
window.addEventListener('resize',()=>{layoutVideos();resizeTimeline();});new ResizeObserver(layoutVideos).observe(grid);new ResizeObserver(resizeTimeline).observe(timeline);setInterval(updatePerformance,1000);requestAnimationFrame(renderLoop);


document.addEventListener('visibilitychange',()=>{if(document.hidden)setPlaying(false);});
