import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppleDate, normalizeAppleDevice, TARGET_WORKOUT, importAppleHealthFile } from '../src/health-import.js';

test('normalizes Apple Health date format', () => {
  assert.equal(normalizeAppleDate('2030-01-15 10:30:00 +0800'), '2030-01-15T10:30:00+08:00');
});

test('targets Traditional Strength Training', () => {
  assert.equal(TARGET_WORKOUT, 'HKWorkoutActivityTypeTraditionalStrengthTraining');
});


test('normalizes ephemeral HKDevice pointer addresses for stable full-export dedupe', () => {
  const a = '<<HKDevice: 0xd9631df20>, name:Anton’s AirPods Pro, manufacturer:Apple Inc., model:AirPods Pro, hardware:AirPods3,4, firmware:8B40>';
  const b = '<<HKDevice: 0xabc123>, name:Anton’s AirPods Pro, manufacturer:Apple Inc., model:AirPods Pro, hardware:AirPods3,4, firmware:8B40>';
  assert.equal(normalizeAppleDevice(a), normalizeAppleDevice(b));
  assert.equal(normalizeAppleDevice(a).includes('0xd9631df20'), false);
});

function le16(n) { return [n & 255, (n >>> 8) & 255]; }
function le32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
function concatBytes(...parts) {
  const arrays = parts.map((p) => p instanceof Uint8Array ? p : Uint8Array.from(p));
  const out = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
function storedZip(name, text) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const data = enc.encode(text);
  const local = concatBytes(le32(0x04034b50), le16(20), le16(0x0800), le16(0), le16(0), le16(0), le32(0), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), nameBytes, data);
  const central = concatBytes(le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(0), le16(0), le16(0), le32(0), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), le16(0), le16(0), le16(0), le32(0), le32(0), nameBytes);
  const eocd = concatBytes(le32(0x06054b50), le16(0), le16(0), le16(1), le16(1), le32(central.length), le32(local.length), le16(0));
  const blob = new Blob([local, central, eocd], { type: 'application/zip' });
  Object.defineProperty(blob, 'name', { value: 'export.zip' });
  return blob;
}

test('imports Traditional Strength Training directly from an Apple Health ZIP', async () => {
  const xml = `<HealthData>
    <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="60" durationUnit="min" sourceName="Apple Watch" startDate="2030-01-15 18:00:00 +0800" endDate="2030-01-15 19:00:00 +0800">
      <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="130" minimum="80" maximum="165" unit="count/min"/>
    </Workout>
  </HealthData>`;
  const zip = storedZip('apple_health_export/export.xml', xml);
  const logs = await importAppleHealthFile(zip);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].workout_type, 'traditional_strength_training');
  assert.equal(logs[0].duration_minutes, 60);
  assert.equal(logs[0].heart_rate_bpm.average_bpm, 130);
  assert.equal(logs[0].heart_rate_bpm.sample_count, 0);
  assert.deepEqual(logs[0].heart_rate_bpm.samples, []);
});

test('keeps every matched heart-rate reading with its timestamp', async () => {
  const xml = `<HealthData>
    <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" creationDate="2030-01-15 18:00:05 +0800" startDate="2030-01-15 18:00:05 +0800" endDate="2030-01-15 18:00:05 +0800" value="90"/>
    <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" creationDate="2030-01-15 18:00:10 +0800" startDate="2030-01-15 18:00:10 +0800" endDate="2030-01-15 18:00:10 +0800" value="100"/>
    <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" creationDate="2030-01-15 18:00:15 +0800" startDate="2030-01-15 18:00:15 +0800" endDate="2030-01-15 18:00:15 +0800" value="110"/>
    <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="60" durationUnit="min" sourceName="Fitness" startDate="2030-01-15 18:00:00 +0800" endDate="2030-01-15 19:00:00 +0800">
      <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="101.25" minimum="85" maximum="125" unit="count/min"/>
    </Workout>
  </HealthData>`;
  const zip = storedZip('apple_health_export/export.xml', xml);
  const [log] = await importAppleHealthFile(zip);
  assert.equal(log.heart_rate_bpm.average_bpm, 101.25, 'keep Apple workout summary when present');
  assert.equal(log.heart_rate_bpm.min_bpm, 85);
  assert.equal(log.heart_rate_bpm.max_bpm, 125);
  assert.equal(log.heart_rate_bpm.sample_count, 3);
  assert.deepEqual(log.heart_rate_bpm.samples, [
    { at: '2030-01-15T18:00:05+08:00', bpm: 90 },
    { at: '2030-01-15T18:00:10+08:00', bpm: 100 },
    { at: '2030-01-15T18:00:15+08:00', bpm: 110 },
  ]);
});

test('computes heart-rate summary from raw records when WorkoutStatistics is absent', async () => {
  const xml = `<HealthData>
    <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2030-01-15 18:10:00 +0800" endDate="2030-01-15 18:10:00 +0800" value="80"/>
    <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2030-01-15 18:10:05 +0800" endDate="2030-01-15 18:10:05 +0800" value="100"/>
    <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="30" durationUnit="min" sourceName="Fitness" startDate="2030-01-15 18:00:00 +0800" endDate="2030-01-15 18:30:00 +0800"></Workout>
  </HealthData>`;
  const zip = storedZip('apple_health_export/export.xml', xml);
  const [log] = await importAppleHealthFile(zip);
  assert.equal(log.heart_rate_bpm.average_bpm, 90);
  assert.equal(log.heart_rate_bpm.min_bpm, 80);
  assert.equal(log.heart_rate_bpm.max_bpm, 100);
  assert.equal(log.heart_rate_bpm.sample_count, 2);
});
