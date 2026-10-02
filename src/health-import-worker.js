import { importAppleHealthFile } from './health-import.js?v=6';

self.onmessage = async ({ data }) => {
  try {
    const logs = await importAppleHealthFile(data.file, {
      onProgress: (message) => self.postMessage({ type: 'progress', message }),
    });
    self.postMessage({ type: 'done', logs });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
