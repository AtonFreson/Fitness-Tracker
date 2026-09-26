import { debugLog, debugError } from './tanita-scan-debug.js?v=2';

const OPENCV_SOURCES = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  'https://docs.opencv.org/4.x/opencv.js',
];

const WORKER_URL = './src/tanita-scan-worker.js?v=2';
const INIT_TIMEOUT_MS = 30000;
const SCAN_TIMEOUT_MS = 90000;

let activeWorker = null;
let initializingWorker = null;
let activeSource = null;
let readyPromise = null;
let nextRequestId = 1;
const pending = new Map();

function terminateWorker(reason = 'reset') {
  if (initializingWorker && initializingWorker !== activeWorker) {
    debugLog('scanner-worker-init-terminated', { reason, source: activeSource });
    try { initializingWorker.terminate(); } catch {}
  }
  if (activeWorker) {
    debugLog('scanner-worker-terminated', { reason, source: activeSource });
    try { activeWorker.terminate(); } catch {}
  }
  initializingWorker = null;
  activeWorker = null;
  activeSource = null;
  readyPromise = null;

  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('Receipt detector stopped: ' + reason));
  }
  pending.clear();
}

function attachWorkerEvents(worker, source, resolveReady, rejectReady) {
  worker.addEventListener('message', (event) => {
    const message = event.data || {};

    if (message.type === 'log') {
      debugLog(message.event || 'scanner-worker-log', {
        ...(message.data || {}),
        workerElapsedMs: message.workerElapsedMs ?? null,
        source,
      });
      return;
    }

    if (message.type === 'ready') {
      debugLog('scanner-worker-ready', { source });
      resolveReady(worker);
      return;
    }

    if (message.type === 'worker-error') {
      const error = new Error(message.message || 'Receipt detector worker failed.');
      if (message.stack) error.stack = message.stack;
      debugError('scanner-worker-reported-error', error, {
        source,
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
        source,
      });
    }
  });

  worker.addEventListener('error', (event) => {
    const error = new Error(event.message || 'Receipt detector worker crashed.');
    debugError('scanner-worker-error-event', error, {
      source,
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

  worker.addEventListener('messageerror', (event) => {
    const error = new Error('Receipt detector worker returned an unreadable message.');
    debugError('scanner-worker-message-error', error, { source });
    rejectReady(error);
  });
}

function startWorkerForSource(source) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL);
    initializingWorker = worker;
    activeSource = source;
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

    attachWorkerEvents(worker, source, finishResolve, finishReject);

    const timer = setTimeout(() => {
      debugLog('scanner-worker-init-timeout', {
        source,
        timeoutMs: INIT_TIMEOUT_MS,
      });
      finishReject(new Error(
        'Background receipt detector did not initialize within '
        + Math.round(INIT_TIMEOUT_MS / 1000)
        + ' seconds.',
      ));
    }, INIT_TIMEOUT_MS);

    debugLog('scanner-worker-created', { source, workerUrl: WORKER_URL });
    worker.postMessage({ type: 'init', url: source });
  });
}

async function ensureWorker(onStage = null) {
  if (activeWorker) return activeWorker;
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    let lastError = null;

    for (let index = 0; index < OPENCV_SOURCES.length; index += 1) {
      const source = OPENCV_SOURCES[index];
      onStage?.({
        phase: 'loading-detector',
        sourceIndex: index + 1,
        sourceCount: OPENCV_SOURCES.length,
      });

      try {
        const worker = await startWorkerForSource(source);
        activeWorker = worker;
        activeSource = source;
        debugLog('scanner-worker-source-selected', { source });
        return worker;
      } catch (error) {
        lastError = error;
        debugError('scanner-worker-source-failed', error, { source });
      }
    }

    throw new Error(
      'The background receipt detector could not start. '
      + (lastError?.message || 'Both OpenCV sources failed.'),
    );
  })();

  try {
    return await readyPromise;
  } finally {
    if (!activeWorker) readyPromise = null;
  }
}

function bitmapToCanvas(bitmap) {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { alpha: false });
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();
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
        source: activeSource,
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
    source: activeSource,
    width: bitmap.width,
    height: bitmap.height,
  });
  worker.postMessage({ type: 'scan', requestId, bitmap }, [bitmap]);

  const result = await resultPromise;
  onStage?.({ phase: 'receiving-results' });

  const canvases = result.receipts.map(bitmapToCanvas);
  debugLog('scanner-worker-result-received', {
    requestId,
    receiptCount: canvases.length,
    quadCount: result.quads.length,
    source: result.source,
  });

  return {
    quads: result.quads,
    canvases,
    source: result.source,
  };
}

function resetScannerWorker() {
  terminateWorker('manual reset');
}

export { scanReceiptsInWorker, resetScannerWorker };
