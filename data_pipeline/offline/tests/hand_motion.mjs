import assert from 'node:assert/strict';
import {MotionRecovery,uniqueHands,duplicateHand,unrotateRecovery,RECOVERY_MAX_AGE_MS} from '../rtcamera_offline/web/analysis/motion.js';
const hand=(x,y=.5)=>({label:'Left',landmarks:Array.from({length:21},(_,i)=>({x:x+(i%5)*.012,y:y+Math.floor(i/5)*.015,z:-.01}))});
const a=hand(.2),b=hand(.7);
const rotated={...a,landmarks:a.landmarks.map(p=>({...p,x:p.y,y:1-p.x}))};
unrotateRecovery([rotated])[0].landmarks.forEach((p,i)=>{
 assert.ok(Math.abs(p.x-a.landmarks[i].x)<1e-10);assert.equal(p.y,a.landmarks[i].y);assert.equal(p.z,a.landmarks[i].z);
});
assert.equal(uniqueHands([a,{...a,label:'Right'},b]).length,2,'dedup ignores unstable classification');
assert.equal(duplicateHand(a,b),false);
const history=new MotionRecovery();
assert.equal(history.propose([],0,960,780),null,'cannot invent a region without a measured hand');
history.commit([a,b],0);
assert.equal(history.propose([a,b],30,960,780),null,'no extra work when full detector sees all hands');
const crop=history.propose([a],100,960,780);
assert.ok(crop);assert.ok(crop.x>=0&&crop.y>=0&&crop.x+crop.width<=960&&crop.y+crop.height<=780);
const inCrop=original=>({...original,landmarks:original.landmarks.map(p=>({...p,x:(p.x*960-crop.x)/crop.width,y:(p.y*780-crop.y)/crop.height,z:p.z*960/crop.width}))});
assert.deepEqual(history.accept(crop,[],[a]),[],'crop with no detection must never return old landmarks');
const found=history.accept(crop,[inCrop(b)],[a]);assert.equal(found.length,1);assert.equal(found[0].recovered,true);
for(let i=0;i<21;i++){assert.ok(Math.abs(found[0].landmarks[i].x-b.landmarks[i].x)<1e-10);assert.ok(Math.abs(found[0].landmarks[i].z-b.landmarks[i].z)<1e-10);}
assert.equal(history.accept(crop,[inCrop(b)],[a,b]).length,0,'duplicate recovery rejected');
assert.equal(history.accept(crop,[inCrop(a)],[a]).length,0,'unrelated/overlapping result rejected');
history.commit([a],100);
assert.equal(history.propose([a],RECOVERY_MAX_AGE_MS+1,960,780),null,'lost track expires');
history.commit([a,b],500);
assert.equal(history.propose([],499,960,780),null,'backwards time resets regions');
const moving=new MotionRecovery();moving.commit([a],0);moving.commit([hand(.22)],33);
assert.ok(moving.propose([],66,960,780).expected.x>moving.tracks[0].hand.landmarks[0].x,'predict search area in direction of measured motion');
console.log('Hand motion: crop mapping, dedup, current-image-only recovery, expiry, reset and motion proposal passed.');
