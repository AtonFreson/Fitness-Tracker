import { debugLog, debugError } from './tanita-scan-debug.js?v=3';

const WORKER_URL = './src/tanita-scan-worker.js?v=3';
const INIT_TIMEOUT_MS = 5000;
const SCAN_TIMEOUT_MS = 90000;

let activeWorker = null;
let initializingWorker = null;
let readyPromise = null;
let nextRequestId = 1;
const pending = new Map();

function terminateWorker(reason = 'reset') {
  if (initializingWorker && initializingWorker !== activeWorker) {
    debugLog('scanner-worker-init-terminated', { reason });
    try { initializingWorker.terminate(); } catch {}
  }
  if (activeWorker) {
    debugLog('scanner-worker-terminated', { reason });
    try { activeWorker.terminate(); } catch {}
  }

  initializingWorker = null;
  activeWorker = null;
  readyPromise = null;

  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('Receipt detector stopped: ' + reason));
  }
  pending.clear();
}

function attachWorkerEvents(worker, resolveReady, rejectReady) {
  worker.addEventListener('message', (event) => {
    const message = event.data || {};

    if (message.type === 'log') {
      debugLog(message.event || 'scanner-worker-log', {
        ...(message.data || {}),
        workerElapsedMs: message.workerElapsedMs ?? null,
      });
      return;
    }

    if (message.type === 'ready') {
      debugLog('scanner-worker-ready', {
        engine: message.engine || 'built-in-js',
      });
      resolveReady(worker);
      return;
    }

    if (message.type === 'worker-error') {
      const error = new Error(message.message || 'Receipt detector worker failed.');
      if (message.stack) error.stack = message.stack;
      debugError('scanner-worker-reported-error', error, {
        context: message.context || null,
      });

      const requestId = message.context?.requestId;
      if (requestId && pending.has(requestId)) {
        const request = pending.get(requestId);
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.reject(error);
      } else {
        rejectReady(error);
      }
      return;
    }

    if (message.type === 'scan-result') {
      const request = pending.get(message.requestId);
      if (!request) return;

      clearTimeout(request.timer);
      pending.delete(message.requestId);
      request.resolve({
        quads: message.quads || [],
        receipts: message.receipts || [],
        engine: message.engine || 'built-in-js',
      });
    }
  });

  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'Receipt detector worker crashed.');
    debugError('scanner-worker-error-event', error, {
      filename: event.filename || '',
      lineno: event.lineno || null,
      colno: event.colno || null,
    });
    rejectReady(error);

    for (const [requestId, request] of pending.entries()) {
      clearTimeout(request.timer);
      pending.delete(requestId);
      request.reject(error);
    }
  });

  worker.addEventListener('messageerror', () => {
    const error = new Error('Receipt detector worker returned an unreadable message.');
    debugError('scanner-worker-message-error', error);
    rejectReady(error);
  });
}

function startWorker() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL);
    initializingWorker = worker;
    let settled = false;

    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      initializingWorker = null;
      resolve(value);
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (initializingWorker === worker) initializingWorker = null;
      try { worker.terminate(); } catch {}
      reject(error);
    };

    attachWorkerEvents(worker, finishResolve, finishReject);

    const timer = setTimeout(() => {
      debugLog('scanner-worker-init-timeout', { timeoutMs: INIT_TIMEOUT_MS });
      finishReject(new Error(
        'Background receipt detector did not initialize within '
        + Math.round(INIT_TIMEOUT_MS / 1000)
        + ' seconds.',
      ));
    }, INIT_TIMEOUT_MS);

    debugLog('scanner-worker-created', {
      workerUrl: WORKER_URL,
      engine: 'built-in-js',
    });
    worker.postMessage({ type: 'init' });
  });
}

async function ensureWorker(onStage = null) {
  if (activeWorker) return activeWorker;
  if (readyPromise) return readyPromise;

  onStage?.({ phase: 'loading-detector' });
  readyPromise = startWorker();

  try {
    const worker = await readyPromise;
    activeWorker = worker;
    debugLog('scanner-worker-engine-selected', { engine: 'built-in-js' });
    return worker;
  } finally {
    if (!activeWorker) readyPromise = null;
  }
}

function pixelsToCanvas(receipt) {
  const canvas = document.createElement('canvas');
  canvas.width = receipt.width;
  canvas.height = receipt.height;
  const context = canvas.getContext('2d', { alpha: false });
  const pixels = new Uint8ClampedArray(receipt.buffer);
  context.putImageData(new ImageData(pixels, receipt.width, receipt.height), 0, 0);
  return canvas;
}

async function scanReceiptsInWorker(sourceCanvas, { onStage } = {}) {
  if (!('Worker' in window)) {
    throw new Error('This browser does not support background workers.');
  }
  if (!('createImageBitmap' in window)) {
    throw new Error('This browser cannot transfer the photo to the background detector.');
  }

  const worker = await ensureWorker(onStage);
  onStage?.({ phase: 'transferring-photo' });

  const bitmapStarted = performance.now();
  const bitmap = await createImageBitmap(sourceCanvas);
  debugLog('scanner-worker-bitmap-created', {
    elapsedMs: Math.round(performance.now() - bitmapStarted),
    width: bitmap.width,
    height: bitmap.height,
  });

  const requestId = nextRequestId++;
  onStage?.({ phase: 'detecting' });

  const resultPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      debugLog('scanner-worker-scan-timeout', {
        requestId,
        timeoutMs: SCAN_TIMEOUT_MS,
      });
      terminateWorker('scan timeout');
      reject(new Error(
        'Receipt detection took longer than '
        + Math.round(SCAN_TIMEOUT_MS / 1000)
        + ' seconds and was stopped.',
      ));
    }, SCAN_TIMEOUT_MS);

    pending.set(requestId, { resolve, reject, timer });
  });

  debugLog('scanner-worker-scan-posted', {
    requestId,
    width: bitmap.width,
    height: bitmap.height,
    engine: 'built-in-js',
  });
  worker.postMessage({ type: 'scan', requestId, bitmap }, [bitmap]);

  const result = await resultPromise;
  onStage?.({ phase: 'receiving-results' });

  const canvases = result.receipts.map(pixelsToCanvas);
  debugLog('scanner-worker-result-received', {
    requestId,
    receiptCount: canvases.length,
    quadCount: result.quads.length,
    engine: result.engine,
  });

  return {
    quads: result.quads,
    canvases,
    source: result.engine,
  };
}

function resetScannerWorker() {
  terminateWorker('manual reset');
}

export { scanReceiptsInWorker, resetScannerWorker };
