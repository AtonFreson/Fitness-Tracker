import test from 'node:test';
import assert from 'node:assert/strict';
import { readingForPosition } from '../src/tanita-indicator-review.js';

test('indicator mapping keeps graph values on five-percent steps', () => { assert.equal(readingForPosition('fat_percent', 0.586).reading, '+: 35%'); assert.equal(readingForPosition('bmr', 0.501).reading, '0: 50%'); });
test('custom section boundaries account for scan perspective', () => { const bounds = [0, 0.267, 0.516, 0.766, 1]; assert.equal(readingForPosition('fat_percent', 0.583, bounds).reading, '+: 25%'); });
