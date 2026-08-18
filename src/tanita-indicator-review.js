function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function median(values) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }

function readingForPosition(name, position, boundaries = null) {
  const levels = (name === 'fat_percent' || name === 'bmi') ? ['-', '0', '+', '++'] : ['-', '0', '+'];
  const clamped = clamp(Number(position) || 0, 0, 0.999999);
  let bounds = boundaries;
  if (!Array.isArray(bounds) || bounds.length !== levels.length + 1) bounds = Array.from({ length: levels.length + 1 }, (_, i) => i / levels.length);
  let section = levels.length - 1;
  for (let i = 0; i < levels.length; i += 1) if (clamped < bounds[i + 1]) { section = i; break; }
  const width = Math.max(0.000001, bounds[section + 1] - bounds[section]);
  const sectionPercent = clamp(Math.round((((clamped - bounds[section]) / width) * 100) / 5) * 5, 0, 95);
  return { level: levels[section], section_percent: sectionPercent, reading: `${levels[section]}: ${sectionPercent}%` };
}

function parseReading(value) {
  const match = String(value || '').trim().match(/^(\+\+|\+|0|-)\s*:\s*(\d{1,3})%$/);
  if (!match) return null;
  const percent = clamp(Math.round(Number(match[2]) / 5) * 5, 0, 95);
  return { level: match[1], section_percent: percent, reading: `${match[1]}: ${percent}%` };
}

function preserveReviewedIndicators(log, storedLog) {
  if (!log || !storedLog?.indicators) return log;

  const storedEntries = ['fat_percent', 'bmi', 'muscle_mass', 'bmr']
    .map((name) => ({ name, indicator: storedLog.indicators?.[name] }))
    .filter(({ indicator }) => parseReading(indicator?.reading));

  const recordWasReviewed = storedEntries.some(({ name, indicator }) => {
    if (indicator?.source === 'manual_review') return true;
    if (indicator?.source !== 'indicator_graph') return false;
    const position = Number(indicator?.position);
    if (!Number.isFinite(position)) return false;
    return readingForPosition(name, position).reading !== parseReading(indicator.reading).reading;
  });
  if (!recordWasReviewed) return log;

  const next = JSON.parse(JSON.stringify(log));
  next.indicators = { ...(next.indicators || {}) };
  for (const { name, indicator } of storedEntries) {
    const parsed = parseReading(indicator.reading);
    next.indicators[name] = { ...(next.indicators[name] || {}), ...parsed, source: 'manual_review' };
    delete next.indicators[name].position;
    delete next.indicators[name].confidence;
    delete next.indicators[name].locator;
  }
  return next;
}

function resizeCanvas(source, targetWidth = 720) {
  if (!source?.width || source.width <= targetWidth) return source;
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth; canvas.height = Math.round(source.height * targetWidth / source.width);
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, canvas.width, canvas.height); return canvas;
}
function percentile(histogram, total, fraction) { const target = total * fraction; let seen = 0; for (let i = 0; i < histogram.length; i += 1) { seen += histogram[i]; if (seen >= target) return i; } return 255; }
function runsWithGaps(dark, maxGap = 3, minLength = 4) {
  const runs = []; let start = null; let previous = null;
  for (let x = 0; x < dark.length; x += 1) { if (!dark[x]) continue; if (start == null) { start = previous = x; continue; } if (x - previous <= maxGap + 1) { previous = x; continue; } if (previous - start + 1 >= minLength) runs.push([start, previous]); start = previous = x; }
  if (start != null && previous - start + 1 >= minLength) runs.push([start, previous]); return runs;
}
function clusterSamples(samples) {
  const clusters = [];
  for (const sample of samples) { let best = null; for (const cluster of clusters) if (Math.abs(sample.fillEnd - median(cluster.map((item) => item.fillEnd))) <= 10) { best = cluster; break; } if (best) best.push(sample); else clusters.push([sample]); }
  return clusters.sort((a, b) => median(b.map((item) => item.fillEnd - item.left)) * b.length - median(a.map((item) => item.fillEnd - item.left)) * a.length);
}
function imageModel(sourceCanvas) {
  const canvas = resizeCanvas(sourceCanvas); if (!canvas?.width || !canvas?.height || canvas.width < 250 || canvas.height < 700) return null;
  const { width, height } = canvas; const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data; const gray = new Uint8Array(width * height); const histogram = new Uint32Array(256);
  for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) { const value = Math.round(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]); gray[p] = value; histogram[value] += 1; }
  const low = percentile(histogram, gray.length, 0.01); const high = Math.max(low + 10, percentile(histogram, gray.length, 0.985)); const stretch = (value) => clamp(((value - low) * 255) / (high - low), 0, 255);
  const x0 = Math.floor(width * 0.03), x1 = Math.ceil(width * 0.97), y0 = Math.floor(height * 0.48), y1 = Math.ceil(height * 0.72); const qualifying = [];
  for (let y = y0; y < y1; y += 1) { let darkCount = 0; for (let x = x0; x < x1; x += 1) if (stretch(gray[y * width + x]) < 115) darkCount += 1; qualifying.push(darkCount / (x1 - x0) > 0.64); }
  const bands = []; let start = null;
  for (let i = 0; i < qualifying.length; i += 1) { if (qualifying[i] && start == null) start = y0 + i; if (start != null && (!qualifying[i] || i === qualifying.length - 1)) { const end = qualifying[i] && i === qualifying.length - 1 ? y0 + i : y0 + i - 1; if (end - start + 1 >= Math.max(6, Math.round(width * 0.008))) bands.push([start, end]); start = null; } }
  const headerBottom = bands.at(-1)?.[1] ?? null; if (headerBottom == null) return null; return { canvas, width, height, gray, stretch, headerBottom };
}
const LAYOUT_INDEX = { fat_percent: 0, bmi: 1, muscle_mass: 3, bmr: 4 };
function analyzeIndicator(model, name) {
  const { width, height, gray, stretch, headerBottom } = model; const index = LAYOUT_INDEX[name]; if (index == null) return null;
  const nominal = headerBottom + (0.062 + 0.225 * index) * width; const scanTop = Math.max(0, Math.floor(nominal - 0.03 * width)); const scanBottom = Math.min(height, Math.ceil(nominal + 0.06 * width)); const samples = [];
  for (let y = scanTop; y < scanBottom; y += 1) { const dark = new Uint8Array(width); for (let x = 0; x < width; x += 1) dark[x] = stretch(gray[y * width + x]) < 150 ? 1 : 0; const runs = runsWithGaps(dark); const leftRuns = runs.filter(([start, end]) => start < width * 0.16 && end - start > width * 0.12); const rightRuns = runs.filter(([start]) => start > width * 0.75); if (!leftRuns.length || !rightRuns.length) continue; const fill = leftRuns.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0]; const right = rightRuns.sort((a, b) => b[1] - a[1])[0]; if (fill[1] >= right[0] - 8) continue; samples.push({ y, left: fill[0], fillEnd: fill[1], right: right[1] }); }
  const cluster = clusterSamples(samples)[0]; if (!cluster?.length) return null; const left = Math.round(median(cluster.map((sample) => sample.left))); const fillEnd = Math.round(median(cluster.map((sample) => sample.fillEnd))); const right = Math.round(median(cluster.map((sample) => sample.right))); const maxY = Math.max(...cluster.map((sample) => sample.y)); if (!(right > left && fillEnd > left && fillEnd < right)) return null;
  const segmentCount = name === 'fat_percent' || name === 'bmi' ? 4 : 3; const span = right - left; const tickTop = Math.min(height - 1, maxY + 3); const tickBottom = Math.min(height, maxY + Math.round(0.08 * width)); const counts = new Uint16Array(width);
  for (let y = tickTop; y < tickBottom; y += 1) for (let x = left; x <= right; x += 1) if (stretch(gray[y * width + x]) < 145) counts[x] += 1;
  const ticks = []; for (let section = 1; section < segmentCount; section += 1) { const expected = left + span * section / segmentCount; const radius = span * 0.055; const from = Math.max(left + 5, Math.floor(expected - radius)); const to = Math.min(right - 5, Math.ceil(expected + radius)); let bestX = Math.round(expected), bestCount = -1; for (let x = from; x <= to; x += 1) if (counts[x] > bestCount) { bestCount = counts[x]; bestX = x; } ticks.push(bestX); }
  const pixelBounds = [left, ...ticks, right]; const normalizedBounds = pixelBounds.map((x) => (x - left) / span); const position = (fillEnd - left) / span; const reading = readingForPosition(name, position, normalizedBounds); const confidence = clamp(0.62 + Math.min(0.25, cluster.length * 0.018), 0, 0.95);
  return { ...reading, position: Math.round(position * 1000) / 1000, confidence: Math.round(confidence * 100) / 100, source: 'indicator_graph_refined', locator: 'bar_geometry', crop: { top: clamp((scanTop - 0.035 * width) / height, 0, 1), bottom: clamp((tickBottom + 0.03 * width) / height, 0, 1) } };
}
function refineTanitaIndicators(sourceCanvas, log) {
  const model = imageModel(sourceCanvas); if (!model) return { log, regions: {} }; const next = JSON.parse(JSON.stringify(log)); next.indicators = { ...(next.indicators || {}) }; const regions = {};
  for (const name of Object.keys(LAYOUT_INDEX)) { const refined = analyzeIndicator(model, name); if (!refined) continue; regions[name] = refined.crop; const existing = next.indicators?.[name]; if (existing?.source === 'manual_review') continue; const { crop, ...stored } = refined; next.indicators[name] = stored; }
  return { log: next, regions };
}
function cropIndicatorCanvas(sourceCanvas, region) {
  if (!sourceCanvas?.width || !region) return null; const top = Math.floor(sourceCanvas.height * region.top); const bottom = Math.ceil(sourceCanvas.height * region.bottom); const canvas = document.createElement('canvas'); canvas.width = sourceCanvas.width; canvas.height = Math.max(1, bottom - top); canvas.getContext('2d').drawImage(sourceCanvas, 0, top, sourceCanvas.width, canvas.height, 0, 0, sourceCanvas.width, canvas.height); return canvas;
}
export { readingForPosition, preserveReviewedIndicators, refineTanitaIndicators, cropIndicatorCanvas };
