import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAccuniqText, toAccuniqBodyCompositionLog } from '../src/accuniq-parser.js';
import { detectBodyCompositionSource, detectUploadKind } from '../src/source-detection.js';

const ACCUNIQ_REPORT = `
ACCUNIQ Manager
Date/Time of measurement: 30.01.15 10:30
Comprehensive Evaluation
Analysis
80 This value is based on PBF, muscle mass and age.
Physical Age 30Years BMR 1600 kcal
TDE 2400 kcal Target Weight 68.0 kg Weight Control -2.0 kg Muscle Control +0.0 kg Fat Control -2.0 kg Body Type: Standard
Values Body Water Muscle Mass Fat-Free Mass Weight
Body Composition Analysis
Body Water L
40.0
(35.0 ~ 45.0) 40.0
Protein kg
12.0
(10.0 ~ 14.0)
52.0
(47.0 ~ 57.0)
Minerals kg
4.0
(3.5 ~ 4.5)
56.0
(50.0 ~ 62.0)
Body Fat kg
14.0
(8.0 ~ 18.0)
70.0
(60.0 ~ 80.0)
Selvas Healthcare Inc.
`;

test('detects and parses the ACCUNIQ report format', () => {
  assert.equal(detectBodyCompositionSource(ACCUNIQ_REPORT, '2030-01-15 ACCUNIQ.pdf'), 'accuniq');
  const parsed = parseAccuniqText(ACCUNIQ_REPORT, { sourceName: '2030-01-15 ACCUNIQ.pdf' });
  assert.equal(parsed.measured_at_local, '2030-01-15T10:30:00');
  assert.equal(parsed.metrics.weight_kg, 70.0);
  assert.equal(parsed.metrics.fat_mass_kg, 14.0);
  assert.equal(parsed.metrics.fat_percent, 20.0);
  assert.equal(parsed.metrics.ffm_kg, 56.0);
  assert.equal(parsed.metrics.muscle_mass_kg, 52.0);
  assert.equal(parsed.metrics.body_water_l, 40.0);
  assert.equal(parsed.metrics.bmr_kcal, 1600);
  assert.equal(parsed.metrics.tdee_kcal, 2400);
  assert.equal(parsed.metrics.physical_age, 30);
  assert.equal(parsed.targets.target_weight_kg, 68.0);
  assert.equal(parsed.targets.weight_control_kg, -2.0);
  assert.equal(parsed.analysis.score, 80);
  assert.equal(parsed.qualitative.body_type, 'Standard');
  assert.deepEqual(parsed.reference_ranges.weight_kg, { min: 60.0, max: 80.0 });
});

test('creates a source-specific ACCUNIQ log id', () => {
  const parsed = parseAccuniqText(ACCUNIQ_REPORT, { sourceName: '2030-01-15 ACCUNIQ.pdf' });
  const log = toAccuniqBodyCompositionLog(parsed, { sourceName: '2030-01-15 ACCUNIQ.pdf' });
  assert.equal(log.id, 'accuniq:2030-01-15T10:30:00');
  assert.equal(log.source.type, 'accuniq_report');
});

test('routes supported file extensions before content parsing', () => {
  assert.equal(detectUploadKind({ name: 'receipt.pdf', type: 'application/pdf' }), 'body_composition_report');
  assert.equal(detectUploadKind({ name: 'export.xml', type: 'application/xml' }), 'apple_health_xml');
  assert.equal(detectUploadKind({ name: 'export.zip', type: 'application/zip' }), 'apple_health_zip');
});
