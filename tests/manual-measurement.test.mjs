import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManualMeasurement, manualFields, fieldValue, localDateTime } from '../src/manual-measurement.js';
import { dataPathForLog, mergeLogs, sameUploadRecord } from '../src/storage.js';
import { BODY_METRICS, pointsFor, metricCatalog } from '../src/analytics.js';
import { fitBodyModel } from '../src/body-model.js';

const date = '2030-03-15T08:30';
const build = (values, options) => buildManualMeasurement({ measured_at_local: date, ...values }, options);

test('a single value saves with full precision and blanks stay absent', () => {
  const log = build({ device: '  One-off clinic  ', 'metrics.bmi': '23.456', 'metrics.weight_kg': '' });
  assert.equal(log.source.type, 'manual_entry');
  assert.equal(log.source.device, 'One-off clinic');
  assert.deepEqual(log.metrics, { bmi: 23.456 });
  assert.equal(log.measured_at_local, '2030-03-15T08:30:00');
  assert.equal(dataPathForLog(log), 'data/events/2030-03.json');
  assert.equal(metricCatalog([log]).find((s) => s.key === 'bmi').key, 'bmi');
  const weight = BODY_METRICS.find((s) => s.key === 'weight_kg');
  assert.deepEqual(pointsFor([log], weight), []);
});

test('all supported form fields round-trip, including dotted frequency keys and signed targets', () => {
  const values = Object.fromEntries(manualFields.map(([path, , type]) => [path,
    path.endsWith('.reading') ? '+: 50%' : type === 'number' ? '12.345' : 'Report wording',
  ]));
  values['targets.weight_control_kg'] = '-4.6';
  values['metrics.degree_of_obesity_percent'] = '-2.5';
  const log = build({ ...values, notes: 'One-off measurement', manufacturer: 'Example' });
  for (const [path, , type] of manualFields) assert.equal(fieldValue(log, path), type === 'number' ? Number(values[path]) : values[path], path);
  assert.deepEqual(log.bioelectrical['6.25_khz'], { r_ohm: 12.345, x_ohm: 12.345 });
  assert.equal(log.notes, 'One-off measurement');
  assert.equal(log.source.manufacturer, 'Example');
});

test('zero and text-only readings are retained, without requiring weight', () => {
  assert.equal(build({ 'metrics.fat_percent': '0' }).metrics.fat_percent, 0);
  assert.equal(build({ 'qualitative.evaluation': 'Device classification' }).qualitative.evaluation, 'Device classification');
  assert.equal(build({ 'metrics.fat_mass_kg': '12,25' }).metrics.fat_mass_kg, 12.25);
});

test('empty entries and invalid dates, numbers, percentages and ranges are rejected', () => {
  assert.throws(() => build({ device: 'Clinic', notes: 'No values' }), /at least one/);
  for (const value of ['', '2030-02-29T10:00', '2030-03-15T24:00', 'not a date']) {
    assert.throws(() => build({ measured_at_local: value, 'metrics.weight_kg': '70' }), /date and time/);
  }
  assert.equal(build({ measured_at_local: '2032-02-29T12:30', 'metrics.weight_kg': 70 }).measured_at_local, '2032-02-29T12:30:00');
  for (const value of ['Infinity', 'NaN', 'abc']) assert.throws(() => build({ 'metrics.bmi': value }), /finite number/);
  assert.throws(() => build({ 'metrics.weight_kg': 0 }), /above zero/);
  assert.throws(() => build({ 'metrics.fat_percent': 101 }), /0 to 100/);
  assert.throws(() => build({ 'reference_ranges.weight_kg.min': 80, 'reference_ranges.weight_kg.max': 60 }), /minimum/);
  assert.throws(() => build({ 'indicators.bmr.reading': '++: 50%' }), /level and percentage/);
});

test('retries and edits replace only their own record; same-time measurements coexist', () => {
  const values = { 'metrics.weight_kg': 70 };
  const a = build(values, { draftId: 'draft-a' });
  const retry = build(values, { draftId: 'draft-a' });
  const b = build(values, { draftId: 'draft-b' });
  const tanita = { ...a, id: `tanita:${a.measured_at_local}`, source: { type: 'tanita_receipt' } };
  assert.equal(sameUploadRecord(a, retry), true);
  assert.equal(mergeLogs([tanita, a, b], [retry]).length, 3);
  const edit = build({ 'metrics.weight_kg': 71 }, { previous: a });
  assert.equal(edit.id, a.id);
  assert.equal(mergeLogs([a, b], [edit]).length, 2);
  const moved = build({ ...values, measured_at_local: '2030-04-01T09:00' }, { previous: a });
  assert.notEqual(moved.id, a.id);
  assert.equal(dataPathForLog(moved), 'data/events/2030-04.json');
  assert.ok(moved.id.endsWith(':draft-a'));
});

test('manual metrics are chartable but are not treated as calibrated device observations', () => {
  const log = build({ 'metrics.weight_kg': 70, 'metrics.fat_percent': 20 });
  const spec = BODY_METRICS.find((s) => s.key === 'fat_percent');
  assert.equal(pointsFor([log], spec, { source: 'manual_entry' })[0].v, 20);
  assert.equal(fitBodyModel([log]).observations.length, 0);
});

test('local defaults use local calendar components', () => {
  assert.equal(localDateTime(new Date(2030, 2, 15, 8, 5)), '2030-03-15T08:05');
});
