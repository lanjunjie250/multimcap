// Presentation continuity, not extra detector output. Retained landmarks keep
// their source frame key and are explicitly labelled as estimates in the UI.
export const HOLD_MS = 120;
const MAX_MISSES = 2;
const PALM = [0, 5, 9, 13, 17];
function center(hand) {
  return PALM.reduce((p, i) => ({x:p.x + hand.landmarks[i].x / PALM.length,
    y:p.y + hand.landmarks[i].y / PALM.length}), {x:0, y:0});
}
function distance(a, b) { return Math.hypot(a.x-b.x, a.y-b.y); }
function radius(hand) {
  return Math.max(.07, Math.min(.18, distance(hand.landmarks[5], hand.landmarks[17]) * 1.2));
}

export class HandContinuity {
  constructor() { this.reset(); }
  reset() { this.tracks=[];this.lastTime=null;this.lastKey=null;this.output=null;this.scope=null; }
  update(result, timeMs, maxHands=2) {
    const scope=result.key.split(':').slice(0,-1).join(':');
    if (this.scope!==scope || (this.lastTime!==null && timeMs<this.lastTime)) this.reset();
    if (result.key===this.lastKey) return this.output;
    const detected=result.hands.map(hand=>({...hand,sourceKey:result.key,held:false}));
    const candidates=this.tracks.filter(t=>timeMs>=t.time && timeMs-t.time<=HOLD_MS);
    // Associate by palm position, never by unstable Left/Right classification
    // or the order MediaPipe returns the hands in.
    const pairs=[];
    candidates.forEach((track,i)=>detected.forEach((hand,j)=>{
      const d=distance(center(track.hand),center(hand));
      if(d<=Math.max(radius(track.hand),radius(hand))) pairs.push({i,j,d});
    }));
    pairs.sort((a,b)=>a.d-b.d);
    const matchedTracks=new Set(),matchedHands=new Set();
    for(const {i,j} of pairs) if(!matchedTracks.has(i)&&!matchedHands.has(j)) {
      matchedTracks.add(i);matchedHands.add(j);
    }
    const retained=candidates.filter((track,i)=>matchedHands.size===detected.length &&
      detected.length<candidates.length && !matchedTracks.has(i) && track.misses<MAX_MISSES &&
      // Never draw a retained hand on top of a newly detected hand at a crossing.
      !detected.some(hand=>distance(center(track.hand),center(hand))<radius(track.hand)))
      .sort((a,b)=>b.time-a.time).slice(0,Math.max(0,maxHands-detected.length))
      .map(track=>({...track,misses:track.misses+1}));
    this.tracks=[...detected.map(hand=>({hand,time:timeMs,misses:0})),...retained];
    this.lastTime=timeMs;this.lastKey=result.key;this.scope=scope;
    this.output={...result,detectedCount:detected.length,heldCount:retained.length,
      hands:[...detected,...retained.map(track=>({...track.hand,held:true}))]};
    return this.output;
  }
}
