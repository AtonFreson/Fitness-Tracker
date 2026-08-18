import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readableFieldLabel,
  recordEditorPathVisible,
  sortLogViewItems,
  logViewItemVisible,
} from '../src/record-view.js';

test('record editor uses readable labels and hides graph implementation fields', () => {
  assert.equal(readableFieldLabel('metrics.weight_kg'), 'Weight (kg)');
  assert.equal(readableFieldLabel('heart_rate_bpm.samples'), 'Heart-rate samples');
  assert.equal(readableFieldLabel('something_new.custom_value'), 'Something New · Custom Value');
  assert.equal(recordEditorPathVisible('indicators.bmi.reading'), true);
  assert.equal(recordEditorPathVisible('indicators.bmi.position'), false);
  assert.equal(recordEditorPathVisible('indicators.bmi.confidence'), false);
});

test('record sorting handles duration and missing values', () => {
  const items = [
    { date: '2026-01-02', durationMinutes: null, type: 'Body composition' },
    { date: '2026-01-01', durationMinutes: 45, type: 'Workout' },
    { date: '2026-01-03', durationMinutes: 60, type: 'Workout' },
  ];
  assert.deepEqual(sortLogViewItems(items, 'duration-desc').map((item) => item.durationMinutes), [60, 45, null]);
  assert.deepEqual(sortLogViewItems(items, 'date-asc').map((item) => item.date), ['2026-01-01', '2026-01-02', '2026-01-03']);
});

test('record visibility can hide types and sources and search remaining rows', () => {
  const tanita = { type: 'Body composition', source: 'TANITA DC-360', searchText: '2026-03-19 TANITA 69.5 kg' };
  assert.equal(logViewItemVisible(tanita, { showBody: false }), false);
  assert.equal(logViewItemVisible(tanita, { showBody: true, showTanita: false }), false);
  assert.equal(logViewItemVisible(tanita, { showBody: true, showTanita: true, search: '69.5' }), true);
  assert.equal(logViewItemVisible(tanita, { showBody: true, showTanita: true, search: 'apple' }), false);
});
