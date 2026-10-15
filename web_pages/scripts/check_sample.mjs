/** Compare the browser reader to the existing Python reader on a real local file. */
import assert from 'node:assert/strict';
import {open,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {indexRecording} from '../mcap/recording.js';
import {LocalRecording} from '../mcap/session.js';
const sample = process.argv[2] || process.env.RTCAMERA_SAMPLE_MCAP;
if (!sample) throw Error('用法：node scripts/check_sample.mjs /path/to/sample.mcap');
const pythonRoot = fileURLToPath(new URL('../../data_pipeline/offline/', import.meta.url));
const code = `import sys,json,hashlib\nsys.path.insert(0,sys.argv[1])\nfrom rtcamera_offline.recording import McapRecording\nr=McapRecording(sys.argv[2])\nm=r.metadata()\nm['payload_hashes']=[hashlib.sha256(r.map[s.frames[0].data_offset:s.frames[0].data_offset+s.frames[0].data_length]).hexdigest() for s in r.streams]\nprint(json.dumps(m))\nr.close()`;
const expected = JSON.parse(process.argv[3] ? await readFile(process.argv[3], 'utf8') : execFileSync('python3', ['-c', code, pythonRoot, sample], {maxBuffer: 64 * 1024 * 1024}));
const fd = await open(sample, 'r'), size = (await fd.stat()).size;
const file = {name: sample.split('/').at(-1), size, slice(start, end) { return {async arrayBuffer() {
  const buffer = Buffer.alloc(end - start), {bytesRead} = await fd.read(buffer, 0, buffer.length, start);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead);
}}; }};
try {
  const result = await indexRecording(file), actual = result.metadata;
  assert.equal(actual.message_count, expected.message_count); assert.equal(actual.duration, expected.duration);
  const streamFields = ['label','topic','codec','web_codec','frame_count','times','timestamps_ns','log_timestamps_ns','sequences','frame_ids',
    'sync_frame_ids','clock_generations','sync_epochs','keyframes','gaps'];
  assert.equal(actual.streams.length, expected.streams.length);
  actual.streams.forEach((stream,i) => streamFields.forEach(key => assert.deepEqual(stream[key], expected.streams[i][key], `${stream.label}.${key}`)));
  const sensorFields = ['source','topic','kind','message_count','times','timestamps_ns','sequences','frame_ids'];
  assert.equal(actual.sensor_streams.length, expected.sensor_streams.length);
  for (const sensor of actual.sensor_streams) {
    const row = expected.sensor_streams.find(e => e.source === sensor.source && e.topic === sensor.topic);
    assert.ok(row, sensor.source); sensorFields.forEach(key => assert.deepEqual(sensor[key], row[key], `${sensor.source}.${key}`));
  }
  const session = new LocalRecording(file, result);
  for (let i = 0; i < actual.streams.length; i++) {
    const [{data}] = await session.packets(i,0,1), hash = Buffer.from(await crypto.subtle.digest('SHA-256', data)).toString('hex');
    assert.equal(hash, expected.payload_hashes[i]);
  }
  session.close();
  console.log(JSON.stringify({sample, size_bytes: size, streams: actual.streams.map(s=>({label:s.label,frames:s.frame_count,codec:s.codec})),
    messages: actual.message_count, sensor_streams: actual.sensor_streams.length, alignment: actual.alignment,
    diagnostics: actual.local_diagnostics, parse_ms: actual.parse_ms, python_parity: 'passed; video, sensors and first-frame payload hashes'}, null, 2));
} finally { await fd.close(); }
