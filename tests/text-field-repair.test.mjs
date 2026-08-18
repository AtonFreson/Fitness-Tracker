import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverTextFields, shouldUseRecoveredText } from '../src/text-field-repair.js';

test('recovers a complete multi-word TANITA physique rating', () => {
  const raw = `--- GOOGLE VISION FULL (SPATIAL) ---\nPHYSIQUE RATING\nHIDDEN OBESE\nBIOELECTRICAL DATA\nR 587.6 521.3`;
  const fields = recoverTextFields(raw, 'TANITA DC-360 · scan.pdf');
  assert.equal(fields.find((field) => field.path === 'qualitative.physique_rating')?.value, 'HIDDEN OBESE');
  assert.equal(shouldUseRecoveredText('HIDDEN', 'HIDDEN OBESE'), true);
  assert.equal(shouldUseRecoveredText('OBESE', 'HIDDEN OBESE'), true);
});

test('keeps previously unencountered TANITA text values intact', () => {
  const raw = `INPUT BODY TYPE PERFORMANCE CUSTOM GENDER X-CUSTOM AGE 26 HEIGHT 178 CLOTHES WEIGHT 0.5 RESULT`;
  const fields = recoverTextFields(raw, 'TANITA');
  assert.equal(fields.find((field) => field.path === 'input.body_type')?.value, 'PERFORMANCE CUSTOM');
  assert.equal(fields.find((field) => field.path === 'input.gender')?.value, 'X-CUSTOM');
});

test('recovers arbitrary ACCUNIQ body type text', () => {
  const raw = 'Body Type: Over fat class 7 special Values Body Composition Analysis';
  const fields = recoverTextFields(raw, 'ACCUNIQ');
  assert.equal(fields.find((field) => field.path === 'qualitative.body_type')?.value, 'Over fat class 7 special');
});
