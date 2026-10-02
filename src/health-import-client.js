import { importAppleHealthFile } from './health-import.js?v=6';

export function importHealthInWorker(file, { onProgress, signal } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException('Import cancelled.', 'AbortError'));
  if (typeof Worker === 'undefined') return importAppleHealthFile(file, { onProgress });
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./health-import-worker.js?v=1', import.meta.url), { type: 'module' });
    const finish = (error, logs) => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(logs);
    };
    const abort = () => finish(new DOMException('Import cancelled.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress?.(data.message);
      else if (data.type === 'done') finish(null, data.logs);
      else if (data.type === 'error') finish(new Error(data.message));
    };
    worker.onerror = () => finish(new Error('The Health importer could not finish. Please keep this tab open and try again.'));
    worker.postMessage({ file });
  });
}
