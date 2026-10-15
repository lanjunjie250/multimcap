import {indexRecording} from './recording.js';
import {indexArchive} from './merge.js';
self.onmessage = async ({data}) => {
  try {
    const progress=value=>self.postMessage({type:'progress',progress:value});
    const result=data.files?await indexArchive(data.files,data.groups,data.info,progress):await indexRecording(data.file,progress);
    self.postMessage({type: 'ready', result});
  } catch (error) { self.postMessage({type: 'error', error: error.message}); }
};
