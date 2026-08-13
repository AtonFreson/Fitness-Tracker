import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeLogs,
  dataPathForLog,
  parseJsonl,
  sortLogs,
  createUpsertEvent,
  createDeleteEvent,
  applyEvents,
  eventPathForTimestamp,
} from '../src/storage.js';

test('mergeLogs upserts by deterministic id', () => {
  const old = { id: 'x', kind: 'body_composition', measured_at_local: '2030-01-01T10:00:00', metrics: { weight_kg: 70 } };
  const newer = { ...old, metrics: { weight_kg: 71 } };
  const result = mergeLogs([old], [newer]);
  assert.equal(result.length, 1);
  assert.equal(result[0].metrics.weight_kg, 71);
});

test('legacy storage paths remain readable for v4 migration', () => {
  assert.equal(dataPathForLog({ kind: 'body_composition' }), 'data/body-composition.jsonl');
  assert.equal(dataPathForLog({ kind: 'workout', start_at: '2031-04-05T12:00:00+08:00' }), 'data/workouts/2031.jsonl');
});

test('JSONL parser and sorter preserve logical logs', () => {
  const text = '{"id":"b","kind":"workout","start_at":"2030-02-01"}\n{"id":"a","kind":"workout","start_at":"2030-01-01"}\n';
  const parsed = parseJsonl(text);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(sortLogs(parsed.logs).map((x) => x.id), ['a', 'b']);
});

test('append-only events resolve latest upsert and later tombstone', () => {
  const first = { id: 'x', kind: 'body_composition', measured_at_local: '2030-01-01', metrics: { weight_kg: 70 } };
  const corrected = { ...first, metrics: { weight_kg: 71 } };
  const events = [
    { path: 'a', event: createUpsertEvent([first], '2030-01-02T00:00:00.000Z') },
    { path: 'b', event: createUpsertEvent([corrected], '2030-01-03T00:00:00.000Z') },
  ];
  assert.equal(applyEvents([], events)[0].metrics.weight_kg, 71);
  events.push({ path: 'c', event: createDeleteEvent(['x'], '2030-01-04T00:00:00.000Z') });
  assert.deepEqual(applyEvents([], events), []);
});

test('a later upsert restores a previously hidden record', () => {
  const log = { id: 'x', kind: 'workout', start_at: '2030-01-01' };
  const events = [
    { path: 'a', event: createUpsertEvent([log], '2030-01-01T00:00:00.000Z') },
    { path: 'b', event: createDeleteEvent(['x'], '2030-01-02T00:00:00.000Z') },
    { path: 'c', event: createUpsertEvent([log], '2030-01-03T00:00:00.000Z') },
  ];
  assert.deepEqual(applyEvents([], events).map((x) => x.id), ['x']);
});

test('event files are partitioned by year and carry sortable timestamps', () => {
  const path = eventPathForTimestamp('2031-04-05T12:34:56.789Z', 'abc');
  assert.equal(path, 'data/events/2031/20310405T123456789Z_abc.json');
});
