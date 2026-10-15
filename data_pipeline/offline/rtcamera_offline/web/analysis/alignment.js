// Only compare the frames actually on screen, with explicit synchronization
// metadata. Never infer a shared pulse from equal per-camera sequence numbers.
export function displayedAlignment(frames) {
  if (frames.length < 2) return {status: 'single'};
  if (frames.some(frame => !frame || frame.timestamp == null)) return {status: 'waiting'};
  if (frames.some(frame => frame.pulse == null || frame.epoch == null || frame.clock == null)) return {status: 'unidentified'};
  const first = frames[0];
  if (frames.some(frame => String(frame.pulse) !== String(first.pulse) ||
      frame.epoch !== first.epoch || frame.clock !== first.clock)) return {status: 'mismatch'};
  const timestamps = frames.map(frame => BigInt(frame.timestamp));
  const min = timestamps.reduce((a, b) => a < b ? a : b);
  const max = timestamps.reduce((a, b) => a > b ? a : b);
  return {status: 'aligned', pulse: String(first.pulse), span: max - min,
    offsets: timestamps.map(timestamp => timestamp - min)};
}
