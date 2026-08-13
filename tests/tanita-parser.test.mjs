import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTanitaText } from '../src/tanita-parser.js';

const CLEAR_RECEIPT = `
TANITA BODY COMPOSITION ANALYZER DC-360
15/JAN/2030 18:45
INPUT
BODY TYPE STANDARD
GENDER MALE
AGE 30
HEIGHT 180.0cm
CLOTHES WEIGHT 0.5kg
RESULT
WEIGHT 80.0kg
FAT % 20.0 %
FAT MASS 16.0kg
FFM 64.0kg
MUSCLE MASS 60.8kg
TBW 40.0kg
TBW % 50.0 %
BONE MASS 3.2kg
BMR 7500 kJ
1793kcal
METABOLIC AGE 30
VISCERAL FAT RATING 7
BMI 24.7
IDEAL BODY WEIGHT 71.3kg
DEGREE OF OBESITY 12.2 %
DESIRABLE RANGE
FAT % 10.0 - 22.0 %
FAT MASS 8.0 - 17.6kg
PHYSIQUE RATING STANDARD
BIOELECTRICAL DATA
6.25kHz 50kHz
R 600.0 530.0
X -25.0 -45.0
`;

test('parses a clear DC-360 receipt', () => {
  const parsed = parseTanitaText(CLEAR_RECEIPT, { sourceName: '2030-01-15 TANITA.pdf' });
  assert.equal(parsed.measured_at_local, '2030-01-15T18:45:00');
  assert.equal(parsed.metrics.weight_kg, 80.0);
  assert.equal(parsed.metrics.fat_percent, 20.0);
  assert.equal(parsed.metrics.bmr_kcal, 1793);
  assert.equal(parsed.qualitative.physique_rating, 'STANDARD');
  assert.equal(parsed.bioelectrical['50_khz'].x_ohm, -45.0);
});

test('repairs a common BMR OCR digit error using kJ', () => {
  const parsed = parseTanitaText(CLEAR_RECEIPT.replace('1793kcal', '1993kcal'));
  assert.equal(parsed.metrics.bmr_kcal, 1793);
  assert.match(parsed.extraction.warnings.join(' '), /normalized to 1793/);
});

test('uses filename date when OCR date is absent', () => {
  const parsed = parseTanitaText('RESULT\nWEIGHT 80.0kg\nBMI 24.7', { sourceName: '2030-02-01 TANITA.pdf' });
  assert.equal(parsed.date, '2030-02-01');
});
