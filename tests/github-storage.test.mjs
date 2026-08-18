import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeLogs, sameUploadRecord, dataPathForLog, periodForLog, sortLogs } from '../src/storage.js';

test('mergeLogs replaces the same deterministic id', () => {
  const first = { id: 'x', kind: 'body_composition', measured_at_local: '2030-01-01T10:00:00', metrics: { weight_kg: 70 } };
  const second = { ...first, metrics: { weight_kg: 71 } };
  assert.deepEqual(mergeLogs([first], [second]), [second]);
});

test('re-uploading the same body composition source replaces an old timestamp/id', () => {
  const first = { id: 'tanita:bad-time', kind: 'body_composition', measured_at_local: '2030-01-01T10:00:00', source: { type: 'tanita_receipt', filename: 'scan.pdf' }, metrics: { weight_kg: 70 } };
  const corrected = { ...first, id: 'tanita:2030-01-01T10:05:00', measured_at_local: '2030-01-01T10:05:00', metrics: { weight_kg: 70.1 } };
  assert.equal(sameUploadRecord(first, corrected), true);
  assert.deepEqual(mergeLogs([first], [corrected]), [corrected]);
});

test('different receipt filenames remain separate records', () => {
  const a = { id: 'a', kind: 'body_composition', source: { type: 'tanita_receipt', filename: 'a.pdf' } };
  const b = { id: 'b', kind: 'body_composition', source: { type: 'tanita_receipt', filename: 'b.pdf' } };
  assert.equal(sameUploadRecord(a, b), false);
  assert.equal(mergeLogs([a], [b]).length, 2);
});

test('storage uses one JSON file per month', () => {
  const log = { id: 'apple-health:strength:2031-04-05T12:00:00+08:00', kind: 'workout', start_at: '2031-04-05T12:00:00+08:00' };
  assert.equal(periodForLog(log), '2031-04');
  assert.equal(dataPathForLog(log), 'data/events/2031-04.json');
});

test('records without a date use the unknown file', () => {
  assert.equal(dataPathForLog({ id: 'x', kind: 'body_composition' }), 'data/events/unknown.json');
});

test('mergeLogs collapses duplicate incoming ids', () => {
  const old = { id: 'x', kind: 'workout', start_at: '2030-01-01', active_energy_kcal: 100 };
  const updated = { ...old, active_energy_kcal: 120 };
  assert.deepEqual(mergeLogs([], [old, updated]), [updated]);
});
