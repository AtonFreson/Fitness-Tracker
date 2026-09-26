import test from 'node:test';
import assert from 'node:assert/strict';
import {
  receiptGeometry, rotateGeometry180, sourceToView, viewToSource,
  reviewFrame, nudgeCorner,
} from '../src/tanita-scan-geometry.js';

const portrait = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 600 }, { x: 100, y: 600 }];

test('review margin contains original photo outside all four crop edges', () => {
  assert.deepEqual(reviewFrame(portrait, 1000, 1000, 0), {
    left: 90, top: 50, width: 120, height: 600,
  });
});

test('one and ten pixel nudges use photo pixels, independently of preview scale', () => {
  const one = nudgeCorner(portrait, 0, 1, 0, 0, 1000, 1000);
  assert.deepEqual(one[0], { x: 101, y: 100 });
  const ten = nudgeCorner(one, 0, 0, -10, 0, 1000, 1000);
  assert.deepEqual(ten[0], { x: 101, y: 90 });
  assert.deepEqual(ten.slice(1), portrait.slice(1));
  assert.deepEqual(portrait[0], { x: 100, y: 100 });
});

test('upside-down receipt labels and nudge directions follow the visible receipt', () => {
  const receipt = receiptGeometry(portrait);
  rotateGeometry180(receipt);
  assert.deepEqual(receipt.points[0], portrait[2]);
  const moved = nudgeCorner(receipt.points, 0, 1, -10, receipt.quarterTurns, 1000, 1000);
  assert.deepEqual(moved[0], { x: 199, y: 610 });
  rotateGeometry180(receipt);
  assert.deepEqual(receipt.points, portrait);
});

test('horizontal receipts and all rotations preserve screen directions', () => {
  const horizontal = [{ x: 50, y: 100 }, { x: 650, y: 100 }, { x: 650, y: 200 }, { x: 50, y: 200 }];
  const receipt = receiptGeometry(horizontal);
  assert.equal(receipt.quarterTurns, 1);
  assert.deepEqual(receipt.points[0], horizontal[3]);
  for (let turns = 0; turns < 4; turns += 1) {
    const point = { x: 200, y: 300 };
    assert.deepEqual(viewToSource(sourceToView(point, 1000, 800, turns), 1000, 800, turns), point);
    const before = sourceToView(portrait[0], 1000, 800, turns);
    const result = nudgeCorner(portrait, 0, 10, -1, turns, 1000, 800);
    const after = sourceToView(result[0], 1000, 800, turns);
    assert.deepEqual(after, { x: before.x + 10, y: before.y - 1 });
  }
});

test('nudges cannot cross edges or leave the source photograph', () => {
  assert.equal(nudgeCorner(portrait, 0, 150, 300, 0, 1000, 1000), null);
  assert.equal(nudgeCorner(portrait, 0, -110, 0, 0, 1000, 1000), null);
});
