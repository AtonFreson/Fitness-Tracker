import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalStep, stepIndicatorReading, recordEntries, coerceRecordValue } from '../src/ui-helpers.js';

test('numeric steppers use tenths', () => { assert.equal(decimalStep('70.2', 1), 70.3); assert.equal(decimalStep('70.2', -1), 70.1); });
test('graph steppers roll between sections in five percent steps', () => { assert.equal(stepIndicatorReading('-: 95%', 1, 'indicators.muscle_mass.reading'), '0: 0%'); assert.equal(stepIndicatorReading('0: 0%', -1, 'indicators.muscle_mass.reading'), '-: 95%'); assert.equal(stepIndicatorReading('0: 95%', 1, 'indicators.fat_percent.reading'), '+: 0%'); assert.equal(stepIndicatorReading('+: 95%', 1, 'indicators.fat_percent.reading'), '++: 0%'); });
test('full record editor keeps arrays as editable JSON fields', () => { const entries = recordEntries({ metrics: { weight_kg: 70.2 }, samples: [{ bpm: 100 }] }); assert.deepEqual(entries.map(x => [x.path, x.kind]), [['metrics.weight_kg', 'number'], ['samples', 'json']]); assert.deepEqual(coerceRecordValue('[{"bpm":101}]', 'json'), [{ bpm: 101 }]); });
