import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppleDate, TARGET_WORKOUT, importAppleHealthFile } from '../src/health-import.js';

test('normalizes Apple Health date format', () => {
  assert.equal(normalizeAppleDate('2030-01-15 10:30:00 +0800'), '2030-01-15T10:30:00+08:00');
});

test('targets Traditional Strength Training', () => {
  assert.equal(TARGET_WORKOUT, 'HKWorkoutActivityTypeTraditionalStrengthTraining');
});

function le16(n) { return [n & 255, (n >>> 8) & 255]; }
function le32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
function concatBytes(...parts) {
  const arrays = parts.map((part) => part instanceof Uint8Array ? part : Uint8Array.from(part));
  const out = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let offset = 0;
  for (const array of arrays) { out.set(array, offset); offset += array.length; }
  return out;
}
function storedZip(name, text) {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(name);
  const data = encoder.encode(text);
  const local = concatBytes(le32(0x04034b50), le16(20), le16(0x0800), le16(0), le16(0), le16(0), le32(0), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), nameBytes, data);
  const central = concatBytes(le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(0), le16(0), le16(0), le32(0), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(0), nameBytes);
  const eocd = concatBytes(le32(0x06054b50), le16(0), le16(0), le16(1), le16(1), le32(central.length), le32(local.length), le16(0));
  const blob = new Blob([local, central, eocd], { type: 'application/zip' });
  Object.defineProperty(blob, 'name', { value: 'export.zip' });
  return blob;
}

test('imports Traditional Strength Training directly from a Health ZIP', async () => {
  const xml = `<HealthData>
    <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="60" durationUnit="min" startDate="2030-01-15 18:00:00 +0800" endDate="2030-01-15 19:00:00 +0800">
      <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="130" minimum="80" maximum="165" unit="count/min"/>
    </Workout>
  </HealthData>`;
  const [log] = await importAppleHealthFile(storedZip('apple_health_export/export.xml', xml));
  assert.equal(log.workout_type, 'traditional_strength_training');
  assert.equal(log.duration_minutes, 60);
  assert.equal(log.heart_rate_bpm.average_bpm, 130);
  assert.deepEqual(log.heart_rate_bpm.samples, []);
  assert.deepEqual(log.source, { type: 'apple_health_export' });
});

test('keeps every unique heart-rate reading with its timestamp', async () => {
  const xml = `<HealthData>
    <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="A" unit="count/min" startDate="2030-01-15 18:00:05 +0800" endDate="2030-01-15 18:00:05 +0800" value="90"/>
    <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="B" unit="count/min" startDate="2030-01-15 18:00:05 +0800" endDate="2030-01-15 18:00:05 +0800" value="90"/>
    <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2030-01-15 18:00:10 +0800" endDate="2030-01-15 18:00:10 +0800" value="100"/>
    <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2030-01-15 18:00:15 +0800" endDate="2030-01-15 18:00:15 +0800" value="110"/>
    <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="60" durationUnit="min" startDate="2030-01-15 18:00:00 +0800" endDate="2030-01-15 19:00:00 +0800">
      <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="101.25" minimum="85" maximum="125" unit="count/min"/>
    </Workout>
  </HealthData>`;
  const [log] = await importAppleHealthFile(storedZip('apple_health_export/export.xml', xml));
  assert.equal(log.heart_rate_bpm.average_bpm, 101.25);
  assert.equal(log.heart_rate_bpm.min_bpm, 85);
  assert.equal(log.heart_rate_bpm.max_bpm, 125);
  assert.deepEqual(log.heart_rate_bpm.samples, [
    { at: '2030-01-15T18:00:05+08:00', bpm: 90 },
    { at: '2030-01-15T18:00:10+08:00', bpm: 100 },
    { at: '2030-01-15T18:00:15+08:00', bpm: 110 },
  ]);
});

test('computes heart-rate summary when WorkoutStatistics is absent', async () => {
  const xml = `<HealthData>
    <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2030-01-15 18:10:00 +0800" endDate="2030-01-15 18:10:00 +0800" value="80"/>
    <Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" startDate="2030-01-15 18:10:05 +0800" endDate="2030-01-15 18:10:05 +0800" value="100"/>
    <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="30" durationUnit="min" startDate="2030-01-15 18:00:00 +0800" endDate="2030-01-15 18:30:00 +0800"></Workout>
  </HealthData>`;
  const [log] = await importAppleHealthFile(storedZip('apple_health_export/export.xml', xml));
  assert.equal(log.heart_rate_bpm.average_bpm, 90);
  assert.equal(log.heart_rate_bpm.min_bpm, 80);
  assert.equal(log.heart_rate_bpm.max_bpm, 100);
  assert.equal(log.heart_rate_bpm.samples.length, 2);
});

test('deduplicates identical active-energy records before using the fallback sum', async () => {
  const xml = `<HealthData>
    <Record type="HKQuantityTypeIdentifierActiveEnergyBurned" sourceName="A" unit="kcal" startDate="2030-01-15 18:05:00 +0800" endDate="2030-01-15 18:05:00 +0800" value="12.5"/>
    <Record type="HKQuantityTypeIdentifierActiveEnergyBurned" sourceName="B" unit="kcal" startDate="2030-01-15 18:05:00 +0800" endDate="2030-01-15 18:05:00 +0800" value="12.5"/>
    <Record type="HKQuantityTypeIdentifierActiveEnergyBurned" unit="kcal" startDate="2030-01-15 18:10:00 +0800" endDate="2030-01-15 18:10:00 +0800" value="7.5"/>
    <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="30" durationUnit="min" startDate="2030-01-15 18:00:00 +0800" endDate="2030-01-15 18:30:00 +0800"></Workout>
  </HealthData>`;
  const [log] = await importAppleHealthFile(storedZip('apple_health_export/export.xml', xml));
  assert.equal(log.active_energy_kcal, 20);
});
