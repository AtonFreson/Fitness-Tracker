import { tanitaReviewFields, accuniqFields } from './body-fields.js';
import { dayStamp } from './analytics.js';
import { parseIndicatorReading, indicatorLevels } from './ui-helpers.js';

export const manualFields = [...new Map([
  ...tanitaReviewFields,
  ...accuniqFields,
  ['qualitative.evaluation', 'Evaluation', 'text'],
].filter(([path]) => path !== 'measured_at_local').map((field) => [field[0], field])).values()];

export function fieldParts(path) {
  return path.replace('6.25_khz', '6__25_khz').split('.').map((key) => key === '6__25_khz' ? '6.25_khz' : key);
}

export function fieldValue(log, path) {
  return fieldParts(path).reduce((value, key) => value?.[key], log);
}

function put(log, path, value) {
  const parts = fieldParts(path);
  let target = log;
  for (const key of parts.slice(0, -1)) target = target[key] ||= {};
  target[parts.at(-1)] = value;
}

export function localDateTime(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function buildManualMeasurement(values, { previous = null, draftId = crypto.randomUUID() } = {}) {
  const stamp = String(values.measured_at_local || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(stamp) || !Number.isFinite(dayStamp(stamp))) {
    throw new Error('Enter a valid measurement date and time.');
  }
  const measuredAt = stamp.length === 16 ? `${stamp}:00` : stamp;
  const log = {
    schema_version: 1,
    id: `manual:${measuredAt}:${previous?.id.split(':').at(-1) || draftId}`,
    kind: 'body_composition',
    measured_at_local: measuredAt,
    source: { type: 'manual_entry', device: String(values.device || '').trim() || 'Manual entry' },
    metrics: {},
  };
  const manufacturer = String(values.manufacturer || '').trim();
  if (manufacturer) log.source.manufacturer = manufacturer;
  const notes = String(values.notes || '').trim();
  if (notes) log.notes = notes;
  let supplied = 0;
  for (const [path, label, type] of manualFields) {
    const raw = String(values[path] ?? '').trim();
    if (!raw) continue;
    const value = type === 'number' ? Number(raw.replace(',', '.')) : raw;
    if (type === 'number' && !Number.isFinite(value)) throw new Error(`${label}: enter a finite number.`);
    if (path === 'metrics.weight_kg' && value <= 0) throw new Error('Weight must be above zero.');
    if (['metrics.fat_percent', 'metrics.tbw_percent'].includes(path) && (value < 0 || value > 100)) {
      throw new Error(`${label}: enter a value from 0 to 100.`);
    }
    put(log, path, value);
    if (path.endsWith('.reading')) {
      const parsed = parseIndicatorReading(raw);
      const percent = Number(raw.match(/(\d+)%$/)?.[1]);
      if (!parsed || !indicatorLevels(path).includes(parsed.level) || percent > 100) {
        throw new Error(`${label}: use a level and percentage, for example +: 50%.`);
      }
      const indicator = fieldValue(log, path.slice(0, -8));
      indicator.level = parsed.level;
      indicator.section_percent = percent;
      indicator.source = 'manual_entry';
    }
    supplied++;
  }
  if (!supplied) throw new Error('Enter at least one measurement or report field. Leave anything unavailable blank.');
  for (const [key, range] of Object.entries(log.reference_ranges || {})) {
    if (range.min != null && range.max != null && range.min > range.max) {
      throw new Error(`${key.replaceAll('_', ' ')}: the range minimum must not exceed the maximum.`);
    }
  }
  return log;
}
