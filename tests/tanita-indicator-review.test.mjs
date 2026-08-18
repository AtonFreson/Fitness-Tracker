import test from 'node:test';
import assert from 'node:assert/strict';
import { readingForPosition, preserveReviewedIndicators } from '../src/tanita-indicator-review.js';

test('indicator mapping keeps graph values on five-percent steps', () => {
  assert.equal(readingForPosition('fat_percent', 0.586).reading, '+: 35%');
  assert.equal(readingForPosition('bmr', 0.501).reading, '0: 50%');
});

test('custom section boundaries account for scan perspective', () => {
  const bounds = [0, 0.267, 0.516, 0.766, 1];
  assert.equal(readingForPosition('fat_percent', 0.583, bounds).reading, '+: 25%');
});

test('legacy stored graph corrections survive a re-upload', () => {
  const fresh = {
    indicators: {
      fat_percent: { reading: '+: 25%', level: '+', section_percent: 25, position: 0.583, source: 'indicator_graph_refined' },
      bmi: { reading: '0: 60%', level: '0', section_percent: 60, position: 0.416, source: 'indicator_graph_refined' },
      muscle_mass: { reading: '-: 95%', level: '-', section_percent: 95, position: 0.332, source: 'indicator_graph_refined' },
      bmr: { reading: '0: 45%', level: '0', section_percent: 45, position: 0.499, source: 'indicator_graph_refined' },
    },
  };
  const stored = {
    indicators: {
      fat_percent: { reading: '+: 30%', position: 0.578, source: 'indicator_graph' },
      bmi: { reading: '0: 60%', position: 0.424, source: 'indicator_graph' },
      muscle_mass: { reading: '-: 95%', position: 0.343, source: 'indicator_graph' },
      bmr: { reading: '0: 45%', position: 0.493, source: 'indicator_graph' },
    },
  };
  const result = preserveReviewedIndicators(fresh, stored);
  assert.equal(result.indicators.fat_percent.reading, '+: 30%');
  assert.equal(result.indicators.bmi.reading, '0: 60%');
  assert.equal(result.indicators.muscle_mass.reading, '-: 95%');
  assert.equal(result.indicators.bmr.reading, '0: 45%');
  assert.equal(result.indicators.bmr.source, 'manual_review');
  assert.equal('position' in result.indicators.bmr, false);
});

test('refined automatic readings are not mistaken for manual corrections', () => {
  const fresh = { indicators: { bmr: { reading: '0: 45%', source: 'indicator_graph_refined' } } };
  const stored = { indicators: { bmr: { reading: '0: 45%', position: 0.499, source: 'indicator_graph_refined' } } };
  assert.equal(preserveReviewedIndicators(fresh, stored).indicators.bmr.source, 'indicator_graph_refined');
});
