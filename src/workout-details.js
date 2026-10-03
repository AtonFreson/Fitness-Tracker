const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
export function quantity(value) {
  const m = String(value ?? '').trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(.*)$/i);
  return m ? { value: Number(m[1]), unit: m[2] } : null;
}
export function energyKcal(value, unit = 'kcal') {
  if (!finite(value)) return null;
  const n = Number(value), u = unit.toLowerCase();
  return n < 0 ? null : u === 'kcal' ? n : u === 'cal' ? n / 1000 : u === 'kj' ? n / 4.184 : u === 'j' ? n / 4184 : null;
}
export function distanceKm(value, unit = 'km') {
  if (!finite(value) || Number(value) < 0) return null;
  const factor = { km: 1, m: .001, cm: .00001, mi: 1.609344, ft: .0003048 }[unit.toLowerCase()];
  return factor === undefined ? null : Number(value) * factor;
}
export function workoutLabel(log) {
  return String(log?.workout_type || 'workout').replace(/^traditional_strength_training$/, 'strength_training').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}
export function reportedHeartRateZones(log) {
  let heartRate=false;
  const zones=[];
  for(const field of log.health_details?.extra_fields || []) {
    if(field.tag==='WorkoutZoneGroup') heartRate=field.type==='HKQuantityTypeIdentifierHeartRate' && /count\/min|bpm/.test(field.unit || '');
    if(field.tag!=='WorkoutZone'||!heartRate)continue;
    const q=quantity(field.duration),unit=String(field.durationUnit || 'min').toLowerCase();
    const minutes=q ? q.value*(unit.startsWith('sec')?1/60:unit.startsWith('hour')?60:1) : null;
    const min=finite(field.minimum)?Number(field.minimum):null,max=finite(field.maximum)?Number(field.maximum):null;
    if(minutes!==null && minutes>=0 && (min!==null||max!==null))zones.push({min,max,minutes});
  }
  return zones;
}
export function validLocation(lat, lon) {
  return finite(lat) && finite(lon) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180;
}
export function metadataLocation(metadata = {}) {
  const entries = Object.entries(metadata);
  const lat = entries.find(([k]) => /^(?:hk)?(?:workout)?(?:location)?latitude$/i.test(k))?.[1];
  const lon = entries.find(([k]) => /^(?:hk)?(?:workout)?(?:location)?longitude$/i.test(k))?.[1];
  if (validLocation(lat, lon)) return { latitude: Number(lat), longitude: Number(lon), origin: 'workout_metadata' };
  for (const [key, value] of entries) {
    if (!/location|coordinate/i.test(key)) continue;
    try {
      const p = JSON.parse(value), a = p.latitude ?? p.lat, b = p.longitude ?? p.lon ?? p.lng;
      if (validLocation(a, b)) return { latitude: Number(a), longitude: Number(b), origin: 'workout_metadata' };
    } catch {}
    const a = String(value).match(/\blat(?:itude)?\s*[:=]\s*([+-]?[\d.]+)/i);
    const b = String(value).match(/\b(?:lon(?:gitude)?|lng)\s*[:=]\s*([+-]?[\d.]+)/i);
    if (a && b && validLocation(a[1], b[1])) return { latitude: Number(a[1]), longitude: Number(b[1]), origin: 'workout_metadata' };
  }
  return null;
}
export function derivedWorkoutFields(workout) {
  const m = workout.metadata || {}, q = key => quantity(m[key]);
  const temp = q('HKWeatherTemperature'), effort = q('HKAverageMETs'), elevation = q('HKElevationAscended');
  const active = workout.active_energy_kcal, basal = workout.basal_energy_kcal;
  const elapsed = (Date.parse(workout.end_at) - Date.parse(workout.start_at)) / 60000;
  const fields = {
    total_energy_kcal: finite(active) && finite(basal) ? active + basal : null,
    elapsed_minutes: elapsed >= 0 ? elapsed : null,
    paused_minutes: elapsed >= 0 && finite(workout.duration_minutes) ? Math.max(0, elapsed - workout.duration_minutes) : null,
    average_mets: effort && effort.value >= 0 ? effort.value : null,
    temperature_c: temp && /^(degC|°C)$/i.test(temp.unit) ? temp.value : temp && /^(degF|°F)$/i.test(temp.unit) ? (temp.value - 32) * 5 / 9 : null,
    elevation_ascended_m: elevation ? (distanceKm(elevation.value, elevation.unit) ?? NaN) * 1000 : null,
    indoor: m.HKIndoorWorkout === '1' ? true : m.HKIndoorWorkout === '0' ? false : null,
    time_zone: m.HKTimeZone || null,
    location: metadataLocation(m),
  };
  const humidity = q('HKWeatherHumidity');
  // Preserve anomalous values verbatim in metadata; do not invent a correction.
  fields.humidity_percent = humidity && humidity.unit === '%' && humidity.value >= 0 && humidity.value <= 100 ? humidity.value : null;
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && !(typeof v === 'number' && !Number.isFinite(v))));
}
export async function parseWorkoutRoute(file) {
  const reader = file.stream().getReader(), decoder = new TextDecoder();
  const points = []; let buffer = '', segment = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), {stream: !done});
      let match;
      while ((match = /<trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/trkpt>)/.exec(buffer))) {
        if (buffer.slice(0,match.index).includes('</trkseg>')) segment++;
        const a = Object.fromEntries([...match[1].matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1],m[2]]));
        const body = match[2] || '', tag = n => body.match(new RegExp('<(?:[\\w]+:)?'+n+'(?:\\s[^>]*)?>([^<]+)<\\/(?:[\\w]+:)?'+n+'>'))?.[1];
        if (validLocation(a.lat,a.lon)) {
          const p = {latitude:Number(a.lat),longitude:Number(a.lon),segment};
          const at=tag('time'); if (Number.isFinite(Date.parse(at))) p.at=at;
          for (const [xml,key] of [['ele','altitude_m'],['speed','speed_m_s'],['course','course_degrees'],['hAcc','horizontal_accuracy_m'],['vAcc','vertical_accuracy_m']]) {
            const v=tag(xml); if(finite(v) && (xml==='ele'||Number(v)>=0)) p[key]=Number(v);
          }
          points.push(p);
          if(points.length>200000)throw new Error('Route exceeds 200,000 points; workout saved without the route.');
        }
        buffer=buffer.slice(match.index+match[0].length);
      }
      if(done)break;
      if(buffer.length>1000000)throw new Error('Route contains an oversized or invalid point.');
    }
  } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  return {points, point_count:points.length};
}
