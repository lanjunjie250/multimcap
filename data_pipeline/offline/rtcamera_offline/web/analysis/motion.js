// Shared by the Worker and deterministic recording benchmarks. Recovery always
// runs on CURRENT pixels; history only proposes a search region.
export const RECOVERY_MAX_AGE_MS = 350;
const PALM = [0, 5, 9, 13, 17];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function palm(hand) {
  return PALM.reduce((c,i)=>({x:c.x+hand.landmarks[i].x/5,y:c.y+hand.landmarks[i].y/5}),{x:0,y:0});
}
function bounds(hand) {
  const x=hand.landmarks.map(p=>p.x),y=hand.landmarks.map(p=>p.y);
  return {x:Math.min(...x),y:Math.min(...y),w:Math.max(...x)-Math.min(...x),h:Math.max(...y)-Math.min(...y)};
}
function distance(a,b) { return Math.hypot(a.x-b.x,a.y-b.y); }
function palmSize(hand) { return distance(hand.landmarks[5],hand.landmarks[17]); }
export function duplicateHand(a,b) {
  return distance(palm(a),palm(b)) < Math.max(.018,Math.min(palmSize(a),palmSize(b))*.75);
}
export function uniqueHands(hands) {
  const output=[];
  for(const hand of hands) if(hand.landmarks?.length===21 &&
    hand.landmarks.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)) &&
    !output.some(other=>duplicateHand(hand,other))) output.push(hand);
  return output;
}
// Inverse mapping for a square input rotated 90 degrees counterclockwise.
export function unrotateRecovery(hands) {
  return hands.map(hand=>({...hand,landmarks:hand.landmarks.map(p=>({...p,x:1-p.y,y:p.x}))}));
}
function match(tracks,hands,time) {
  const pairs=[];
  tracks.forEach((track,i)=>hands.forEach((hand,j)=>{
    const b=bounds(track.hand),d=distance(palm(hand),palm(track.hand));
    if(d<Math.max(.1,Math.hypot(b.w,b.h)*1.25))pairs.push({i,j,d});
  }));
  pairs.sort((a,b)=>a.d-b.d);const result=new Map(),used=new Set();
  for(const {i,j} of pairs)if(!result.has(i)&&!used.has(j)){result.set(i,j);used.add(j);}
  return {result,used};
}
export class MotionRecovery {
  constructor(){this.tracks=[];this.lastTime=null;}
  active(time){
    if(this.lastTime!==null&&time<=this.lastTime)this.tracks=[];
    return this.tracks.filter(t=>time-t.time>=0&&time-t.time<=RECOVERY_MAX_AGE_MS);
  }
  propose(hands,time,width,height,maxHands=2){
    if(hands.length>=maxHands)return null;
    const tracks=this.active(time),{result}=match(tracks,hands,time);
    const missing=tracks.filter((_,i)=>!result.has(i)).sort((a,b)=>(a.attempt??-Infinity)-(b.attempt??-Infinity));
    const track=missing[0];if(!track)return null;track.attempt=time;
    const box=bounds(track.hand),center={x:box.x+box.w/2,y:box.y+box.h/2};
    const dt=Math.min(150,time-track.time),vx=clamp((track.vx||0)*dt,-.12,.12),vy=clamp((track.vy||0)*dt,-.12,.12);
    const travel=Math.hypot(vx*width,vy*height);
    const size=Math.min(width,height,Math.max(128,Math.max(box.w*width,box.h*height)*2.6+travel));
    const x=clamp((center.x+vx)*width-size/2,0,width-size),y=clamp((center.y+vy)*height-size/2,0,height-size);
    return {x,y,width:size,height:size,imageWidth:width,imageHeight:height,
      expected:{x:(palm(track.hand).x+vx),y:(palm(track.hand).y+vy)},track};
  }
  accept(crop,local,hands){
    const mapped=uniqueHands(local.map(hand=>({...hand,recovered:true,landmarks:hand.landmarks.map(p=>({...p,
      x:(crop.x+p.x*crop.width)/crop.imageWidth,y:(crop.y+p.y*crop.height)/crop.imageHeight,
      z:(p.z||0)*crop.width/crop.imageWidth}))})))
      .filter(hand=>!hands.some(other=>duplicateHand(hand,other)))
      .filter(hand=>distance(palm(hand),crop.expected)<Math.max(.08,Math.hypot(bounds(crop.track.hand).w,bounds(crop.track.hand).h)*1.25));
    mapped.sort((a,b)=>distance(palm(a),crop.expected)-distance(palm(b),crop.expected));
    return mapped.slice(0,1);
  }
  commit(hands,time,maxHands=2){
    const tracks=this.active(time),{result,used}=match(tracks,hands,time),next=[];
    tracks.forEach((track,i)=>{
      if(!result.has(i)){next.push(track);return;}
      const hand=hands[result.get(i)],a=palm(track.hand),b=palm(hand),dt=time-track.time;
      next.push({hand,time,vx:dt>0?(b.x-a.x)/dt:0,vy:dt>0?(b.y-a.y)/dt:0,attempt:track.attempt});
    });
    hands.forEach((hand,i)=>{if(!used.has(i))next.push({hand,time,vx:0,vy:0});});
    this.tracks=next.sort((a,b)=>b.time-a.time).slice(0,maxHands);this.lastTime=time;
  }
}
