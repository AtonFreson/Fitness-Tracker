import { debugLog, debugError } from './tanita-scan-debug.js?v=3';

const WORKER_URL = './src/tanita-scan-worker.js?v=5';
const INIT_TIMEOUT_MS = 5000;
const SCAN_TIMEOUT_MS = 90000;
let activeSession = null;
let nextRequestId = 1;

function stopSession(session, error) {
  if (!session) return;
  clearTimeout(session.initTimer);
  session.worker.terminate();
  session.rejectReady(error);
  for (const request of session.pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  session.pending.clear();
  if (activeSession === session) activeSession = null;
}

async function ensureWorker(onStage) {
  if (!('Worker' in window) || !('createImageBitmap' in window)) {
    throw new Error('This browser cannot run the background receipt detector.');
  }
  if (activeSession) return activeSession.ready;
  onStage?.({ phase: 'loading-detector' });
  const worker = new Worker(WORKER_URL);
  const session = { worker, pending: new Map() };
  session.ready = new Promise((resolve, reject) => {
    session.resolveReady = resolve;
    session.rejectReady = reject;
  });
  activeSession = session;
  session.initTimer = setTimeout(() => {
    stopSession(session, new Error('Background receipt detector did not initialize within 5 seconds.'));
  }, INIT_TIMEOUT_MS);

  worker.addEventListener('message', ({ data: message }) => {
    if (activeSession !== session) return;
    if (message.type === 'log') {
      debugLog(message.event || 'scanner-worker-log', {
        ...message.data, workerElapsedMs: message.workerElapsedMs ?? null,
      });
    } else if (message.type === 'ready') {
      clearTimeout(session.initTimer);
      debugLog('scanner-worker-ready', { engine: message.engine });
      session.resolveReady(session);
    } else if (message.type === 'worker-error') {
      const error = new Error(message.message || 'Receipt detector failed.');
      debugError('scanner-worker-reported-error', error, { context: message.context });
      const request = session.pending.get(message.context?.requestId);
      if (request) {
        clearTimeout(request.timer);
        session.pending.delete(message.context.requestId);
        request.reject(error);
      } else {
        stopSession(session, error);
      }
    } else if (message.type === 'scan-result' || message.type === 'warp-result') {
      const request = session.pending.get(message.requestId);
      if (!request) return;
      clearTimeout(request.timer);
      session.pending.delete(message.requestId);
      request.resolve(message);
    }
  });
  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'Receipt detector crashed.');
    debugError('scanner-worker-error-event', error);
    stopSession(session, error);
  });
  worker.addEventListener('messageerror', () => {
    stopSession(session, new Error('Receipt detector returned an unreadable message.'));
  });
  debugLog('scanner-worker-created', { workerUrl: WORKER_URL, engine: 'built-in-js' });
  try {
    worker.postMessage({ type: 'init' });
  } catch (error) {
    stopSession(session, error);
  }
  return session.ready;
}

async function requestPixels(sourceCanvas, type, extra = {}, onStage) {
  const session = await ensureWorker(onStage);
  if (activeSession !== session) throw new Error('Receipt detector stopped.');
  onStage?.({ phase: 'transferring-photo' });
  const bitmap = await createImageBitmap(sourceCanvas);
  if (activeSession !== session) {
    bitmap.close();
    throw new Error('Receipt detector stopped.');
  }
  const requestId = nextRequestId++;
  onStage?.({ phase: 'detecting' });
  debugLog('scanner-worker-request', { requestId, type, width: bitmap.width, height: bitmap.height });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stopSession(session, new Error('Receipt processing took longer than 90 seconds and was stopped.'));
    }, SCAN_TIMEOUT_MS);
    session.pending.set(requestId, { resolve, reject, timer });
    try {
      session.worker.postMessage({ type, requestId, bitmap, ...extra }, [bitmap]);
    } catch (error) {
      bitmap.close();
      clearTimeout(timer);
      session.pending.delete(requestId);
      reject(error);
    }
  });
}

function pixelsToCanvas(receipt) {
  const canvas = document.createElement('canvas');
  canvas.width = receipt.width;
  canvas.height = receipt.height;
  canvas.getContext('2d', { alpha: false }).putImageData(
    new ImageData(new Uint8ClampedArray(receipt.buffer), receipt.width, receipt.height), 0, 0,
  );
  return canvas;
}

async function scanReceiptsInWorker(sourceCanvas, { onStage } = {}) {
  const result = await requestPixels(sourceCanvas, 'scan', {}, onStage);
  onStage?.({ phase: 'receiving-results' });
  const canvases = result.receipts.map(pixelsToCanvas);
  debugLog('scanner-worker-result-received', { receiptCount: canvases.length, engine: result.engine });
  return { quads: result.quads, canvases, source: result.engine };
}

async function warpReceiptInWorker(sourceCanvas, points) {
  const result = await requestPixels(sourceCanvas, 'warp', { points });
  return pixelsToCanvas(result.receipt);
}

function resetScannerWorker() {
  debugLog('scanner-worker-reset');
  stopSession(activeSession, new Error('Receipt detector stopped: reset.'));
}

export { scanReceiptsInWorker, warpReceiptInWorker, resetScannerWorker };
