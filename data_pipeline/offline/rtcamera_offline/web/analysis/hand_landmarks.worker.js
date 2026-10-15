/* Classic Worker is intentional: MediaPipe's WASM loader uses importScripts.
 * Each camera owns a VIDEO graph; sharing a tracker across cameras is invalid.
 * Two VIDEO graphs plus one shared IMAGE recovery graph per Worker stay within
 * the tested WebGL context budget. Recovery examines the current frame only.
 */
let api, files, numHands = 2, delegate = 'GPU', generation = null, spare = null;
let motion, recovery = null;
const streams = new Map();

async function createDetector(mode = 'VIDEO') {
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext('webgl2');
  const extension = gl?.getExtension('WEBGL_debug_renderer_info');
  const renderer = extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : 'unknown';
  const software = !gl || /swiftshader|llvmpipe|softpipe|software/i.test(renderer);
  const options = {
    canvas,
    baseOptions: {modelAssetPath: '/assets/hand_landmarker.task', delegate: software ? 'CPU' : delegate},
    runningMode: mode, numHands,
    minHandDetectionConfidence: mode === 'IMAGE' ? 0.35 : 0.5, minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
  let detector, fallback = '';
  try {
    detector = await api.HandLandmarker.createFromOptions(files, options);
  } catch (error) {
    if (options.baseOptions.delegate === 'CPU') throw error;
    fallback = String(error);
    options.baseOptions.delegate = 'CPU';
    detector = await api.HandLandmarker.createFromOptions(files, options);
  }
  delegate = options.baseOptions.delegate;
  return {detector, gl, delegate, renderer, software, fallback, lastTime: null,
    motion: mode === 'VIDEO' ? new motion.MotionRecovery() : null};
}

function resultHands(result) {
  return result.landmarks.map((landmarks, i) => ({landmarks,
    label: result.handedness[i]?.[0]?.categoryName || 'Unknown',
    // This score describes handedness, not landmark presence confidence.
    score: result.handedness[i]?.[0]?.score || 0}));
}

function closeDetector(state) {
  state.detector.close();
  state.gl?.getExtension('WEBGL_lose_context')?.loseContext();
}

function resetModels(nextGeneration) {
  for (const state of streams.values()) closeDetector(state);
  streams.clear();generation = nextGeneration;
}

// Reset messages can arrive while asynchronous graph creation is running.
let messages = Promise.resolve();
self.onmessage = ({data}) => {
  messages = messages.then(() => handleMessage(data)).catch(error => {
    self.postMessage({type: 'error', error: String(error)});
  });
};
async function handleMessage(data) {
  if (data.type === 'reset') { resetModels(data.generation);return; }
  if (data.type === 'init') {
    try {
      api = await import('/assets/vision_bundle.mjs');
      motion = await import('/analysis/motion.js');
      files = await api.FilesetResolver.forVisionTasks('/assets/wasm');
      numHands = data.numHands || 2;
      spare = await createDetector();
      const {delegate, renderer, software, fallback} = spare;
      self.postMessage({type: 'ready', delegate, renderer, software, fallback, mode: 'VIDEO'});
    } catch (error) {
      self.postMessage({type: 'error', error: String(error)});
    }
    return;
  }
  if (data.type === 'detect') {
    const {bitmap, key, generation: requestedGeneration, requestId, stream, timeMs} = data;
    try {
      if (!api) throw Error('Detector is not initialized');
      if (!Number.isFinite(timeMs)) throw Error('Frame timestamp is required');
      // Seeks, camera selection and recording replacement start fresh graphs.
      if (generation !== requestedGeneration) {
        resetModels(requestedGeneration);
      }
      let state = streams.get(stream);
      if (state && (timeMs <= state.lastTime ||
                    state.width !== bitmap.width || state.height !== bitmap.height)) {
        closeDetector(state);streams.delete(stream);state = null;
      }
      if (!state) {
        if (streams.size >= 2) throw Error('Too many camera models in one Worker');
        state = spare || await createDetector();spare = null;
        streams.set(stream, state);
      }
      if (state.delegate === 'GPU' && state.gl?.isContextLost()) throw Error('GPU context lost; restart hand detection');
      const start = performance.now();
      const result = state.detector.detectForVideo(bitmap, timeMs);
      if (state.delegate === 'GPU' && state.gl?.isContextLost()) throw Error('GPU context lost during inference');
      const hands = motion.uniqueHands(resultHands(result));
      const fullFrameCount = hands.length;
      const region = state.motion.propose(hands, timeMs, bitmap.width, bitmap.height, numHands);
      let recoveryMs = 0, recoveryPasses = 0;
      if (region) {
        const recoveryStart = performance.now();
        if (!recovery) {
          recovery = await createDetector('IMAGE');
          recovery.crop = new OffscreenCanvas(384, 384);
          recovery.context = recovery.crop.getContext('2d');
        }
        if (recovery.delegate === 'GPU' && recovery.gl?.isContextLost()) throw Error('GPU recovery context lost');
        recovery.context.drawImage(bitmap, region.x, region.y, region.width, region.height, 0, 0, 384, 384);
        const local = resultHands(recovery.detector.detect(recovery.crop));
        recoveryPasses++;
        let recovered = state.motion.accept(region, local, hands);
        // Side-on hands/grasping poses can be missed by the palm detector.
        // One additional orientation uses the same IMAGE graph and pixels.
        if (!recovered.length) {
          recovery.context.save();
          recovery.context.translate(192, 192);recovery.context.rotate(-Math.PI / 2);
          recovery.context.drawImage(bitmap, region.x, region.y, region.width, region.height, -192, -192, 384, 384);
          recovery.context.restore();
          const rotated = motion.unrotateRecovery(resultHands(recovery.detector.detect(recovery.crop)));
          recoveryPasses++;
          recovered = state.motion.accept(region, rotated, hands);
        }
        if (recovery.delegate === 'GPU' && recovery.gl?.isContextLost()) throw Error('GPU recovery context lost during inference');
        hands.push(...recovered);
        recoveryMs = performance.now() - recoveryStart;
      }
      state.motion.commit(hands, timeMs, numHands);
      state.lastTime = timeMs;state.width = bitmap.width;state.height = bitmap.height;
      self.postMessage({type: 'result', key, generation: requestedGeneration, requestId, hands,
                       fullFrameCount, recoveredCount: hands.length - fullFrameCount,
                       recoveryAttempted: !!region, recoveryPasses, recoveryMs, recoveryDelegate: region ? recovery.delegate : null,
                       delegate: state.delegate, contextLost: state.gl?.isContextLost(), inferenceMs: performance.now() - start});
    } catch (error) {
      self.postMessage({type: 'error', key, generation: requestedGeneration, requestId, error: String(error)});
    } finally {
      bitmap.close();
    }
  }
}
