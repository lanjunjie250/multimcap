// Two camera models leave room for one shared IMAGE recovery graph. Three
// Workers cover six cameras, with one in-flight job per Worker.
const CAMERAS_PER_WORKER = 2;
export class HandScheduler {
  constructor(onResult, onStatus) {
    this.onResult = onResult;
    this.onStatus = onStatus;
    this.generation = 0;
    this.requestId = 0;
    this.enabled = false;
    this.pending = new Map();
    this.cache = new Map();
    this.lanes = [];
    this.assignments = new Map();
    this.completed = 0;
    this.skipped = 0;
    this.perStream = {};
    this.perStreamBackend = {};
    this.recoveryStats = {attempts:0, passes:0, hands:0, milliseconds:0, perStream:{}, delegates:{}};
  }
  get busy() { return this.lanes.some(lane => lane.busy); }
  enable(numHands = 2) {
    this.disable();
    this.enabled = true;
    this.numHands = numHands;
    this.onStatus('正在加载手部模型…');
    this.addWorker();
  }
  addWorker() {
    const lane = {worker: new Worker('/analysis/hand_landmarks.worker.js'), streams: new Set(), ready: false, busy: false};
    this.lanes.push(lane);
    lane.timer = setTimeout(() => this.fail('模型加载超时；请检查本地模型资源'), 45000);
    lane.worker.onmessage = ({data}) => {
      if (!this.enabled || !this.lanes.includes(lane)) return;
      if (data.type === 'ready') {
        clearTimeout(lane.timer);
        lane.ready = true;
        this.ready = true;
        this.backend = data;
        this.onStatus('手部跟踪 · ' + data.delegate + (data.fallback ? '（兼容模式）' : ''));
        this.pump();
      } else if (data.type === 'result' || data.type === 'error') {
        clearTimeout(lane.timer);
        lane.busy = false;
        lane.activeKey = null;
        if (data.type === 'error') {
          if (data.requestId === undefined || data.generation === this.generation) { this.fail(data.error); return; }
          this.pump();return;
        }
        if (data.generation === this.generation) {
          this.completed++;
          const stream = data.key.split(':')[1];
          this.perStream[stream] = (this.perStream[stream] || 0) + 1;
          this.perStreamBackend[stream] = data.delegate;
          if(data.recoveryAttempted){
            this.recoveryStats.attempts++;this.recoveryStats.hands+=data.recoveredCount||0;
            this.recoveryStats.passes+=data.recoveryPasses||0;
            this.recoveryStats.milliseconds+=data.recoveryMs||0;
            this.recoveryStats.perStream[stream]=(this.recoveryStats.perStream[stream]||0)+(data.recoveredCount||0);
            this.recoveryStats.delegates[stream]=data.recoveryDelegate;
          }
          this.cache.set(data.key, data);
          while (this.cache.size > 240) this.cache.delete(this.cache.keys().next().value);
          this.onResult(data);
          this.onStatus('手部跟踪 · ' + (data.delegate || this.backend.delegate) + ' · ' + data.inferenceMs.toFixed(0) + ' ms · ' + data.hands.length + ' 只手');
        }
        this.pump();
      }
    };
    lane.worker.onerror = event => {
      if (this.enabled && this.lanes.includes(lane)) this.fail(event.message || '推理 Worker 失败');
    };
    lane.worker.postMessage({type: 'init', numHands: this.numHands});
    return lane;
  }
  laneFor(stream) {
    if (!this.assignments.has(stream)) {
      const lane = this.lanes.find(item => item.streams.size < CAMERAS_PER_WORKER) || this.addWorker();
      lane.streams.add(stream);
      this.assignments.set(stream, lane);
    }
    return this.assignments.get(stream);
  }
  fail(message) {
    this.disable();
    this.onStatus('检测不可用：' + message + '；可关闭后重试', true);
  }
  reset() {
    this.generation++;
    for (const task of this.pending.values()) task.bitmap?.close();
    this.pending.clear();
    this.cache.clear();
    this.assignments.clear();
    for (const lane of this.lanes) {
      lane.streams.clear();
      lane.worker.postMessage({type: 'reset', generation: this.generation});
    }
  }
  disable() {
    this.enabled = false;
    this.ready = false;
    for (const lane of this.lanes) { clearTimeout(lane.timer);lane.worker.terminate(); }
    this.lanes = [];
    this.reset();
  }
  offer(stream, key, source, timeMs, urgent = false) {
    if (!this.enabled || this.cache.has(key)) return;
    const lane = this.laneFor(stream);
    if (lane.activeKey === key && lane.activeGeneration === this.generation) return;
    const old = this.pending.get(stream);
    if (old && (!old.bitmap || !urgent || old.key === key)) { this.skipped++; return; }
    old?.bitmap?.close();
    const task = {stream, key, timeMs, generation: this.generation, requestId: ++this.requestId, bitmap: null};
    this.pending.set(stream, task);
    createImageBitmap(source).then(bitmap => {
      if (!this.enabled || task.generation !== this.generation || this.pending.get(stream) !== task) {
        bitmap.close();return;
      }
      task.bitmap = bitmap;
      this.pump();
    }).catch(error => {
      if (this.pending.get(stream) === task) this.pending.delete(stream);
      if (task.generation === this.generation) this.fail(error.message);
    });
  }
  pump() {
    if (!this.enabled) return;
    for (const lane of this.lanes) {
      if (!lane.ready || lane.busy) continue;
      const entry = [...this.pending].find(([stream, task]) => task.bitmap && this.assignments.get(stream) === lane);
      if (!entry) continue;
      const [stream, task] = entry;
      this.pending.delete(stream);
      lane.busy = true;
      lane.activeKey = task.key;
      lane.activeGeneration = task.generation;
      lane.timer = setTimeout(() => this.fail('推理超时'), 15000);
      lane.worker.postMessage({type: 'detect', ...task}, [task.bitmap]);
    }
  }
}
