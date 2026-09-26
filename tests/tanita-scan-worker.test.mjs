import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

class PixelImage {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}

const worker = vm.createContext({
  performance,
  ImageData: PixelImage,
  postMessage() {},
  self: {},
});
vm.runInContext(readFileSync(new URL('../src/tanita-scan-worker.js', import.meta.url), 'utf8'), worker);

function insidePolygon(x, y, points) {
  return points.every((point, index) => {
    const next = points[(index + 1) % points.length];
    return (next.x - point.x) * (y - point.y) - (next.y - point.y) * (x - point.x) >= 0;
  });
}

function syntheticReceipt({ printed = false, tabs = false, notch = false } = {}) {
  const image = new PixelImage(600, 1000);
  const corners = [{ x: 150, y: 110 }, { x: 325, y: 80 }, { x: 335, y: 900 }, { x: 140, y: 870 }];
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const top = 110 - (x - 150) * 30 / 175;
      const bottom = 870 + (x - 140) * 30 / 195;
      let paper = insidePolygon(x, y, corners);
      if (tabs && x >= 234 && x <= 239 && (y >= top - 9 && y <= top + 3
        || y >= bottom - 3 && y <= bottom + 9)) paper = true;
      if (notch && x >= 280 && x <= 286 && y < top + 8) paper = false;
      let value = paper ? 210 : 24;
      if (printed && paper && x > 157 && x < 316 && y > 260 && y < 790) {
        if (y % 60 < 19 || x % 14 < 5 && y % 17 < 10) value = 25;
      }
      const offset = (y * image.width + x) * 4;
      image.data.fill(value, offset, offset + 3);
      image.data[offset + 3] = 255;
    }
  }
  return { image, corners };
}

function assertCorners(actual, expected, tolerance) {
  assert.equal(actual.length, expected.length);
  actual.forEach((point, index) => {
    const error = Math.hypot(point.x - expected[index].x, point.y - expected[index].y);
    assert.ok(error <= tolerance, `corner ${index} missed by ${error.toFixed(2)}px`);
  });
}

test('paper edges stay aligned with sloped ends despite asymmetric printing, tabs and a notch', () => {
  for (const options of [{}, { printed: true }, { printed: true, tabs: true, notch: true }]) {
    const { image, corners } = syntheticReceipt(options);
    const quads = worker.detectPaperQuads(image);
    assert.equal(quads.length, 1);
    assertCorners(quads[0].points, corners, 2);
    const refined = worker.refineQuadSubpixel(image, quads[0].points);
    assert.equal(refined.refinedEdges, 4);
    assertCorners(refined.points, corners, 1.5);
  }
});

test('nearby printed bars do not pull refinement inside the receipt', () => {
  const image = new PixelImage(320, 700);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      let value = x >= 80 && x <= 240 && y >= 70 && y <= 630 ? 215 : 110;
      if (x > 84 && x < 236 && y >= 73 && y <= 76) value = 10;
      const offset = (y * image.width + x) * 4;
      image.data.fill(value, offset, offset + 3);
      image.data[offset + 3] = 255;
    }
  }
  const corners = [{ x: 80, y: 70 }, { x: 240, y: 70 }, { x: 240, y: 630 }, { x: 80, y: 630 }];
  const refined = worker.refineQuadSubpixel(image, corners);
  assertCorners(refined.points, corners, 1.5);
});

test('diagonal receipts retain four distinct corners in cyclic order', () => {
  const points = [{ x: 280, y: 40 }, { x: 360, y: 160 }, { x: 40, y: 480 }, { x: 0, y: 340 }];
  const ordered = worker.orderQuad(points);
  assert.equal(new Set(ordered).size, 4);
  assert.ok(worker.isConvexQuad(ordered));
  assert.equal(worker.polygonArea(ordered), worker.polygonArea(points));
});

test('manual warp preserves supplied corners and rotation, including landscape output', () => {
  const image = new PixelImage(20, 30);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = x * 10;
      image.data[offset + 1] = y * 8;
      image.data[offset + 3] = 255;
    }
  }
  const corners = [{ x: 2, y: 3 }, { x: 15, y: 2 }, { x: 17, y: 26 }, { x: 1, y: 25 }];
  for (let rotation = 0; rotation < 4; rotation += 1) {
    const ordered = corners.slice(rotation).concat(corners.slice(0, rotation));
    const result = worker.warpImageData(image, ordered, { preserveOrder: true });
    const expectedWidth = Math.round(Math.max(worker.distance(ordered[0], ordered[1]), worker.distance(ordered[3], ordered[2])));
    const expectedHeight = Math.round(Math.max(worker.distance(ordered[0], ordered[3]), worker.distance(ordered[1], ordered[2])));
    assert.equal(result.width, expectedWidth);
    assert.equal(result.height, expectedHeight);
    const offsets = [0, (result.width - 1) * 4, (result.width * result.height - 1) * 4, (result.height - 1) * result.width * 4];
    offsets.forEach((offset, index) => {
      assert.equal(result.data[offset], ordered[index].x * 10);
      assert.equal(result.data[offset + 1], ordered[index].y * 8);
    });
  }
});

test('failed scan and warp requests release their transferred bitmap', async () => {
  const messages = [];
  worker.postMessage = (message) => messages.push(message);
  try {
    for (const type of ['scan', 'warp']) {
      let closed = 0;
      const bitmap = { width: 20, height: 30, close() { closed += 1; } };
      const points = [{ x: 2, y: 3 }, { x: 15, y: 2 }, { x: 17, y: 26 }, { x: 1, y: 25 }];
      await worker.self.onmessage({ data: { type, bitmap, points, requestId: 42 } });
      assert.equal(closed, 1);
      assert.equal(messages.at(-1).type, 'worker-error');
      assert.equal(messages.at(-1).context.requestId, 42);
    }
  } finally {
    worker.postMessage = () => {};
  }
});
