function decimalStep(value, direction, step = 0.1) {
  const current = Number(value);
  const base = Number.isFinite(current) ? current : 0;
  const places = Math.max(0, String(step).split('.')[1]?.length || 0);
  const scale = 10 ** places;
  return Math.round((base + Number(direction || 0) * step) * scale) / scale;
}

function indicatorLevels(path = '') {
  return /indicators\.(?:fat_percent|bmi)\.reading$/.test(path) ? ['-', '0', '+', '++'] : ['-', '0', '+'];
}

function parseIndicatorReading(value) {
  const match = String(value || '').trim().match(/^(\+\+|\+|0|-)\s*:\s*(\d{1,3})%$/);
  if (!match) return null;
  return { level: match[1], percent: Math.max(0, Math.min(95, Math.floor(Number(match[2]) / 5) * 5)) };
}

function stepIndicatorReading(value, direction, path = '') {
  const levels = indicatorLevels(path);
  const parsed = parseIndicatorReading(value) || { level: levels[0], percent: 0 };
  let levelIndex = Math.max(0, levels.indexOf(parsed.level));
  let percent = parsed.percent;
  if (direction > 0) {
    if (percent >= 95) { if (levelIndex < levels.length - 1) levelIndex += 1; percent = 0; }
    else percent += 5;
  } else if (direction < 0) {
    if (percent <= 0) { if (levelIndex > 0) { levelIndex -= 1; percent = 95; } }
    else percent -= 5;
  }
  return `${levels[levelIndex]}: ${percent}%`;
}

function isPlainObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }

function recordEntries(value, prefix = '') {
  const entries = [];
  if (!isPlainObject(value)) return entries;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(child)) entries.push({ path, kind: 'json', value: JSON.stringify(child, null, 2) });
    else if (isPlainObject(child)) entries.push(...recordEntries(child, path));
    else if (typeof child === 'number') entries.push({ path, kind: 'number', value: child });
    else if (typeof child === 'boolean') entries.push({ path, kind: 'boolean', value: child });
    else entries.push({ path, kind: 'text', value: child ?? '' });
  }
  return entries;
}

function coerceRecordValue(raw, kind) {
  if (kind === 'number') {
    if (String(raw).trim() === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Invalid number: ${raw}`);
    return value;
  }
  if (kind === 'boolean') return String(raw) === 'true';
  if (kind === 'json') return JSON.parse(String(raw || '[]'));
  return String(raw);
}

export { decimalStep, indicatorLevels, parseIndicatorReading, stepIndicatorReading, recordEntries, coerceRecordValue };
