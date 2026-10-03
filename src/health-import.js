import { openAppleHealthExportZip } from './zip-reader.js?v=4';

import { energyKcal, distanceKm, derivedWorkoutFields, parseWorkoutRoute } from './workout-details.js';

const TARGET_WORKOUT = 'HKWorkoutActivityTypeTraditionalStrengthTraining';
const HEART_RATE = 'HKQuantityTypeIdentifierHeartRate';
const ACTIVE_ENERGY = 'HKQuantityTypeIdentifierActiveEnergyBurned';
const BASAL_ENERGY = 'HKQuantityTypeIdentifierBasalEnergyBurned';

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

async function streamTags(file, onTag, onProgress, phase) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let bytesRead = 0;
  let lastProgress = 0;
  try { while (true) {
    const { value, done } = await reader.read();
    bytesRead += value?.byteLength || 0;
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let end;
    while ((end = buffer.indexOf('>')) >= 0) {
      const chunk = buffer.slice(0, end + 1);
      buffer = buffer.slice(end + 1);
      const start = chunk.lastIndexOf('<');
      if (start >= 0) onTag(chunk.slice(start));
    }
    if (done) break;
    if (buffer.length > 2_000_000) throw new Error('The Health XML contains an invalid or excessively long tag.');
    if (Date.now() - lastProgress >= 250) {
      onProgress?.(`${phase}: ${Math.min(100, Math.round(bytesRead / file.size * 100))}% · ${Math.round(bytesRead / 1e6)} MB read…`);
      lastProgress = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

function workoutFromAttrs(values) {
  const startAt = normalizeAppleDate(values.startDate);
  const endAt = normalizeAppleDate(values.endDate);
  return {
    activity_type: values.workoutActivityType,
    attributes: values,
    metadata: {}, statistics: [], events: [], extra_fields: [], route_files: [],
    start_at: startAt,
    end_at: endAt,
    start_ms: Date.parse(startAt),
    end_ms: Date.parse(endAt),
    duration_minutes: durationMinutes(values.duration, values.durationUnit),
    active_energy_kcal: energyKcal(values.totalEnergyBurned, values.totalEnergyBurnedUnit),
    basal_energy_kcal: null,
    distance_km: distanceKm(values.totalDistance, values.totalDistanceUnit),
    heart_rate_summary: null,
  };
}

async function collectWorkouts(file, onProgress) {
  const workouts = [];
  let current = null;
  let inRoute = false;

  await streamTags(file, (tag) => {
    if (tag.startsWith('<Workout ')) {
      const values = attrs(tag);
      current = workoutFromAttrs(values);
      inRoute = false;
      if (current && tag.endsWith('/>')) {
        workouts.push(current);
        current = null;
      }
      return;
    }

    if (current && /^<WorkoutRoute\b/.test(tag)) {inRoute = true; current.extra_fields.push({tag:'WorkoutRoute',...attrs(tag)}); return;}
    if (tag.startsWith('</WorkoutRoute>')) {inRoute = false; return;}
    if (current && tag.startsWith('<MetadataEntry ')) {
      const v = attrs(tag);
      if (!inRoute) current.metadata[v.key] = v.value;
      else current.extra_fields.push({tag:'Route metadata', ...v});
      return;
    }
    if (current && tag.startsWith('<FileReference ')) {current.route_files.push(attrs(tag).path); return;}
    if (current && tag.startsWith('<WorkoutEvent ')) {current.events.push(attrs(tag)); return;}
    if (current && /^<Workout(Zone|ZoneGroup|Activity)\b/.test(tag)) {
      current.extra_fields.push({tag:tag.match(/^<([\w]+)/)[1], ...attrs(tag)}); return;
    }
    if (current && tag.startsWith('<WorkoutStatistics ')) {
      const values = attrs(tag);
      current.statistics.push(values);
      if (values.type === ACTIVE_ENERGY || values.type === BASAL_ENERGY) {
        const field = values.type === ACTIVE_ENERGY ? "active_energy_kcal" : "basal_energy_kcal";
        current[field] = energyKcal(values.sum, values.unit);
      } else if (/^HKQuantityTypeIdentifierDistance/.test(values.type)) {
        current.distance_km = distanceKm(values.sum, values.unit);
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

    if (current && /^<[A-Za-z]/.test(tag)) current.extra_fields.push({tag:tag.match(/^<([\w:]+)/)[1],...attrs(tag)});

    if (/^<\/Workout\s*>/.test(tag)) {
      if (current) workouts.push(current);
      current = null;
      if (onProgress && workouts.length && workouts.length % 25 === 0) onProgress(`Found ${workouts.length} workouts…`);
    }
  }, onProgress, 'Pass 1/2 · finding workouts');

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
    if (!tag.includes(HEART_RATE) && !tag.includes(ACTIVE_ENERGY)) return;
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
  }, onProgress, 'Pass 2/2 · matching heart rate');

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
  const type = String(workout.activity_type || 'Workout').replace(/^HKWorkoutActivityType/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  const idType = workout.activity_type === TARGET_WORKOUT ? 'strength' : type;
  return {
    schema_version: 1,
    id: `apple-health:${idType}:${workout.start_at}`,
    kind: 'workout', workout_type: type,
    start_at: workout.start_at, end_at: workout.end_at,
    duration_minutes: workout.duration_minutes,
    active_energy_kcal: workout.active_energy_kcal,
    basal_energy_kcal: workout.basal_energy_kcal,
    distance_km: workout.distance_km,
    heart_rate_bpm: workout.heart_rate,
    ...derivedWorkoutFields(workout),
    ...(workout.route ? {route:workout.route} : {}),
    ...(workout.route_warning ? {route_warning:workout.route_warning} : {}),
    health_metadata: workout.metadata,
    workout_events: workout.events.map(e=>({...e,at:normalizeAppleDate(e.date)})),
    workout_statistics: workout.statistics,
    health_details: {attributes: workout.attributes, extra_fields: workout.extra_fields, route_files: workout.route_files},
    source: {type:'apple_health_export', ...(workout.attributes.sourceName ? {app:workout.attributes.sourceName} : {})},
  };
}

async function importAppleHealthXml(file, { onProgress } = {}) {
  if (!/\.xml$/i.test(file.name || '') && !/xml/i.test(file.type || '')) {
    throw new Error('Choose Apple Health export.xml or an Apple Health export ZIP.');
  }
  onProgress?.('Pass 1/2: finding workouts…');
  const workouts = await collectWorkouts(file, onProgress);
  if (!workouts.length) return [];
  onProgress?.(`Found ${workouts.length} workouts. Pass 2/2: matching heart-rate and energy records…`);
  const enriched = await enrichWithRecords(file, workouts, onProgress);
  for (const w of enriched) {
    for (const path of w.route_files) {
      try {
        const routeFile = await file.openFile?.(path);
        if (!routeFile) {w.route_warning = 'The linked route file is missing. Import the complete Health ZIP to include it.'; continue;}
        onProgress?.('Reading workout route…');
        const route = await parseWorkoutRoute(routeFile);
        w.route ||= {points:[],point_count:0};
        const offset = (w.route.points.at(-1)?.segment ?? -1)+1;
        w.route.points=w.route.points.concat(route.points.map(p=>({...p,segment:p.segment+offset})));
        w.route.point_count=w.route.points.length;
      } catch(error) {w.route_warning=error.message;}
    }
  }
  return enriched.map(toWorkoutLog);
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
