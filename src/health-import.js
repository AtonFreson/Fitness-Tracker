import { openAppleHealthExportZip } from './zip-reader.js';

const TARGET_WORKOUT = 'HKWorkoutActivityTypeTraditionalStrengthTraining';
const HEART_RATE = 'HKQuantityTypeIdentifierHeartRate';
const ACTIVE_ENERGY = 'HKQuantityTypeIdentifierActiveEnergyBurned';

function decodeXml(value = '') {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attrs(tag) {
  const values = {};
  for (const match of tag.matchAll(/([A-Za-z0-9_:-]+)="([^"]*)"/g)) values[match[1]] = decodeXml(match[2]);
  return values;
}

function normalizeAppleDate(value) {
  if (!value) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})$/);
  return match ? `${match[1]}T${match[2]}${match[3]}:${match[4]}` : value.replace(' ', 'T');
}

function durationMinutes(value, unit) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const normalized = String(unit || '').toLowerCase();
  if (normalized.startsWith('sec') || normalized === 's') return number / 60;
  if (normalized.startsWith('hour') || normalized === 'hr' || normalized === 'h') return number * 60;
  return number;
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

async function streamTags(file, onTag) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let end;
    while ((end = buffer.indexOf('>')) >= 0) {
      const chunk = buffer.slice(0, end + 1);
      buffer = buffer.slice(end + 1);
      const start = chunk.lastIndexOf('<');
      if (start >= 0) await onTag(chunk.slice(start));
    }
    if (done) break;
    if (buffer.length > 2_000_000 && !buffer.includes('<')) buffer = buffer.slice(-4096);
  }
}

function workoutFromAttrs(values) {
  const startAt = normalizeAppleDate(values.startDate);
  const endAt = normalizeAppleDate(values.endDate);
  const totalEnergy = Number(values.totalEnergyBurned);
  return {
    start_at: startAt,
    end_at: endAt,
    start_ms: Date.parse(startAt),
    end_ms: Date.parse(endAt),
    duration_minutes: durationMinutes(values.duration, values.durationUnit),
    active_energy_kcal: Number.isFinite(totalEnergy) && /kcal/i.test(values.totalEnergyBurnedUnit || '') ? totalEnergy : null,
    heart_rate_summary: null,
  };
}

async function collectStrengthWorkouts(file, onProgress) {
  const workouts = [];
  let current = null;

  await streamTags(file, (tag) => {
    if (tag.startsWith('<Workout ')) {
      const values = attrs(tag);
      current = values.workoutActivityType === TARGET_WORKOUT ? workoutFromAttrs(values) : null;
      if (current && tag.endsWith('/>')) {
        workouts.push(current);
        current = null;
      }
      return;
    }

    if (current && tag.startsWith('<WorkoutStatistics ')) {
      const values = attrs(tag);
      if (values.type === ACTIVE_ENERGY) {
        const amount = Number(values.sum);
        if (Number.isFinite(amount) && (!values.unit || /kcal/i.test(values.unit))) current.active_energy_kcal = amount;
      } else if (values.type === HEART_RATE) {
        const average = Number(values.average);
        const min = Number(values.minimum);
        const max = Number(values.maximum);
        current.heart_rate_summary = {
          average_bpm: Number.isFinite(average) ? average : null,
          min_bpm: Number.isFinite(min) ? min : null,
          max_bpm: Number.isFinite(max) ? max : null,
        };
      }
      return;
    }

    if (tag.startsWith('</Workout')) {
      if (current) workouts.push(current);
      current = null;
      if (onProgress && workouts.length && workouts.length % 25 === 0) onProgress(`Found ${workouts.length} strength workouts…`);
    }
  });

  return workouts.sort((a, b) => a.start_ms - b.start_ms);
}

function findWorkoutAt(workouts, timestamp) {
  let low = 0;
  let high = workouts.length - 1;
  let best = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (workouts[middle].start_ms <= timestamp) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best >= 0 && timestamp <= workouts[best].end_ms + 1000 ? best : -1;
}

async function enrichWithRecords(file, workouts, onProgress) {
  const summaries = workouts.map(() => ({
    samples: [],
    sampleKeys: new Set(),
    hrSum: 0,
    hrMin: Infinity,
    hrMax: -Infinity,
    energyKcal: 0,
    energyCount: 0,
    energyKeys: new Set(),
  }));
  let matched = 0;

  await streamTags(file, (tag) => {
    if (!tag.startsWith('<Record ')) return;
    const values = attrs(tag);
    if (values.type !== HEART_RATE && values.type !== ACTIVE_ENERGY) return;

    const at = normalizeAppleDate(values.startDate);
    const timestamp = Date.parse(at);
    if (!Number.isFinite(timestamp)) return;
    const index = findWorkoutAt(workouts, timestamp);
    if (index < 0) return;

    const amount = Number(values.value);
    if (!Number.isFinite(amount)) return;
    const summary = summaries[index];
    matched += 1;

    if (values.type === HEART_RATE && /count\/min|bpm/i.test(values.unit || 'count/min')) {
      const endAt = normalizeAppleDate(values.endDate);
      const sample = { at, bpm: amount };
      if (endAt && endAt !== at) sample.end_at = endAt;
      const key = `${sample.at}|${sample.end_at || ''}|${sample.bpm}`;
      if (summary.sampleKeys.has(key)) return;
      summary.sampleKeys.add(key);
      summary.samples.push(sample);
      summary.hrSum += amount;
      summary.hrMin = Math.min(summary.hrMin, amount);
      summary.hrMax = Math.max(summary.hrMax, amount);
    } else if (values.type === ACTIVE_ENERGY && /kcal/i.test(values.unit || 'kcal')) {
      const endAt = normalizeAppleDate(values.endDate);
      const key = `${at}|${endAt || ''}|${amount}`;
      if (summary.energyKeys.has(key)) return;
      summary.energyKeys.add(key);
      summary.energyCount += 1;
      summary.energyKcal += amount;
    }

    if (onProgress && matched % 5000 === 0) onProgress(`Matched ${matched.toLocaleString()} workout records…`);
  });

  return workouts.map((workout, index) => {
    const summary = summaries[index];
    summary.samples.sort((a, b) => a.at.localeCompare(b.at) || String(a.end_at || '').localeCompare(String(b.end_at || '')) || a.bpm - b.bpm);
    const records = summary.samples.length ? {
      average_bpm: round1(summary.hrSum / summary.samples.length),
      min_bpm: round1(summary.hrMin),
      max_bpm: round1(summary.hrMax),
    } : null;
    const stats = workout.heart_rate_summary;
    const heartRate = (stats || records) ? {
      average_bpm: stats?.average_bpm ?? records?.average_bpm ?? null,
      min_bpm: stats?.min_bpm ?? records?.min_bpm ?? null,
      max_bpm: stats?.max_bpm ?? records?.max_bpm ?? null,
      samples: summary.samples,
    } : null;

    return {
      ...workout,
      heart_rate: heartRate,
      active_energy_kcal: workout.active_energy_kcal ?? (summary.energyCount ? round1(summary.energyKcal) : null),
    };
  });
}

function toWorkoutLog(workout) {
  return {
    schema_version: 1,
    id: `apple-health:strength:${workout.start_at}`,
    kind: 'workout',
    workout_type: 'traditional_strength_training',
    start_at: workout.start_at,
    end_at: workout.end_at,
    duration_minutes: workout.duration_minutes,
    active_energy_kcal: workout.active_energy_kcal,
    heart_rate_bpm: workout.heart_rate,
    source: { type: 'apple_health_export' },
  };
}

async function importAppleHealthXml(file, { onProgress } = {}) {
  if (!/\.xml$/i.test(file.name || '') && !/xml/i.test(file.type || '')) {
    throw new Error('Choose Apple Health export.xml or an Apple Health export ZIP.');
  }
  onProgress?.('Pass 1/2: finding Traditional Strength Training workouts…');
  const workouts = await collectStrengthWorkouts(file, onProgress);
  if (!workouts.length) return [];
  onProgress?.(`Found ${workouts.length} strength workouts. Pass 2/2: matching heart-rate and energy records…`);
  return (await enrichWithRecords(file, workouts, onProgress)).map(toWorkoutLog);
}

async function importAppleHealthFile(file, { onProgress } = {}) {
  const name = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  const isZip = name.endsWith('.zip') || type === 'application/zip' || type === 'application/x-zip-compressed';
  let xmlFile = file;
  if (isZip) {
    onProgress?.('Opening Apple Health ZIP…');
    xmlFile = await openAppleHealthExportZip(file);
  }
  return importAppleHealthXml(xmlFile, { onProgress });
}

export { importAppleHealthXml, importAppleHealthFile, TARGET_WORKOUT, normalizeAppleDate };
