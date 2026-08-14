import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.mjs';
import { CONFIG } from '../config.js';
import { parseTanitaText, toBodyCompositionLog, mergeTanitaParses } from './tanita-parser.js';
import { parseAccuniqText, toAccuniqBodyCompositionLog } from './accuniq-parser.js';
import { detectBodyCompositionSource, labelForSource } from './source-detection.js';

const EXTRACTOR_BUILD = 'vision-spatial-v6-fallback-isolated';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.worker.min.mjs';

function setStatus(onStatus, message) {
  onStatus?.(message);
}

async function readPdf(file) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  if (!pdf.numPages) throw new Error('The PDF has no pages.');
  const page = await pdf.getPage(1);

  const reader = page.streamTextContent().getReader();
  const textItems = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.items?.length) textItems.push(...value.items);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(1.5, Math.min(3, 1500 / base.width, 6500 / base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport }).promise;

  return {
    embeddedText: textItems.map((item) => item.str).join('\n').trim(),
    canvas,
  };
}

async function readImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1500 / bitmap.width, 6500 / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { embeddedText: '', canvas };
}

function resizeCanvas(source, targetWidth = 720) {
  if (source.width <= targetWidth) return source;
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = Math.round(source.height * targetWidth / source.width);
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function cropCanvas(source, y0, y1) {
  const top = Math.max(0, Math.floor(source.height * y0));
  const bottom = Math.min(source.height, Math.ceil(source.height * y1));
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = Math.max(1, bottom - top);
  canvas.getContext('2d').drawImage(source, 0, top, source.width, canvas.height, 0, 0, source.width, canvas.height);
  return canvas;
}

function percentileFromHistogram(histogram, total, fraction) {
  const target = total * fraction;
  let seen = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    seen += histogram[i];
    if (seen >= target) return i;
  }
  return 255;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function dominantCluster(values, tolerance = 0.014) {
  if (values.length < 3) return null;
  let best = [];
  for (const center of values) {
    const cluster = values.filter((value) => Math.abs(value - center) <= tolerance);
    if (cluster.length > best.length) best = cluster;
  }
  if (best.length < 3 || best.length / values.length < 0.25) return null;
  return { position: median(best), clusterSize: best.length, sampleSize: values.length };
}

function indicatorBand(name, position) {
  const bands = (name === 'fat_percent' || name === 'bmi')
    ? [['-', 0, 0.25], ['0', 0.25, 0.5], ['+', 0.5, 0.75], ['++', 0.75, 1]]
    : [['-', 0, 1 / 3], ['0', 1 / 3, 2 / 3], ['+', 2 / 3, 1]];
  const clamped = Math.max(0, Math.min(0.999999, position));
  const [level, start, end] = bands.find(([, a, b]) => clamped >= a && clamped < b) || bands.at(-1);
  const sectionPercent = Math.max(0, Math.min(100, Math.round((((clamped - start) / (end - start)) * 100) / 5) * 5));
  return { level, section_percent: sectionPercent, reading: `${level}: ${sectionPercent}%` };
}

function scanIndicatorBar({ gray, stretch, width, height, scanTop, scanBottom, barLeft, barRight }) {
  const barWidth = barRight - barLeft;
  const positions = [];
  for (let y = Math.max(0, Math.floor(scanTop)); y < Math.min(height, Math.ceil(scanBottom)); y += 1) {
    const dark = new Uint8Array(barWidth);
    for (let x = 0; x < barWidth; x += 1) dark[x] = stretch(gray[y * width + barLeft + x]) < 145 ? 1 : 0;

    const prefix = new Uint16Array(barWidth + 1);
    for (let x = 0; x < barWidth; x += 1) prefix[x + 1] = prefix[x] + dark[x];
    const active = new Uint8Array(barWidth);
    for (let x = 0; x < barWidth; x += 1) {
      const left = Math.max(0, x - 4);
      const right = Math.min(barWidth - 1, x + 4);
      active[x] = (prefix[right + 1] - prefix[left]) / (right - left + 1) > 0.52 ? 1 : 0;
    }

    const runs = [];
    let start = null;
    for (let x = 0; x < barWidth; x += 1) {
      if (active[x] && start == null) start = x;
      if (start != null && (!active[x] || x === barWidth - 1)) {
        const end = active[x] && x === barWidth - 1 ? x : x - 1;
        if (end - start >= 4) runs.push([start, end]);
        start = null;
      }
    }

    const leftRuns = runs.filter(([x]) => x < width * 0.12);
    if (!leftRuns.length) continue;
    let [fillStart, fillEnd] = leftRuns[0];
    for (const [nextStart, nextEnd] of runs) {
      if (nextStart > fillEnd && nextStart - fillEnd <= 12) fillEnd = nextEnd;
    }
    const position = fillEnd / barWidth;
    if (fillStart < width * 0.12 && position > 0.05 && position < 0.98) positions.push(position);
  }
  return dominantCluster(positions);
}

function analyzeTanitaIndicators(sourceCanvas, labelAnchors = null) {
  if (!sourceCanvas?.width || !sourceCanvas?.height) return null;
  const canvas = resizeCanvas(sourceCanvas);
  const { width, height } = canvas;
  if (width < 250 || height < 700) return null;

  const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
    const value = Math.round(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]);
    gray[p] = value;
    histogram[value] += 1;
  }
  const low = percentileFromHistogram(histogram, gray.length, 0.01);
  const high = Math.max(low + 10, percentileFromHistogram(histogram, gray.length, 0.985));
  const stretch = (value) => Math.max(0, Math.min(255, ((value - low) * 255) / (high - low)));

  const x0 = Math.floor(width * 0.03);
  const x1 = Math.ceil(width * 0.97);
  const y0 = Math.floor(height * 0.48);
  const y1 = Math.ceil(height * 0.72);
  const qualifying = [];
  for (let y = y0; y < y1; y += 1) {
    let dark = 0;
    for (let x = x0; x < x1; x += 1) if (stretch(gray[y * width + x]) < 115) dark += 1;
    qualifying.push(dark / (x1 - x0) > 0.64);
  }

  const headerBands = [];
  let bandStart = null;
  for (let i = 0; i < qualifying.length; i += 1) {
    if (qualifying[i] && bandStart == null) bandStart = y0 + i;
    if (bandStart != null && (!qualifying[i] || i === qualifying.length - 1)) {
      const end = qualifying[i] && i === qualifying.length - 1 ? y0 + i : y0 + i - 1;
      if (end - bandStart + 1 >= Math.max(6, Math.round(width * 0.008))) headerBands.push([bandStart, end]);
      bandStart = null;
    }
  }

  const headerBottom = headerBands.at(-1)?.[1] ?? null;
  const layoutNames = ['fat_percent', 'bmi', null, 'muscle_mass', 'bmr'];
  const barLeft = Math.floor(width * 0.025);
  const barRight = Math.ceil(width * 0.965);
  const output = {};

  for (let index = 0; index < layoutNames.length; index += 1) {
    const name = layoutNames[index];
    if (!name) continue;
    const candidates = [];
    const anchor = labelAnchors?.[name];

    if (anchor?.bottom_ratio != null) {
      const labelBottom = anchor.bottom_ratio * height;
      const nextTop = anchor.next_top_ratio != null ? anchor.next_top_ratio * height : null;
      let scanBottom = labelBottom + 0.07 * width;
      if (nextTop != null && nextTop > labelBottom) scanBottom = Math.min(scanBottom, labelBottom + (nextTop - labelBottom) * 0.38);
      const cluster = scanIndicatorBar({
        gray, stretch, width, height,
        scanTop: labelBottom + 0.002 * width,
        scanBottom,
        barLeft,
        barRight,
      });
      if (cluster) candidates.push({ cluster, locator: 'vision_label' });
    }

    if (headerBottom != null) {
      const nominal = headerBottom + (0.062 + 0.225 * index) * width;
      const cluster = scanIndicatorBar({
        gray, stretch, width, height,
        scanTop: nominal - 0.018 * width,
        scanBottom: nominal + 0.055 * width,
        barLeft,
        barRight,
      });
      if (cluster) candidates.push({ cluster, locator: 'layout' });
    }

    if (!candidates.length) continue;
    candidates.sort((a, b) => {
      if (a.locator !== b.locator) {
        if (a.locator === 'vision_label' && a.cluster.clusterSize >= 3) return -1;
        if (b.locator === 'vision_label' && b.cluster.clusterSize >= 3) return 1;
      }
      return b.cluster.clusterSize / b.cluster.sampleSize - a.cluster.clusterSize / a.cluster.sampleSize;
    });

    const { cluster, locator } = candidates[0];
    const band = indicatorBand(name, cluster.position);
    output[name] = {
      ...band,
      position: Math.round(cluster.position * 1000) / 1000,
      confidence: Math.round(Math.min(0.99, 0.45 + 0.42 * (cluster.clusterSize / cluster.sampleSize) + 0.02 * Math.min(cluster.clusterSize, 6)) * 100) / 100,
      source: 'indicator_graph',
      locator,
    };
  }
  return Object.keys(output).length ? output : null;
}

function attachTanitaIndicators(parsed, canvas, labelAnchors = null) {
  const detected = analyzeTanitaIndicators(canvas, labelAnchors) || {};
  parsed.indicators = { ...(parsed.indicators || {}), ...detected };
  const fields = new Set(parsed.extraction?.review_fields || ['measured_at_local']);
  for (const key of ['fat_percent', 'bmi', 'muscle_mass', 'bmr']) fields.add(`indicators.${key}.reading`);

  const warnings = [...(parsed.extraction?.warnings || [])];
  const fat = parsed.metrics?.fat_percent;
  const range = parsed.reference_ranges?.fat_percent;
  const level = detected.fat_percent?.level;
  if (fat != null && range?.min != null && range?.max != null && level) {
    if ((fat >= range.min && fat <= range.max) !== (level === '0')) {
      warnings.push('Fat % and the printed FAT % indicator disagree; review the value.');
    }
  }

  parsed.extraction = {
    ...parsed.extraction,
    warnings: [...new Set(warnings)],
    review_fields: [...fields],
  };
  return parsed;
}

function canvasBase64Jpeg(canvas) {
  return canvas.toDataURL('image/jpeg', 0.9).split(',', 2)[1];
}

function visionVertexNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function visionWords(response) {
  const words = [];
  for (const page of response?.fullTextAnnotation?.pages || []) {
    const pageWidth = Math.max(1, Number(page.width) || 1);
    const pageHeight = Math.max(1, Number(page.height) || 1);
    for (const block of page.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const word of paragraph.words || []) {
          const text = (word.symbols || []).map((symbol) => symbol.text || '').join('').trim();
          if (!text) continue;
          const rawVertices = word.boundingBox?.vertices?.length
            ? word.boundingBox.vertices
            : (word.boundingBox?.normalizedVertices || []).map((vertex) => ({ x: vertex.x * pageWidth, y: vertex.y * pageHeight }));
          const xs = rawVertices.map((vertex) => visionVertexNumber(vertex.x));
          const ys = rawVertices.map((vertex) => visionVertexNumber(vertex.y));
          if (!xs.length || !ys.length) continue;
          const left = Math.min(...xs);
          const right = Math.max(...xs);
          const top = Math.min(...ys);
          const bottom = Math.max(...ys);
          words.push({ text, left, right, top, bottom, height: Math.max(1, bottom - top), centerY: (top + bottom) / 2 });
        }
      }
    }
  }

  if (words.length) return words;
  for (const annotation of (response?.textAnnotations || []).slice(1)) {
    const vertices = annotation?.boundingPoly?.vertices || [];
    const text = String(annotation?.description || '').trim();
    if (!text || !vertices.length) continue;
    const xs = vertices.map((vertex) => visionVertexNumber(vertex.x));
    const ys = vertices.map((vertex) => visionVertexNumber(vertex.y));
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    words.push({ text, left, right, top, bottom, height: Math.max(1, bottom - top), centerY: (top + bottom) / 2 });
  }
  return words;
}

function spatialText(response) {
  const words = visionWords(response);
  if (!words.length) return { text: '', lines: [], wordCount: 0 };
  const typicalHeight = median(words.map((word) => word.height)) || 12;
  const rows = [];

  for (const word of [...words].sort((a, b) => a.centerY - b.centerY || a.left - b.left)) {
    let best = null;
    let bestScore = Infinity;
    for (const row of rows) {
      const gap = Math.abs(word.centerY - row.centerY);
      const overlap = Math.max(0, Math.min(word.bottom, row.bottom) - Math.max(word.top, row.top));
      const overlapRatio = overlap / Math.max(1, Math.min(word.height, row.height));
      const tolerance = Math.max(4, typicalHeight * 0.85, Math.min(word.height, row.height) * 0.7);
      if (gap <= tolerance || overlapRatio >= 0.35) {
        const score = gap - overlapRatio * typicalHeight * 0.4;
        if (score < bestScore) { best = row; bestScore = score; }
      }
    }
    if (!best) {
      rows.push({ words: [word], top: word.top, bottom: word.bottom, height: word.height, centerY: word.centerY });
    } else {
      best.words.push(word);
      best.top = Math.min(best.top, word.top);
      best.bottom = Math.max(best.bottom, word.bottom);
      best.height = Math.max(1, best.bottom - best.top);
      best.centerY = best.words.reduce((sum, item) => sum + item.centerY, 0) / best.words.length;
    }
  }

  const lines = rows
    .sort((a, b) => a.centerY - b.centerY)
    .map((row) => {
      row.words.sort((a, b) => a.left - b.left);
      return {
        text: row.words.map((word) => word.text).join(' '),
        top: row.top,
        bottom: row.bottom,
        left: Math.min(...row.words.map((word) => word.left)),
        right: Math.max(...row.words.map((word) => word.right)),
      };
    })
    .filter((line) => line.text);
  return { text: lines.map((line) => line.text).join('\n'), lines, wordCount: words.length };
}

function indicatorAnchors(response, imageHeight) {
  const lines = spatialText(response).lines;
  const start = lines.findIndex((line) => /\bINDICATOR\b/i.test(line.text));
  if (start < 0) return null;
  const specs = [
    ['fat_percent', /(?:^|\s)FAT\s*%/i],
    ['bmi', /(?:^|\s)BMI(?:\s|$)/i],
    ['visceral_fat', /VISCERAL\s+FAT\s+RATING/i],
    ['muscle_mass', /MUSCLE\s+MASS/i],
    ['bmr', /(?:^|\s)BMR(?:\s|$)/i],
    ['physique', /PHYSIQUE\s+RATING/i],
  ];

  const found = [];
  let cursor = start + 1;
  for (const [name, pattern] of specs) {
    const index = lines.findIndex((line, i) => i >= cursor && pattern.test(line.text));
    if (index < 0) continue;
    found.push({ name, ...lines[index] });
    cursor = index + 1;
  }

  const anchors = {};
  const height = Math.max(1, imageHeight);
  for (let i = 0; i < found.length; i += 1) {
    if (!['fat_percent', 'bmi', 'muscle_mass', 'bmr'].includes(found[i].name)) continue;
    anchors[found[i].name] = {
      bottom_ratio: found[i].bottom / height,
      next_top_ratio: found[i + 1] ? found[i + 1].top / height : null,
    };
  }
  return Object.keys(anchors).length ? anchors : null;
}

function redact(value) {
  return String(value ?? '')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-api-key]')
    .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
}

function visionError(payload) {
  const error = payload?.error;
  return {
    status: error?.status || '',
    message: redact(error?.message || ''),
    code: error?.code ?? null,
  };
}

async function runVision(canvas, { onStatus, fileName = '' } = {}) {
  const apiKey = String(CONFIG.googleVisionApiKey || '').trim();
  if (!apiKey) throw new Error('Google Cloud Vision is not configured. Add googleVisionApiKey in config.js.');

  const images = [
    ['FULL', canvas],
    ['INPUT', cropCanvas(canvas, 0.00, 0.30)],
    ['RESULT', cropCanvas(canvas, 0.22, 0.56)],
    ['RANGE', cropCanvas(canvas, 0.48, 0.70)],
    ['BOTTOM', cropCanvas(canvas, 0.78, 1.00)],
  ];
  setStatus(onStatus, 'Reading report with Google Cloud Vision…');

  const started = performance.now();
  let response;
  try {
    response = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify({
        requests: images.map(([, image]) => ({
          image: { content: canvasBase64Jpeg(image) },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION', model: 'builtin/latest' }],
          imageContext: { languageHints: ['en'] },
        })),
      }),
    });
  } catch (error) {
    throw new Error(`Google Cloud Vision request failed: ${redact(error.message || error)}`);
  }

  const raw = await response.text();
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch {}
  if (!response.ok) {
    const info = visionError(payload);
    throw new Error(`Google Cloud Vision failed (${response.status}${info.status ? ` ${info.status}` : ''}): ${info.message || 'request rejected'}`);
  }

  const responses = payload?.responses || [];
  const candidates = [];
  const diagnostics = [
    '--- EXTRACTION DIAGNOSTICS ---',
    `Extractor build: ${EXTRACTOR_BUILD}`,
    'Cloud Vision configured: yes',
    'Cloud Vision request attempted: yes',
    `HTTP result: ${response.status}`,
    `Request elapsed: ${Math.round(performance.now() - started)} ms`,
  ];

  for (let i = 0; i < images.length; i += 1) {
    const item = responses[i];
    const name = images[i][0];
    if (item?.error?.message) {
      diagnostics.push(`${name}: error - ${redact(item.error.message)}`);
      continue;
    }
    const spatial = spatialText(item);
    const native = String(item?.fullTextAnnotation?.text || item?.textAnnotations?.[0]?.description || '').trim();
    const text = spatial.text || native;
    diagnostics.push(`${name}: ${spatial.wordCount} words, ${spatial.lines.length} visual rows${text ? '' : ', no text'}`);
    if (text) candidates.push({ name, text, native, response: item });
  }
  diagnostics.push('--- END EXTRACTION DIAGNOSTICS ---');

  if (!candidates.length) throw new Error('Google Cloud Vision returned no readable text.');

  const full = candidates.find((candidate) => candidate.name === 'FULL') || candidates[0];
  const source = detectBodyCompositionSource(`${full.text}\n${full.native}`, fileName);
  const anchors = source === 'tanita' ? indicatorAnchors(full.response, canvas.height) : null;
  const displayText = candidates.map((candidate) => `--- GOOGLE VISION ${candidate.name} (SPATIAL) ---\n${candidate.text}`).join('\n');

  return {
    source,
    candidates,
    anchors,
    diagnostic: diagnostics.join('\n'),
    displayText,
  };
}

function parseEmbedded(text, fileName) {
  const source = detectBodyCompositionSource(text, fileName);
  if (source === 'tanita') return { source, parsed: parseTanitaText(text, { sourceName: fileName }) };
  if (source === 'accuniq') return { source, parsed: parseAccuniqText(text, { sourceName: fileName }) };
  return { source: 'unknown', parsed: null };
}

function bodyLog(source, parsed, fileName, method) {
  if (source === 'tanita') return toBodyCompositionLog(parsed, { sourceName: fileName, method });
  if (source === 'accuniq') return toAccuniqBodyCompositionLog(parsed, { sourceName: fileName, method });
  throw new Error('Unsupported body-composition source.');
}

function completeness(parsed) {
  return parsed?.extraction?.completeness || 0;
}

function diagnosticIndicatorLines(parsed) {
  return [['fat_percent', 'Fat %'], ['bmi', 'BMI'], ['muscle_mass', 'Muscle mass'], ['bmr', 'BMR']]
    .map(([key, label]) => {
      const value = parsed?.indicators?.[key];
      return value?.reading
        ? `Indicator ${label}: ${value.reading}; position=${value.position}; confidence=${value.confidence}; locator=${value.locator}`
        : `Indicator ${label}: not detected`;
    });
}

function parseVisionResult(vision, canvas, fileName) {
  let source = vision.source;
  if (source === 'unknown') {
    source = /TANITA|DC[-_ ]?360/i.test(fileName || '') ? 'tanita' : /ACCUNIQ/i.test(fileName || '') ? 'accuniq' : 'unknown';
  }
  if (source === 'unknown') return { source, parsed: null };

  if (source === 'tanita') {
    const parses = vision.candidates.map((candidate) => parseTanitaText(candidate.text, { sourceName: fileName }));
    return { source, parsed: attachTanitaIndicators(mergeTanitaParses(parses), canvas, vision.anchors) };
  }

  const candidates = vision.candidates
    .map((candidate) => parseAccuniqText(candidate.text, { sourceName: fileName }))
    .sort((a, b) => completeness(b) - completeness(a));
  return { source, parsed: candidates[0] || null };
}

function visionGoodEnough(source, parsed) {
  const minimum = source === 'tanita' ? 0.75 : 0.65;
  return completeness(parsed) >= minimum;
}

function cloudFailureDiagnostics(error, configured) {
  return [
    '--- EXTRACTION DIAGNOSTICS ---',
    `Extractor build: ${EXTRACTOR_BUILD}`,
    `Cloud Vision configured: ${configured ? 'yes' : 'no'}`,
    `Cloud Vision outcome: ${configured ? 'failed' : 'not configured'}`,
    `Cloud Vision detail: ${redact(error?.message || error || 'unavailable')}`,
    '--- END EXTRACTION DIAGNOSTICS ---',
  ].join('\n');
}

async function runQuarantinedFallback(canvas, { onStatus, fileName, reason }) {
  const module = await import('./fallback/local-ocr.js?v=1');
  return module.runLocalOcrFallback(canvas, { onStatus, fileName, reason });
}

async function readBodyCompositionReport(file, { onStatus } = {}) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  setStatus(onStatus, isPdf ? 'Opening PDF…' : 'Opening image…');
  const { embeddedText, canvas } = isPdf ? await readPdf(file) : await readImage(file);

  const embedded = parseEmbedded(embeddedText, file.name);
  const embeddedUsable = embeddedText.length > 40 && (
    (embedded.source === 'accuniq' && completeness(embedded.parsed) >= 0.75)
    || (embedded.source === 'tanita' && completeness(embedded.parsed) >= 0.9)
  );

  if (embeddedUsable) {
    const parsed = embedded.source === 'tanita' ? attachTanitaIndicators(embedded.parsed, canvas) : embedded.parsed;
    const diagnostics = [
      '--- EXTRACTION DIAGNOSTICS ---',
      `Extractor build: ${EXTRACTOR_BUILD}`,
      'Cloud Vision request attempted: no (embedded PDF text was sufficient)',
      ...(embedded.source === 'tanita' ? diagnosticIndicatorLines(parsed) : []),
      '--- END EXTRACTION DIAGNOSTICS ---',
    ].join('\n');
    setStatus(onStatus, `Detected ${labelForSource(embedded.source)}. Review the extracted values.`);
    return {
      source: embedded.source,
      sourceLabel: labelForSource(embedded.source),
      parsed,
      log: bodyLog(embedded.source, parsed, file.name, 'pdf-text'),
      rawText: `${diagnostics}\n\n--- EMBEDDED PDF TEXT ---\n${embeddedText}`,
      previewCanvas: canvas,
      ocrNotice: '',
    };
  }

  const configured = Boolean(String(CONFIG.googleVisionApiKey || '').trim());
  let vision = null;
  let visionResult = null;
  let cloudError = null;

  if (configured) {
    try {
      vision = await runVision(canvas, { onStatus, fileName: file.name });
      visionResult = parseVisionResult(vision, canvas, file.name);
      if (visionResult.source !== 'unknown' && visionGoodEnough(visionResult.source, visionResult.parsed)) {
        const diagnostics = [
          vision.diagnostic,
          ...(visionResult.source === 'tanita' ? diagnosticIndicatorLines(visionResult.parsed) : []),
          `Parser completeness: ${Math.round(completeness(visionResult.parsed) * 100)}%`,
          `Extraction source: ${visionResult.source}`,
        ].join('\n');
        setStatus(onStatus, `Detected ${labelForSource(visionResult.source)}. Review the extracted values.`);
        return {
          source: visionResult.source,
          sourceLabel: labelForSource(visionResult.source),
          parsed: visionResult.parsed,
          log: bodyLog(visionResult.source, visionResult.parsed, file.name, 'google-vision:spatial'),
          rawText: `${diagnostics}\n\n${vision.displayText}`,
          previewCanvas: canvas,
          ocrNotice: '',
        };
      }
      cloudError = new Error(`Google OCR result was incomplete (${Math.round(completeness(visionResult?.parsed) * 100)}%).`);
    } catch (error) {
      cloudError = error;
    }
  } else {
    cloudError = new Error('Google OCR is not configured.');
  }

  const reason = redact(cloudError?.message || 'Google OCR was unavailable.');
  setStatus(onStatus, 'Google OCR unavailable — using local OCR fallback…');

  let local;
  try {
    local = await runQuarantinedFallback(canvas, { onStatus, fileName: file.name, reason });
  } catch (fallbackError) {
    if (visionResult?.source !== 'unknown' && visionResult?.parsed) {
      const diagnostics = [
        vision?.diagnostic || cloudFailureDiagnostics(cloudError, configured),
        `Google parser completeness: ${Math.round(completeness(visionResult.parsed) * 100)}%`,
        `Local OCR fallback failed: ${redact(fallbackError.message || fallbackError)}`,
      ].join('\n');
      setStatus(onStatus, `Detected ${labelForSource(visionResult.source)} with incomplete Google OCR. Review carefully.`);
      return {
        source: visionResult.source,
        sourceLabel: labelForSource(visionResult.source),
        parsed: visionResult.parsed,
        log: bodyLog(visionResult.source, visionResult.parsed, file.name, 'google-vision:spatial-partial'),
        rawText: `${diagnostics}\n\n${vision?.displayText || ''}`,
        previewCanvas: canvas,
        ocrNotice: 'Google OCR was incomplete and the local fallback could not run. Review the extracted fields carefully.',
      };
    }
    throw new Error(`${reason} Local OCR fallback also failed: ${redact(fallbackError.message || fallbackError)}`);
  }

  if (!local?.parsed || local.source === 'unknown') {
    throw new Error(`${reason} Local OCR fallback could not recognize this report.`);
  }

  const localParsed = local.source === 'tanita' ? attachTanitaIndicators(local.parsed, canvas) : local.parsed;
  const keepVision = visionResult?.source === local.source
    && visionResult?.parsed
    && completeness(visionResult.parsed) > completeness(localParsed);

  const source = keepVision ? visionResult.source : local.source;
  const parsed = keepVision ? visionResult.parsed : localParsed;
  const method = keepVision ? 'google-vision:spatial-partial' : local.method;
  const notice = configured
    ? (keepVision
      ? 'Google OCR was incomplete. Local OCR was checked, but the Google result was more complete; review the fields carefully.'
      : 'Google OCR was unavailable or incomplete for this import, so local OCR was used.')
    : 'Google OCR is not configured, so local OCR was used.';

  const diagnostics = [
    vision?.diagnostic || cloudFailureDiagnostics(cloudError, configured),
    visionResult?.parsed ? `Google parser completeness: ${Math.round(completeness(visionResult.parsed) * 100)}%` : '',
    local.diagnostic,
    ...(source === 'tanita' ? diagnosticIndicatorLines(parsed) : []),
    `Selected OCR: ${keepVision ? 'Google Vision partial result' : 'local fallback'}`,
    `Parser completeness: ${Math.round(completeness(parsed) * 100)}%`,
    `Extraction source: ${source}`,
  ].filter(Boolean).join('\n');

  setStatus(onStatus, `Detected ${labelForSource(source)}. Review the extracted values.`);
  return {
    source,
    sourceLabel: labelForSource(source),
    parsed,
    log: bodyLog(source, parsed, file.name, method),
    rawText: `${diagnostics}\n\n${keepVision ? vision?.displayText || '' : local.text}`,
    previewCanvas: canvas,
    ocrNotice: notice,
  };
}

export { readBodyCompositionReport, analyzeTanitaIndicators };
