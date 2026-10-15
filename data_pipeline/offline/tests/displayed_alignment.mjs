import assert from 'node:assert/strict';
import {displayedAlignment} from '../rtcamera_offline/web/analysis/alignment.js';

const frame = (timestamp, pulse='0', epoch=1, clock=2) => ({timestamp, pulse, epoch, clock});
// Epoch nanoseconds exceed Number's integer precision; a 17 ns gap must survive.
const a = frame('1790746431123456789');
const b = frame('1790746431123456806');
assert.deepEqual(displayedAlignment([b,a]), {
  status:'aligned',pulse:'0',span:17n,offsets:[17n,0n],
});
assert.equal(displayedAlignment([a, {...b,pulse:'1'}]).status,'mismatch');
assert.equal(displayedAlignment([a, {...b,epoch:2}]).status,'mismatch');
assert.equal(displayedAlignment([a, {...b,clock:3}]).status,'mismatch');
assert.equal(displayedAlignment([a, {...b,pulse:null}]).status,'unidentified');
assert.equal(displayedAlignment([a, {...b,clock:undefined}]).status,'unidentified');
assert.equal(displayedAlignment([a,null]).status,'waiting');
assert.equal(displayedAlignment([a]).status,'single');
assert.equal(displayedAlignment([a,a]).span,0n);
console.log('Displayed-frame alignment: precision, pulse zero, provenance, epoch, waiting and focus passed.');
