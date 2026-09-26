import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTanitaDate,
  extractDateCandidates,
  resolveDateFromOcr,
  tanitaPdfFilename,
  formatTanitaDisplayDate,
} from '../src/tanita-scan-core.js';

test('normalizes TANITA printed dates', () => {
  assert.equal(normalizeTanitaDate('15/SEP/2026'), '2026-09-15');
  assert.equal(normalizeTanitaDate('23 SEP 2026'), '2026-09-23');
  assert.equal(normalizeTanitaDate('2026-08-06'), '2026-08-06');
  assert.equal(normalizeTanitaDate('06/08/2026'), '2026-08-06');
  assert.equal(normalizeTanitaDate('31/FEB/2026'), null);
  assert.equal(normalizeTanitaDate('23/AUG/2026'), '2026-08-23');
  assert.equal(normalizeTanitaDate('23/SEP/2026'), '2026-09-23');
  assert.equal(normalizeTanitaDate('13/SEP/2026'), '2026-09-13');
  assert.equal(normalizeTanitaDate('09/SEP/2026'), '2026-09-09');
});

test('extracts one date from OCR text without reading body values', () => {
  assert.deepEqual(
    extractDateCandidates('TANITA BODY COMPOSITION ANALYZER DC-360 09/SEP/2026 18:30 INPUT'),
    ['2026-09-09'],
  );
});

test('uses the bottom date to identify an upside-down receipt', () => {
  const result = resolveDateFromOcr('BIOELECTRICAL DATA', 'TANITA 23/SEP/2026 21:34');
  assert.equal(result.date, '2026-09-23');
  assert.equal(result.orientation, 180);
  assert.equal(result.needsManual, false);
});

test('requires manual confirmation when OCR dates conflict', () => {
  const result = resolveDateFromOcr('15/SEP/2026', '13/SEP/2026');
  assert.equal(result.date, null);
  assert.equal(result.needsManual, true);
  assert.equal(result.reason, 'conflicting');
});

test('creates tracker-compatible filenames', () => {
  assert.equal(tanitaPdfFilename('15/SEP/2026'), '2026-09-15 TANITA.pdf');
  assert.equal(tanitaPdfFilename('2026-09-15', 2), '2026-09-15 TANITA 2.pdf');
});

test('shows a receipt-style date without changing the PDF filename', () => {
  assert.equal(formatTanitaDisplayDate('2026-09-13'), '13/Sep/2026');
  assert.equal(tanitaPdfFilename('2026-09-13'), '2026-09-13 TANITA.pdf');
});
