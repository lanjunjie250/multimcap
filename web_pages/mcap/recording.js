import {FileReadable} from './readable.js';

const MAGIC = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a];
const text = new TextDecoder('utf-8', {fatal: true});
const isMagic = bytes => MAGIC.every((value, i) => bytes[i] === value);
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u16 = (bytes, i) => view(bytes).getUint16(i, true);
const u32 = (bytes, i) => view(bytes).getUint32(i, true);
const u64 = (bytes, i) => view(bytes).getBigUint64(i, true);
const toOffset = n => {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('MCAP offset 超出安全整数范围');
  return Number(n);
};
function stringAt(bytes, offset) {
  if (offset + 4 > bytes.length) throw Error('MCAP 字符串被截断');
  const length = u32(bytes, offset), start = offset + 4;
  if (length > bytes.length - start) throw Error('MCAP 字符串超出记录范围');
  return [text.decode(bytes.subarray(start, start + length)), start + length];
}
function varint(bytes, state) {
  let value = 0n;
  for (let shift = 0n; shift < 70n && state.offset < bytes.length; shift += 7n) {
    const byte = bytes[state.offset++]; value |= BigInt(byte & 127) << shift;
    if (!(byte & 128)) return value;
  }
  throw Error('无效的 protobuf varint');
}
function fields(bytes) {
  const result = new Map(), state = {offset: 0};
  while (state.offset < bytes.length) {
    const key = toOffset(varint(bytes, state)), number = key >>> 3, wire = key & 7;
    if (!number) throw Error('无效的 protobuf 字段号');
    if (wire === 0) { varint(bytes, state); continue; }
    const length = wire === 2 ? toOffset(varint(bytes, state)) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (length < 0 || length > bytes.length - state.offset) throw Error('protobuf 字段长度无效');
    if (wire === 2) result.set(number, {offset: state.offset, bytes: bytes.subarray(state.offset, state.offset + length)});
    state.offset += length;
  }
  return result;
}
const publicCameras = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C2', 'D2'];
export function cameraTopicKey(topic) { return topic.match(/^(.*?\/camera(?:\d+|\/[A-D][0-3]))(?:\/|$)/)?.[1]; }
function recordedName(topic, metadata) {
  for (const field of ['camera_label', 'camera_id', 'sensor_id']) {
    if (/^[A-D][0-3]$/.test(metadata[field] || '')) return metadata[field];
  }
  return topic.match(/\/camera\/([A-D][0-3])(?:\/|$)/)?.[1];
}
export function routeLabel(topic, metadata = {}) {
  const label = recordedName(topic, metadata), vc = metadata.logical_vc ?? metadata.camera_id_value;
  const link = label?.[0] || (/^[0-3]$/.test(metadata.extvc || '') ? 'ABCD'[Number(metadata.extvc)] : null);
  if (link && /^[0-2]$/.test(vc ?? '')) return link + (Number(vc) + 1);
  if (label) return label.endsWith('0') ? label[0] + '1' : label;
  const index = topic.match(/\/camera(\d+)(?:\/|$)/)?.[1];
  return index !== undefined ? publicCameras[Number(index)] || 'Camera ' + index : topic.split('/').filter(Boolean).at(-2) || topic;
}
function nalInfo(bytes, codec) {
  let keyframe = false, webCodec = codec === 'h264' ? 'avc1.42E01E' : 'hvc1.1.6.L93.B0';
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 1) continue;
    const at = i + 3, type = codec === 'h264' ? bytes[at] & 31 : (bytes[at] >> 1) & 63;
    if (codec === 'h264') {
      if (type === 5) keyframe = true;
      if (type === 7 && at + 3 < bytes.length) webCodec = 'avc1.' + [...bytes.subarray(at + 1, at + 4)].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
    } else if (type >= 16 && type <= 21) keyframe = true;
  }
  return {keyframe, webCodec};
}
export function sbr2Info(bytes) {
  if (bytes.length < 84 || text.decode(bytes.subarray(0, 4)) !== 'SBR2') throw Error('无效的 SBR2 元数据');
  const version = u16(bytes, 4), headerLength = u16(bytes, 6);
  if (!((version === 3 && headerLength === 80) || (version === 4 && headerLength === 88)) ||
      u32(bytes, 8) !== bytes.length || bytes.length < headerLength + 4) throw Error('SBR2 版本或长度不支持');
  const descriptors = [];
  for (let i = 0; i < u16(bytes, 36); i++) {
    const at = headerLength + i * 40;
    if (at + 40 > bytes.length - 4) throw Error('SBR2 descriptor 被截断');
    descriptors.push({sensor: u16(bytes, at), kind: bytes[at + 2], count: u16(bytes, at + 4), first: u64(bytes, at + 8)});
  }
  return {global: u64(bytes, 24), epoch: u32(bytes, 32), pulse: u64(bytes, 40), clock: u32(bytes, 68), descriptors};
}
export function timing(messages, start) {
  const stamps = messages.map(m => m.publish), intervals = stamps.slice(1).map((n, i) => Number(n - stamps[i]));
  const positive = intervals.filter(n => n > 0).sort((a, b) => a - b), median = positive[Math.floor(positive.length / 2)] || 0;
  return {times: stamps.map(n => Number(n - start) / 1e9), timestamps_ns: stamps.map(String),
    log_timestamps_ns: messages.map(m => String(m.log)), sequences: messages.map(m => m.sequence),
    median_interval_ns: median, min_interval_ns: positive[0] || 0, max_interval_ns: positive.at(-1) || 0,
    gaps: intervals.flatMap((n, i) => median && n > median * 1.5 ? [i + 1] : []),
    gap_events: intervals.flatMap((n, i) => median && n > median * 1.5 ? [{index: i + 1, time: Number(stamps[i + 1] - start) / 1e9,
      interval_ms: n / 1e6, missing: Math.max(1, Math.round(n / median) - 1)}] : [])};
}
const topicKind = (topic, schema) => /\/(compressed|video\/encoded)$/.test(topic) ? 'video' : /imu/i.test(topic + schema) ? 'imu' : /metadata/i.test(topic + schema) ? 'metadata' : 'sensor';

/** Trial reader: sequentially builds an index in a Worker, with bounded byte buffers.
 * Uncompressed Chunk contents retain their absolute source-file offsets.
 */
export async function indexRecording(file, onProgress = () => {}, options = {}) {
  const source = new FileReadable(file, options), started = performance.now();
  const channels = new Map(), schemas = new Map(), streams = new Map(), metadata = new Map(), messages = new Map(), sensors = new Map();
  const maxMessages = options.maxMessages ?? 1_000_000, maxFrames = options.maxFrames ?? 250_000;
  const definitions=[],records=[];
  let count = 0, frameCount = 0, start = null, end = null, lastProgress = 0;
  const append = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
  async function recordHeader(offset, limit) {
    if (offset + 9 > limit) throw Error('MCAP record header 被截断');
    const header = await source.read(offset, 9), length = toOffset(u64(header, 1));
    if (length > limit - offset - 9) throw Error('MCAP record 长度超出文件或 Chunk');
    return {opcode: header[0], offset: offset + 9, length, next: offset + 9 + length};
  }
  async function scan(begin, limit, nested = false) {
    let cursor = begin;
    while (cursor < limit) {
      const rec = await recordHeader(cursor, limit);
      if (rec.opcode === 0x06) {
        if (nested || rec.length < 40) throw Error('MCAP Chunk 结构无效');
        const prefix = await source.read(rec.offset, Math.min(rec.length, 128));
        const [compression, at] = stringAt(prefix, 28);
        if (compression) throw Error('试用版暂不支持 ' + compression + ' 压缩 Chunk；请使用未压缩 MCAP 或原 Python 播放器');
        if (at + 8 > prefix.length) throw Error('MCAP Chunk 头被截断');
        const length = toOffset(u64(prefix, at));
        if (length !== rec.length - at - 8) throw Error('MCAP Chunk 内容长度无效');
        await scan(rec.offset + at + 8, rec.next, true);
      } else if (rec.opcode === 3) {
        const bytes = await source.read(rec.offset, rec.length);
        if (bytes.length < 2) throw Error('Schema record 过短');
        schemas.set(u16(bytes, 0), stringAt(bytes, 2)[0]);
        if(options.captureRecords)definitions.push({opcode:3,id:u16(bytes,0),offset:rec.offset,length:rec.length});
      } else if (rec.opcode === 4) {
        const bytes = await source.read(rec.offset, rec.length);
        if (bytes.length < 4) throw Error('Channel record 过短');
        const [topic, a] = stringAt(bytes, 4), [encoding, b] = stringAt(bytes, a);
        if (b + 4 > bytes.length || u32(bytes, b) !== bytes.length - b - 4) throw Error('Channel metadata 长度无效');
        let at = b + 4; const values = {};
        while (at < bytes.length) {
          const [key, next] = stringAt(bytes, at), [value, tail] = stringAt(bytes, next);
          Object.defineProperty(values, key, {value, enumerable: true}); at = tail;
        }
        const id = u16(bytes, 0);
        if (channels.has(id)) throw Error('Data Section 包含重复 Channel ID');
        channels.set(id, {id, schema: u16(bytes, 2), topic, encoding, values});
        if(options.captureRecords)definitions.push({opcode:4,id,schema:u16(bytes,2),offset:rec.offset,length:rec.length});
      } else if (rec.opcode === 5) {
        if (rec.length < 22) throw Error('Message record 过短');
        if (++count > maxMessages) throw Error('试用版消息数上限为 ' + maxMessages.toLocaleString() + '；请拆分录制');
        const header = await source.read(rec.offset, 22), channel = channels.get(u16(header, 0));
        if (!channel) throw Error('Message 引用了尚未定义的 Channel');
        const message = {sequence: u32(header, 2), log: u64(header, 6), publish: u64(header, 14)};
        if (start === null || message.publish < start) start = message.publish;
        if (end === null || message.publish > end) end = message.publish;
        append(messages, channel.id, message);
        const captured=options.captureRecords?{channel:channel.id,topic:channel.topic,sequence:message.sequence,publish:String(message.publish),log:String(message.log),offset:rec.offset,length:rec.length}:null;
        if(captured)records.push(captured);
        const schema = schemas.get(channel.schema) || '', payloadOffset = rec.offset + 22, payloadLength = rec.length - 22;
        if (/\/metadata\/raw$/.test(channel.topic)) {
          const info = sbr2Info(await source.read(payloadOffset, payloadLength));
          if (!metadata.has(cameraTopicKey(channel.topic))) metadata.set(cameraTopicKey(channel.topic), new Map());
          metadata.get(cameraTopicKey(channel.topic)).set(message.sequence, info);
          append(sensors, channel.id + '\0metadata', {channel, source: null, message, info});
        } else if (/imu|encoder/i.test(schema)) {
          const parsed = fields(await source.read(payloadOffset, payloadLength)), sourceName = parsed.get(2);
          const name = sourceName ? text.decode(sourceName.bytes) : channel.topic.split('/').at(-1);
          if(captured)captured.source=name;
          append(sensors, channel.id + '\0' + name, {channel, source: name, message});
        }
        if (channel.encoding === 'protobuf' && /\/(compressed|video\/encoded)$/.test(channel.topic)) {
          if (++frameCount > maxFrames) throw Error('试用版视频帧上限为 ' + maxFrames.toLocaleString() + '；请拆分录制');
          const parsed = fields(await source.read(payloadOffset, payloadLength)), modern = schema === 'foxglove.CompressedVideo';
          const data = parsed.get(modern ? 3 : 2), format = parsed.get(modern ? 4 : 3);
          const codec = format ? text.decode(format.bytes) : '';
          if (!data || !['h264', 'h265'].includes(codec)) throw Error('视频消息缺少支持的 H.264/H.265 payload');
          const {keyframe, webCodec} = nalInfo(data.bytes, codec);
          if (!streams.has(channel.id)) streams.set(channel.id, {channel, codec, webCodec, frames: []});
          const stream = streams.get(channel.id);
          if (stream.codec !== codec) throw Error('同一相机中途切换编码，试用版暂不支持');
          if (codec !== 'h264' || webCodec !== 'avc1.42E01E') stream.webCodec = webCodec;
          stream.frames.push({...message, offset: payloadOffset + data.offset, length: data.bytes.length, keyframe});
        }
      } else if (rec.opcode === 15) {
        if (nested || rec.length !== 4) throw Error('无效的 MCAP DataEnd');
        return;
      } else if (rec.opcode === 2) {
        if (nested || rec.length !== 20) throw Error('无效的 MCAP Footer');
        return;
      }
      cursor = rec.next;
      if (performance.now() - lastProgress > 150) {
        lastProgress = performance.now(); onProgress({bytes: cursor, total: file.size, messages: count});
      }
    }
  }
  try {
    if (file.size < 16 || !isMagic(await source.read(0, 8)) || !isMagic(await source.read(file.size - 8, 8))) throw Error('文件不是完整 MCAP，或文件尾损坏');
    // A standard Footer is required; Summary and indexes themselves are optional.
    let footer = null;
    if (file.size >= 37) {
      const tail = await source.read(file.size - 37, 29);
      if (tail[0] === 2 && u64(tail, 1) === 20n) {
        const summary = toOffset(u64(tail, 9)), offsets = toOffset(u64(tail, 17)), footerStart = file.size - 37;
        if ((summary && (summary < 8 || summary >= footerStart)) || (offsets && (!summary || offsets < summary || offsets >= footerStart))) throw Error('Footer 的 Summary offset 越界');
        footer = summary ? 'summary' : 'no-summary';
      }
    }
    if(footer===null)throw Error('MCAP Footer 缺失或损坏');
    await scan(8, file.size - 8);
    if (!streams.size || start === null) throw Error('MCAP 没有支持的 H.264/H.265 视频帧');
    const labels = new Map(), aliases = new Map();
    for (const channel of channels.values()) {
      const original = recordedName(channel.topic, channel.values);
      if (original || /^[0-3]$/.test(channel.values.extvc || '')) {
        const label = routeLabel(channel.topic, channel.values);
        labels.set(cameraTopicKey(channel.topic), label);
        if (original) {
          if (!aliases.has(original)) aliases.set(original, new Set());
          aliases.get(original).add(label);
        }
      }
    }
    const labelOf = channel => labels.get(cameraTopicKey(channel.topic)) || routeLabel(channel.topic, channel.values);
    const aliasOf = name => { const [head, ...rest] = name.split('_'); const names = aliases.get(head);
      return (names?.size === 1 ? [...names][0] : head) + (rest.length ? '_' + rest.join('_') : ''); };
    const sampleIds = new Map(), highs = new Map();
    for (const entries of sensors.values()) for (const item of entries) if (item.info) {
      for (const desc of item.info.descriptors) {
        if (![1, 2].includes(desc.kind)) continue;
        const sourceName = labelOf(item.channel) + (desc.kind === 1 ? '_imu' : '_encoder');
        const highKey = sourceName + ':' + desc.sensor + ':' + item.info.clock;
        let previous = highs.get(highKey);
        for (let i = 0; i < desc.count; i++) {
          let sequence = (desc.first + BigInt(i)) & 65535n;
          if (previous !== undefined) { sequence |= previous & ~65535n; if (sequence + 32768n < previous) sequence += 65536n; }
          sampleIds.set(sourceName + ':' + sequence, item.info.pulse); previous = sequence;
          if(sampleIds.size>maxMessages)throw Error('传感器索引超过试用版消息上限，请拆分录制');
        }
        if (previous !== undefined) highs.set(highKey, previous);
      }
    }
    const sorted = [...streams.values()].sort((a, b) => labelOf(a.channel).localeCompare(labelOf(b.channel), 'en', {numeric: true}));
    const locators = [], streamRows = sorted.map((stream, id) => {
      if (stream.frames.some((frame, i) => i && frame.publish < stream.frames[i - 1].publish)) throw Error('视频 publish_time 倒退，试用版无法安全回放');
      const sync = metadata.get(cameraTopicKey(stream.channel.topic)) || new Map(), details = stream.frames.map(frame => sync.get(frame.sequence));
      const timingInfo = timing(stream.frames, start);
      locators.push(stream.frames.map(({offset, length}) => ({offset, length})));
      return {id, label: labelOf(stream.channel), topic: stream.channel.topic, kind: 'video', codec: stream.codec, web_codec: stream.webCodec,
        frame_count: stream.frames.length, ...timingInfo, fps: timingInfo.median_interval_ns ? 1e9 / timingInfo.median_interval_ns : 0,
        frame_ids: stream.frames.map((frame, i) => String(details[i]?.pulse ?? frame.sequence)),
        sync_frame_ids: details.map(info => info ? String(info.pulse) : null),
        global_frame_sequences: details.map(info => String(info?.global ?? 0)),
        clock_generations: details.map(info => info?.clock ?? null), sync_epochs: details.map(info => info?.epoch ?? null),
        keyframes: stream.frames.flatMap((frame, i) => frame.keyframe ? [i] : [])};
    });
    const sensorRows = [...sensors.values()].map(entries => {
      const channel = entries[0].channel, name = entries[0].info ? labelOf(channel) + '_metadata' : aliasOf(entries[0].source);
      entries.sort((a, b) => a.message.publish < b.message.publish ? -1 : a.message.publish > b.message.publish ? 1 : 0);
      return {topic: channel.topic, label: name.replaceAll('_', ' '), source: name, kind: topicKind(channel.topic, schemas.get(channel.schema) || ''),
        schema: schemas.get(channel.schema) || '', message_count: entries.length, ...timing(entries.map(e => e.message), start),
        frame_ids: entries.map(e => String(e.info?.pulse ?? sampleIds.get(name + ':' + e.message.sequence) ?? 0))};
    }).sort((a, b) => a.topic.localeCompare(b.topic) || a.source.localeCompare(b.source)).map((row, i) => ({...row, id: 'sensor-' + i}));
    const topics = [...channels.values()].sort((a, b) => a.topic.localeCompare(b.topic)).map(channel => {
      const entries = messages.get(channel.id) || [], stats = timing(entries, start), schema = schemas.get(channel.schema) || '';
      return {id: channel.id, topic: channel.topic, schema, encoding: channel.encoding, kind: topicKind(channel.topic, schema), messages: entries.length,
        first_time_ns: entries.length ? String(entries[0].publish) : null, last_time_ns: entries.length ? String(entries.at(-1).publish) : null,
        min_interval_ns: stats.min_interval_ns, median_interval_ns: stats.median_interval_ns, max_interval_ns: stats.max_interval_ns,
        rate_hz: stats.median_interval_ns ? 1e9 / stats.median_interval_ns : 0, log_publish_mismatches: entries.filter(e => e.log !== e.publish).length,
        source_count: sensorRows.filter(row => row.topic === channel.topic).length};
    });
    if(options.captureRecords)for(const rec of records)if(rec.source)rec.source=aliasOf(rec.source);
    // A shared pulse is meaningful only within the same clock generation/epoch.
    const maps = streamRows.map(row => new Map(row.sync_frame_ids.flatMap((pulse, i) => pulse === null ? [] :
      [[row.clock_generations[i] + ':' + row.sync_epochs[i] + ':' + pulse, BigInt(row.timestamps_ns[i])]])));
    const spans = [];
    if (maps.length > 1) for (const [key, stamp] of maps[0]) if (maps.every(map => map.has(key))) {
      let minimum = stamp, maximum = stamp;
      for (const map of maps) { const current = map.get(key); if (current < minimum) minimum = current; if (current > maximum) maximum = current; }
      spans.push(Number(maximum - minimum));
    }
    spans.sort((a, b) => a - b);
    onProgress({bytes: file.size, total: file.size, messages: count});
    return {metadata: {recording_id: crypto.randomUUID(), name: file.name || 'local.mcap', path: '本地文件 / ' + (file.name || 'local.mcap'),
      size_bytes: file.size, start_time_ns: String(start), end_time_ns: String(end), start_timestamp_ns: String(start), end_timestamp_ns: String(end),
      duration: Number(end - start) / 1e9, message_count: count, parse_ms: performance.now() - started, merged_download: false,
      alignment: {common_frames: spans.length, min_span_ns: spans[0] || 0, max_span_ns: spans.at(-1) || 0,
        p95_span_ns: spans[Math.round((spans.length - 1) * 0.95)] || 0, exact_frame_counts: new Set(streamRows.map(s => s.frame_count)).size === 1,
        log_publish_alignment: topics.every(t => !t.log_publish_mismatches)}, streams: streamRows, sensor_streams: sensorRows, topics,
      local_diagnostics: {reader: 'bounded-sequential-trial', footer, bytes_read: source.bytesRead, max_messages: maxMessages, max_frames: maxFrames}}, locators, ...(options.captureRecords?{definitions,records}:{} )};
  } finally { source.close(); }
}
