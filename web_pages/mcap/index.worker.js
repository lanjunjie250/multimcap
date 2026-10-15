import {indexRecording} from './recording.js';
self.onmessage = async ({data}) => {
  try {
    const result = await indexRecording(data.file, progress => self.postMessage({type: 'progress', progress}));
    self.postMessage({type: 'ready', result});
  } catch (error) { self.postMessage({type: 'error', error: error.message}); }
};
