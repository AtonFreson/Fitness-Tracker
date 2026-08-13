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
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z0-9_:-]+)="([^"]*)"/g)) out[m[1]] = decodeXml(m[2]);
  return out;
}

function normalizeAppleDate(value) {
  if (!value) return null;
  // Apple Health export: 2030-01-15 10:30:00 +0800
  const m = value.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{2})(\d{2})$/);
  if (m) return `${m[1]}T${m[2]}${m[3]}:${m[4]}`;
  return value.replace(' ', 'T');
}

function durationMinutes(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const u = String(unit || '').toLowerCase();
  if (u.startsWith('min')) return n;
  if (u.startsWith('sec') || u === 's') return n / 60;
  if (u.startsWith('hour') || u === 'hr' || u === 'h') return n * 60;
  return n;
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
    // Prevent unbounded growth if the file contains a huge text node (Health export normally does not).
    if (buffer.length > 2_000_000 && !buffer.includes('<')) buffer = buffer.slice(-4096);
  }
}

function workoutFromAttrs(a) {
  const start = normalizeAppleDate(a.startDate);
  const end = normalizeAppleDate(a.endDate);
  const totalEnergy = Number(a.totalEnergyBurned);
  return {
    workout_type_raw: a.workoutActivityType || null,
    start_at: start,
    end_at: end,
    start_ms: start ? Date.parse(start) : NaN,
    end_ms: end ? Date.parse(end) : NaN,
    duration_minutes: durationMinutes(a.duration, a.durationUnit),
    active_energy_kcal: Number.isFinite(totalEnergy) && /kcal/i.test(a.totalEnergyBurnedUnit || '') ? totalEnergy : null,
    source_name: a.sourceName || null,
    source_version: a.sourceVersion || null,
    device: a.device || null,
    creation_date: normalizeAppleDate(a.creationDate),
    metadata: {},
  };
}

async function collectStrengthWorkouts(file, onProgress) {
  const workouts = [];
  let current = null;
  let interested = false;

  await streamTags(file, async (tag) => {
    if (tag.startsWith('<Workout ')) {
      const a = attrs(tag);
      interested = a.workoutActivityType === TARGET_WORKOUT;
      current = interested ? workoutFromAttrs(a) : null;
      if (interested && tag.endsWith('/>')) {
        workouts.push(current);
        current = null;
        interested = false;
      }
      return;
    }

    if (interested && current && tag.startsWith('<WorkoutStatistics ')) {
      const a = attrs(tag);
      if (a.type === ACTIVE_ENERGY && a.sum) {
        const value = Number(a.sum);
        if (Number.isFinite(value) && (!a.unit || /kcal/i.test(a.unit))) current.active_energy_kcal = value;
      }
      if (a.type === HEART_RATE) {
        const average = Number(a.average);
        const min = Number(a.minimum);
        const max = Number(a.maximum);
        if ([average, min, max].some(Number.isFinite)) {
          current.workout_heart_rate = {
            average_bpm: Number.isFinite(average) ? average : null,
            min_bpm: Number.isFinite(min) ? min : null,
            max_bpm: Number.isFinite(max) ? max : null,
            samples: null,
          };
        }
      }
      return;
    }

    if (interested && current && tag.startsWith('<MetadataEntry ')) {
      const a = attrs(tag);
      if (a.key) current.metadata[a.key] = a.value ?? null;
      return;
    }

    if (tag.startsWith('</Workout')) {
      if (interested && current) workouts.push(current);
      current = null;
      interested = false;
      if (onProgress && workouts.length % 25 === 0) onProgress(`Found ${workouts.length} strength workouts…`);
    }
  });

  workouts.sort((a, b) => a.start_ms - b.start_ms);
  return workouts;
}

function findWorkoutAt(workouts, timestamp) {
  let lo = 0;
  let hi = workouts.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (workouts[mid].start_ms <= timestamp) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best >= 0 && timestamp <= workouts[best].end_ms + 1000) return best;
  return -1;
}

async function enrichWithRecords(file, workouts, onProgress) {
  const summaries = workouts.map(() => ({
    hrCount: 0, hrSum: 0, hrMin: Infinity, hrMax: -Infinity,
    energyKcal: 0, energyCount: 0,
    sources: new Set(), devices: new Set(),
  }));
  let relevantRecords = 0;

  await streamTags(file, async (tag) => {
    if (!tag.startsWith('<Record ')) return;
    const a = attrs(tag);
    if (a.type !== HEART_RATE && a.type !== ACTIVE_ENERGY) return;
    const start = normalizeAppleDate(a.startDate);
    const ts = start ? Date.parse(start) : NaN;
    if (!Number.isFinite(ts)) return;
    const index = findWorkoutAt(workouts, ts);
    if (index < 0) return;
    const value = Number(a.value);
    if (!Number.isFinite(value)) return;
    const s = summaries[index];
    relevantRecords += 1;
    if (a.sourceName) s.sources.add(a.sourceName);
    if (a.device) s.devices.add(a.device);

    if (a.type === HEART_RATE && /count\/min|bpm/i.test(a.unit || 'count/min')) {
      s.hrCount += 1;
      s.hrSum += value;
      s.hrMin = Math.min(s.hrMin, value);
      s.hrMax = Math.max(s.hrMax, value);
    } else if (a.type === ACTIVE_ENERGY && /kcal/i.test(a.unit || 'kcal')) {
      s.energyCount += 1;
      s.energyKcal += value;
    }
    if (onProgress && relevantRecords % 5000 === 0) onProgress(`Matched ${relevantRecords.toLocaleString()} workout records…`);
  });

  return workouts.map((workout, i) => {
    const s = summaries[i];
    const recordHr = s.hrCount ? {
      average_bpm: Math.round((s.hrSum / s.hrCount) * 10) / 10,
      min_bpm: Math.round(s.hrMin * 10) / 10,
      max_bpm: Math.round(s.hrMax * 10) / 10,
      samples: s.hrCount,
    } : null;
    return {
      ...workout,
      heart_rate: workout.workout_heart_rate || recordHr,
      active_energy_kcal: workout.active_energy_kcal ?? (s.energyCount ? Math.round(s.energyKcal * 10) / 10 : null),
      matched_record_sources: [...s.sources],
      matched_record_devices: [...s.devices],
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
    source: {
      type: 'apple_health_export',
      source_name: workout.source_name,
      source_version: workout.source_version,
      device: workout.device,
      matched_record_sources: workout.matched_record_sources,
      matched_record_devices: workout.matched_record_devices,
    },
    metadata: workout.metadata,
  };
}

async function importAppleHealthXml(file, { onProgress } = {}) {
  if (!/\.xml$/i.test(file.name || '') && !/xml/i.test(file.type || '')) {
    throw new Error('Choose Apple Health export.xml or the original Health export ZIP.');
  }
  onProgress?.('Pass 1/2: finding Traditional Strength Training workouts…');
  const workouts = await collectStrengthWorkouts(file, onProgress);
  if (!workouts.length) return [];
  onProgress?.(`Found ${workouts.length} strength workouts. Pass 2/2: matching heart rate and energy records…`);
  const enriched = await enrichWithRecords(file, workouts, onProgress);
  return enriched.map(toWorkoutLog);
}

async function importAppleHealthFile(file, { onProgress } = {}) {
  const name = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  const isZip = name.endsWith('.zip') || type === 'application/zip' || type === 'application/x-zip-compressed';
  let xmlFile = file;
  if (isZip) {
    onProgress?.('Opening Apple Health ZIP and locating export.xml…');
    xmlFile = await openAppleHealthExportZip(file);
    onProgress?.(`Found ${xmlFile.name}. Reading it directly from the ZIP…`);
  }
  return importAppleHealthXml(xmlFile, { onProgress });
}

export { importAppleHealthXml, importAppleHealthFile, TARGET_WORKOUT, normalizeAppleDate };
