import assert from 'node:assert/strict';
import {HandScheduler} from '../rtcamera_offline/web/analysis/scheduler.js';

class WorkerStub {
  static instances=[];
  constructor(){this.sent=[];WorkerStub.instances.push(this);}
  postMessage(data){this.sent.push(data);}
  terminate(){this.terminated=true;}
  reply(data){this.onmessage({data});}
}
globalThis.Worker=WorkerStub;
let conversions=[];
globalThis.createImageBitmap=()=>new Promise(resolve=>conversions.push(resolve));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const bitmap=()=>({closed:false,close(){this.closed=true;}});
const delivered=[];
const scheduler=new HandScheduler(result=>delivered.push(result),()=>{});
scheduler.enable();
const worker=WorkerStub.instances.at(-1);
worker.reply({type:'ready',delegate:'GPU'});
scheduler.offer(0,'r:0:1',{},100);
const b0=bitmap();conversions.shift()(b0);await tick();
assert.equal(worker.sent.at(-1).timeMs,100);
assert.equal(worker.sent.at(-1).stream,0);
assert.equal(scheduler.busy,true);
const oldRequest=worker.sent.at(-1);
scheduler.offer(1,'r:1:1',{},100);
const b1=bitmap();conversions.shift()(b1);await tick();
scheduler.reset();
assert.equal(b1.closed,true,'reset releases queued camera snapshots');
scheduler.offer(0,'r:0:0',{},0);
const b2=bitmap();conversions.shift()(b2);await tick();
worker.reply({...oldRequest,type:'result',hands:[],inferenceMs:5});
assert.equal(delivered.length,0,'in-flight result from before seek is rejected');
assert.equal(worker.sent.at(-1).key,'r:0:0','new generation resumes after old request completes');
worker.reply({...worker.sent.at(-1),type:'result',hands:[],inferenceMs:5});
assert.equal(delivered.length,1);
// A busy stream cannot repeatedly displace a second camera waiting in the queue.
scheduler.offer(0,'r:0:2',{},200);conversions.shift()(bitmap());await tick();
scheduler.offer(1,'r:1:2',{},200);conversions.shift()(bitmap());await tick();
scheduler.offer(0,'r:0:3',{},300);conversions.shift()(bitmap());await tick();
worker.reply({...worker.sent.at(-1),type:'result',hands:[],inferenceMs:5});
assert.equal(worker.sent.at(-1).stream,1);
scheduler.offer(2,'r:2:3',{},300);
const late=bitmap();scheduler.disable();conversions.shift()(late);await tick();
assert.equal(late.closed,true,'disable also releases unfinished bitmap conversions');
assert.equal(scheduler.pending.size,0);
assert.equal(worker.terminated,true);
console.log('scheduler: timestamps, seek cancellation, camera fairness, bitmap cleanup passed');
// Six cameras must be spread across workers: Chromium can evict the first
// camera contexts if all six VIDEO graphs share a single worker.
scheduler.enable();
const first=WorkerStub.instances.at(-1);
first.reply({type:'ready',delegate:'GPU'});
for(let stream=0;stream<6;stream++){
 scheduler.offer(stream,`r:${stream}:5`,{},500);conversions.shift()(bitmap());await tick();
}
assert.equal(scheduler.lanes.length,3);
assert.ok(scheduler.lanes.every(lane=>lane.streams.size===2));
const second=scheduler.lanes[1].worker,third=scheduler.lanes[2].worker;
second.reply({type:'ready',delegate:'GPU'});third.reply({type:'ready',delegate:'GPU'});
assert.equal(first.sent.at(-1).stream,0);
assert.equal(second.sent.at(-1).stream,2);
assert.equal(third.sent.at(-1).stream,4);
// Both workers can progress independently, without mixing per-camera histories.
second.reply({...second.sent.at(-1),type:'result',hands:[],inferenceMs:5});
assert.equal(second.sent.at(-1).stream,3);
assert.equal(first.sent.at(-1).stream,0);
const oldSameKey=first.sent.at(-1);scheduler.reset();
scheduler.offer(0,'r:0:5',{},500);conversions.shift()(bitmap());await tick();
first.reply({...oldSameKey,type:'result',hands:[],inferenceMs:5});
assert.equal(first.sent.at(-1).key,'r:0:5');
assert.equal(first.sent.at(-1).generation,scheduler.generation,'same-frame seek must enqueue the new generation');
scheduler.disable();
assert.ok(first.terminated&&second.terminated&&third.terminated);
console.log('worker pool: bounded context count, independent progress, same-frame seek, cleanup passed');
