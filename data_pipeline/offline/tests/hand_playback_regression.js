/* Evaluate in a loaded player page (Runtime.evaluate, awaitPromise:true).
 * Requires a recording with >= 3 video streams and >= 10 seconds duration.
 * Uses real decoders, GPU/CPU worker and canvas overlays; does not replace the recording.
 */
(async()=>{
 const $=s=>document.querySelector(s), tiles=()=>[...document.querySelectorAll('.video-tile')];
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const assert=(ok,message)=>{if(!ok)throw Error(message);};
 const wait=async(test,message)=>{const end=performance.now()+20000;while(!test()){if(performance.now()>end)throw Error(message+'; '+$('#hand-state').textContent);await sleep(30);}};
 const checked=value=>{$('#hand-enabled').checked=value;$('#hand-enabled').dispatchEvent(new Event('change'));};
 const select=value=>{$('#hand-camera').value=value;$('#hand-camera').dispatchEvent(new Event('change'));};
 const seek=seconds=>{$('#time-input').value=String(seconds);$('#time-input').dispatchEvent(new Event('change'));};
 const key=t=>t.querySelector('canvas').dataset.frameKey;
 const matches=t=>!t.querySelector('.hand-label').hidden&&key(t)===t.querySelector('.hand-overlay').dataset.frameKey;
 const clear=t=>t.querySelector('.hand-label').hidden&&!t.querySelector('.hand-overlay').getContext('2d').getImageData(0,0,t.querySelector('.hand-overlay').width,t.querySelector('.hand-overlay').height).data.some((x,i)=>i%4===3&&x);
 const recording=await(await fetch('/api/recording')).json();
 assert(recording.streams.length>=3&&recording.duration>=10,'needs a multi-camera recording >=10 seconds');
 if($('#play-button').title==='暂停')$('#play-button').click();
 const errors=[];const errorListener=e=>errors.push(e.message);window.addEventListener('error',errorListener);
 try{
 select('all');checked(true);seek(recording.duration*0.52);
 await wait(()=>tiles().every(matches),'initial results');
 const audit={samples:0,missing:0,mismatches:0,frames:tiles().map(()=>new Set())};
 $('#play-button').click();const start=performance.now();
 while(performance.now()-start<4000){
  for(const [i,t] of tiles().entries()){
   audit.samples++;audit.frames[i].add(key(t));
   if(t.querySelector('.hand-label').hidden)audit.missing++;
   else if(!matches(t))audit.mismatches++;
  }
  await sleep(20);
 }
 $('#play-button').click();await wait(()=>tiles().every(matches),'paused results');
 const playback={...audit,frames:audit.frames.map(s=>s.size)};
 assert(playback.mismatches===0,'overlay must never describe another frame');
 assert(playback.missing===0,'warm playback must atomically present image and result');
 assert(playback.frames.every(n=>n>2),'every camera must advance');
 const before=tiles().map(key);$('#next-frame-button').click();
 await wait(()=>tiles().every((t,i)=>matches(t)&&key(t)!==before[i]),'single step results');
 // Cancel several generations while frames/model graph creation are still in flight.
 for(const fraction of [0.1,0.8,0.3,0.7,0.4]){seek(recording.duration*fraction);await sleep(45);}
 await wait(()=>tiles().every(matches),'rapid reverse/forward seek results');
 const target=recording.duration*.4;
 assert(tiles().every((t,i)=>Math.abs(recording.streams[i].times[Number(key(t).split(':').at(-1))]-target)<.05),'seek must end on requested timestamp');
 select(String(recording.streams[2].id));await wait(()=>matches(tiles()[2]),'selected camera result');
 assert(tiles().filter((t,i)=>i!==2).every(clear),'unselected cameras must have no old skeleton');
 tiles()[2].querySelector('.image-zoom-in').click();
 assert(tiles()[2].querySelector('canvas').style.transform===tiles()[2].querySelector('.hand-overlay').style.transform,'zoom alignment');
 tiles()[2].querySelector('.tile-focus').click();await wait(()=>matches(tiles()[2]),'focused camera');
 assert(tiles().filter(t=>!t.hidden).length===1,'one focused camera');
 tiles()[2].querySelector('.tile-focus').click();select('all');
 seek(recording.duration*.6);checked(false);await sleep(1000);
 assert(tiles().every(clear),'disable must reject late results and clear pixels');
 checked(true);await wait(()=>tiles().every(matches),'re-enable');
 const diagnostics=JSON.parse($('#hand-diagnostics').textContent);
 assert(diagnostics.backend.mode==='VIDEO','temporal model enabled');
 checked(false);
 // A model startup failure must leave ordinary playback usable.
 const RealWorker=window.Worker;
 window.Worker=class{postMessage(){setTimeout(()=>this.onmessage?.({data:{type:'error',error:'injected model startup failure'}}),10);}terminate(){}};
 try{checked(true);await wait(()=>$('#hand-state').textContent.includes('不可用'),'failure status');}finally{window.Worker=RealWorker;checked(false);}
 const previous=key(tiles()[0]);$('#next-frame-button').click();await wait(()=>key(tiles()[0])!==previous,'playback after model failure');
 assert(tiles().every(clear),'failure must clear overlays');
 assert(errors.length===0,'browser errors: '+errors.join('; '));
 return {playback,diagnostics,checks:['step','rapid seek','camera selection','zoom','focus','disable in flight','re-enable','model failure recovery'],errors};
 }finally{window.removeEventListener('error',errorListener);if($('#play-button').title==='暂停')$('#play-button').click();checked(false);}
})()
