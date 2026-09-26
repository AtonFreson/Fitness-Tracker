import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import {
  scanReceiptsInWorker,
  warpReceiptInWorker,
  resetScannerWorker,
} from '../src/tanita-scan-worker-client.js';

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function browser(t) {
  const workers = [];
  const bitmaps = [];
  const source = { width: 120, height: 480 };
  const originals = new Map();
  function install(name, value) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  class Worker {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.messages = [];
      this.terminated = false;
      workers.push(this);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    postMessage(message, transfers = []) {
      if (this.postError) throw this.postError;
      this.messages.push({ message, transfers });
    }
    terminate() {
      this.terminated = true;
    }
    emit(type, event = {}) {
      this.listeners.get(type)?.(event);
    }
    reply(message) {
      this.emit('message', { data: message });
    }
    ready() {
      this.reply({ type: 'ready', engine: 'built-in-js' });
    }
  }

  const env = {
    workers,
    bitmaps,
    source,
    makeBitmap() {
      const bitmap = {
        ...source,
        closed: false,
        close() { this.closed = true; },
      };
      bitmaps.push(bitmap);
      return bitmap;
    },
    bitmapFactory: () => Promise.resolve(env.makeBitmap()),
  };
  install('Worker', Worker);
  install('createImageBitmap', (canvas) => {
    assert.equal(canvas, source);
    return env.bitmapFactory();
  });
  install('window', { Worker, createImageBitmap: globalThis.createImageBitmap });
  install('ImageData', class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  });
  install('document', {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = {
        getContext() {
          return {
            putImageData(image, x, y) {
              assert.equal(x, 0);
              assert.equal(y, 0);
              canvas.image = image;
            },
          };
        },
      };
      return canvas;
    },
  });
  t.after(() => {
    resetScannerWorker();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return env;
}

async function dispatchScan(env) {
  const scan = scanReceiptsInWorker(env.source);
  const worker = env.workers.at(-1);
  worker.ready();
  await setImmediate();
  const packet = worker.messages.find(({ message }) => message.type === 'scan');
  assert.ok(packet, 'the ready worker receives the scan');
  return { scan, worker, packet };
}

function receiptPixels() {
  return { width: 2, height: 2, buffer: new Uint8ClampedArray([
    10, 20, 30, 255, 40, 50, 60, 255,
    70, 80, 90, 255, 100, 110, 120, 255,
  ]).buffer };
}

test('cancel during worker startup rejects the scan and ignores a late ready event', async (t) => {
  const env = browser(t);
  const cancelled = assert.rejects(scanReceiptsInWorker(env.source), /stopped/);
  const first = env.workers[0];
  resetScannerWorker();
  await cancelled;
  assert.equal(first.terminated, true);
  assert.equal(env.bitmaps.length, 0);

  const replacement = scanReceiptsInWorker(env.source);
  const second = env.workers[1];
  first.ready();
  await setImmediate();
  assert.equal(env.bitmaps.length, 0, 'old ready events cannot start the replacement scan');
  second.ready();
  await setImmediate();
  const { requestId } = second.messages.find(({ message }) => message.type === 'scan').message;
  second.reply({ type: 'scan-result', requestId, quads: [], receipts: [], engine: 'built-in-js' });
  assert.deepEqual(await replacement, { quads: [], canvases: [], source: 'built-in-js' });
  assert.equal(first.messages.length, 1, 'cancelled worker receives only initialization');
});

test('cancel during bitmap creation closes the late bitmap without transferring it', async (t) => {
  const env = browser(t);
  const pendingBitmap = deferred();
  env.bitmapFactory = () => pendingBitmap.promise;
  const cancelled = assert.rejects(scanReceiptsInWorker(env.source), /stopped/);
  const worker = env.workers[0];
  worker.ready();
  await setImmediate();
  resetScannerWorker();
  const bitmap = env.makeBitmap();
  pendingBitmap.resolve(bitmap);
  await cancelled;
  assert.equal(bitmap.closed, true);
  assert.deepEqual(worker.messages.map(({ message }) => message.type), ['init']);
});

for (const [event, expected] of [
  ['error', /browser worker crashed/],
  ['messageerror', /unreadable message/],
]) {
  test(`${event} rejects pending scans and the next scan starts a new worker`, async (t) => {
    const env = browser(t);
    const { scan, worker } = await dispatchScan(env);
    const failed = assert.rejects(scan, expected);
    worker.emit(event, { message: 'browser worker crashed' });
    await failed;
    assert.equal(worker.terminated, true);

    const next = scanReceiptsInWorker(env.source);
    const fresh = env.workers.at(-1);
    assert.notEqual(fresh, worker);
    fresh.ready();
    await setImmediate();
    const { requestId } = fresh.messages.find(({ message }) => message.type === 'scan').message;
    fresh.reply({ type: 'scan-result', requestId, quads: [], receipts: [], engine: 'built-in-js' });
    await next;
  });
}

test('worker startup errors reject initialization and allow a fresh attempt', async (t) => {
  const env = browser(t);
  const failed = assert.rejects(scanReceiptsInWorker(env.source), /no canvas support/);
  const worker = env.workers[0];
  worker.reply({ type: 'worker-error', message: 'no canvas support', context: { type: 'init' } });
  await failed;
  assert.equal(worker.terminated, true);
  const next = scanReceiptsInWorker(env.source);
  const cancelled = assert.rejects(next, /stopped/);
  assert.equal(env.workers.length, 2);
  resetScannerWorker();
  await cancelled;
});

test('a failed scan request rejects only that request and preserves the worker for retry', async (t) => {
  const env = browser(t);
  const { scan, worker, packet } = await dispatchScan(env);
  const failed = assert.rejects(scan, /invalid photograph/);
  worker.reply({
    type: 'worker-error', message: 'invalid photograph',
    context: { requestId: packet.message.requestId },
  });
  await failed;
  assert.equal(worker.terminated, false);
  const next = scanReceiptsInWorker(env.source);
  await setImmediate();
  assert.equal(env.workers.length, 1);
  const { requestId } = worker.messages.at(-1).message;
  worker.reply({ type: 'scan-result', requestId, quads: [], receipts: [], engine: 'built-in-js' });
  await next;
});

test('manual warp transfers the source with ordered corners and rebuilds returned pixels', async (t) => {
  const env = browser(t);
  const points = [{ x: 91, y: 450 }, { x: 15, y: 449 }, { x: 13, y: 24 }, { x: 96, y: 20 }];
  const warped = warpReceiptInWorker(env.source, points);
  const worker = env.workers[0];
  worker.ready();
  await setImmediate();
  const { message, transfers } = worker.messages.at(-1);
  assert.equal(message.type, 'warp');
  assert.deepEqual(message.points, points, 'display orientation is preserved without reordering');
  assert.equal(message.bitmap, env.bitmaps[0]);
  assert.deepEqual(transfers, [env.bitmaps[0]]);

  const pixels = receiptPixels();
  worker.reply({ type: 'warp-result', requestId: message.requestId, receipt: pixels });
  const canvas = await warped;
  assert.equal(canvas.width, 2);
  assert.equal(canvas.height, 2);
  assert.deepEqual(canvas.image.data, new Uint8ClampedArray(pixels.buffer));
});

test('scan results preserve correspondence between source quads and receipt canvases', async (t) => {
  const env = browser(t);
  const { scan, worker, packet } = await dispatchScan(env);
  const quads = [{ points: [{ x: 5, y: 8 }, { x: 95, y: 10 }, { x: 98, y: 410 }, { x: 4, y: 415 }] }];
  const receipt = receiptPixels();
  worker.reply({
    type: 'scan-result', requestId: packet.message.requestId,
    quads, receipts: [receipt], engine: 'built-in-js',
  });
  const result = await scan;
  assert.deepEqual(result.quads, quads);
  assert.equal(result.canvases.length, 1);
  assert.deepEqual(result.canvases[0].image.data, new Uint8ClampedArray(receipt.buffer));
  assert.equal(result.source, 'built-in-js');
});

test('a failed bitmap transfer closes its bitmap and rejects without leaving a pending request', async (t) => {
  const env = browser(t);
  const failed = assert.rejects(warpReceiptInWorker(env.source, []), /transfer failed/);
  const worker = env.workers[0];
  worker.postError = new Error('transfer failed');
  worker.ready();
  await failed;
  assert.equal(env.bitmaps[0].closed, true);
  assert.equal(worker.messages.length, 1);
});
