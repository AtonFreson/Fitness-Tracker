import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.mjs';
import { CONFIG } from '../config.js';
import { parseTanitaText, toBodyCompositionLog, mergeTanitaParses } from './tanita-parser.js';
import { parseAccuniqText, toAccuniqBodyCompositionLog } from './accuniq-parser.js';
import { detectBodyCompositionSource, labelForSource } from './source-detection.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.worker.min.mjs';

function setStatus(onStatus, message) {
  if (typeof onStatus === 'function') onStatus(message);
}

async function readPdf(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  if (pdf.numPages < 1) throw new Error('The PDF has no pages.');
  const page = await pdf.getPage(1);

  // PDF.js 6 implements getTextContent() using ReadableStream async iteration.
  // iOS Safari 26.0-26.3 exposes ReadableStream but not its async iterator, so
  // consume the exact same PDF.js text stream through getReader() instead.
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
  const embeddedText = textItems.map((item) => item.str).join('\n').trim();

  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(3, 1500 / baseViewport.width, 6500 / baseViewport.height);
  const viewport = page.getViewport({ scale: Math.max(1.5, scale) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { embeddedText, canvas };
}

function resizeCanvas(source, targetWidth = 720) {
  if (source.width <= targetWidth) return source;
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = Math.max(1, Math.round(source.height * targetWidth / source.width));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function dominantCluster(values, tolerance = 0.014) {
  if (values.length < 3) return null;
  let best = [];
  for (const center of values) {
    const cluster = values.filter((value) => Math.abs(value - center) <= tolerance);
    if (cluster.length > best.length) best = cluster;
  }
  if (best.length < 3 || best.length / values.length < 0.25) return null;
  return {
    position: median(best),
    clusterSize: best.length,
    sampleSize: values.length,
  };
}

function indicatorBand(name, position) {
  const specs = (name === 'fat_percent' || name === 'bmi')
    ? [
        ['-', 0, 0.25],
        ['0', 0.25, 0.50],
        ['+', 0.50, 0.75],
        ['++', 0.75, 1],
      ]
    : [
        ['-', 0, 1 / 3],
        ['0', 1 / 3, 2 / 3],
        ['+', 2 / 3, 1],
      ];

  const clamped = Math.max(0, Math.min(0.999999, position));
  const [level, start, end] = specs.find(([, a, b]) => clamped >= a && clamped < b) || specs.at(-1);
  const rawPercent = ((clamped - start) / (end - start)) * 100;
  // The thermal scans do not justify single-percentage-point precision. Five
  // percent steps are fine-grained enough to show movement within the printed
  // category while remaining honest about the image geometry.
  const sectionPercent = Math.max(0, Math.min(100, Math.round(rawPercent / 5) * 5));
  return {
    level,
    section_percent: sectionPercent,
    reading: `${level}: ${sectionPercent}%`,
  };
}

/**
 * Convert TANITA's printed indicator bars into category + within-category position data.
 *
 * This deliberately uses image geometry rather than OCR. The bar fill itself
 * is the information and OCR engines tend to return only the labels beneath
 * it. The DC-360 print layout is fixed: after locating the dark INDICATOR
 * heading, the five bar slots occur at consistent vertical spacing. Visceral fat
 * is intentionally skipped because its numeric rating already captures the same information.
 */
function analyzeTanitaIndicators(sourceCanvas) {
  if (!sourceCanvas?.width || !sourceCanvas?.height) return null;
  const canvas = resizeCanvas(sourceCanvas, 720);
  const { width, height } = canvas;
  if (width < 250 || height < 700) return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);

  for (let p = 0, i = 0; i < data.length; i += 4, p += 1) {
    const value = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    gray[p] = value;
    histogram[value] += 1;
  }
  const low = percentileFromHistogram(histogram, gray.length, 0.01);
  const high = Math.max(low + 10, percentileFromHistogram(histogram, gray.length, 0.985));
  const stretched = (value) => Math.max(0, Math.min(255, ((value - low) * 255) / (high - low)));

  // Locate the dark INDICATOR title band. Search low enough to skip RESULT and
  // DESIRABLE RANGE, but high enough not to mistake a later bar for the title.
  const x0 = Math.floor(width * 0.03);
  const x1 = Math.ceil(width * 0.97);
  const y0 = Math.floor(height * 0.48);
  const y1 = Math.ceil(height * 0.72);
  const qualifying = [];
  for (let y = y0; y < y1; y += 1) {
    let dark = 0;
    for (let x = x0; x < x1; x += 1) {
      if (stretched(gray[y * width + x]) < 115) dark += 1;
    }
    qualifying.push(dark / (x1 - x0) > 0.64);
  }

  const bands = [];
  let start = null;
  for (let i = 0; i < qualifying.length; i += 1) {
    if (qualifying[i] && start == null) start = y0 + i;
    if (start != null && (!qualifying[i] || i === qualifying.length - 1)) {
      const end = qualifying[i] && i === qualifying.length - 1 ? y0 + i : y0 + i - 1;
      if (end - start + 1 >= Math.max(6, Math.round(width * 0.008))) bands.push([start, end]);
      start = null;
    }
  }
  if (!bands.length) return null;
  const indicatorHeaderBottom = bands.at(-1)[1];

  // Keep the visceral-fat slot in the layout index so the later bars line up,
  // but do not store it: the numeric visceral-fat rating is more precise.
  const names = ['fat_percent', 'bmi', null, 'muscle_mass', 'bmr'];
  const output = {};
  const barLeft = Math.floor(width * 0.025);
  const barRight = Math.ceil(width * 0.965);
  const barWidth = barRight - barLeft;

  for (let index = 0; index < names.length; index += 1) {
    const nominalTop = indicatorHeaderBottom + (0.062 + 0.225 * index) * width;
    const scanTop = Math.floor(nominalTop + 0.010 * width);
    const scanBottom = Math.min(height, Math.ceil(nominalTop + 0.045 * width));
    const positions = [];

    for (let y = scanTop; y < scanBottom; y += 1) {
      // Nine-pixel moving density smooths thermal-printer grain while keeping
      // the filled/unfilled edge sharp enough to measure.
      const darkRow = new Uint8Array(barWidth);
      for (let localX = 0; localX < barWidth; localX += 1) {
        const x = barLeft + localX;
        darkRow[localX] = stretched(gray[y * width + x]) < 145 ? 1 : 0;
      }
      const active = new Uint8Array(barWidth);
      const prefix = new Uint16Array(barWidth + 1);
      for (let x = 0; x < barWidth; x += 1) prefix[x + 1] = prefix[x] + darkRow[x];
      const radius = 4;
      for (let x = 0; x < barWidth; x += 1) {
        const windowStart = Math.max(0, x - radius);
        const windowEnd = Math.min(barWidth - 1, x + radius);
        const windowSum = prefix[windowEnd + 1] - prefix[windowStart];
        active[x] = windowSum / (windowEnd - windowStart + 1) > 0.52 ? 1 : 0;
      }

      const runs = [];
      let runStart = null;
      for (let x = 0; x < barWidth; x += 1) {
        if (active[x] && runStart == null) runStart = x;
        if (runStart != null && (!active[x] || x === barWidth - 1)) {
          const runEnd = active[x] && x === barWidth - 1 ? x : x - 1;
          if (runEnd - runStart + 1 >= 5) runs.push([runStart, runEnd]);
          runStart = null;
        }
      }

      const leftRuns = runs.filter(([runX]) => runX < width * 0.12);
      if (!leftRuns.length) continue;
      let [fillStart, fillEnd] = leftRuns.sort((a, b) => a[0] - b[0])[0];
      for (const [nextStart, nextEnd] of runs) {
        if (nextStart > fillEnd && nextStart - fillEnd <= 12) fillEnd = nextEnd;
      }
      const position = fillEnd / barWidth;
      if (fillStart < width * 0.12 && position > 0.05 && position < 0.98) positions.push(position);
    }

    const cluster = dominantCluster(positions);
    if (!cluster || !names[index]) continue;
    const clusterFraction = cluster.clusterSize / cluster.sampleSize;
    const confidence = Math.min(0.99, 0.45 + 0.42 * clusterFraction + 0.02 * Math.min(cluster.clusterSize, 6));
    const band = indicatorBand(names[index], cluster.position);
    output[names[index]] = {
      ...band,
      position: Math.round(cluster.position * 1000) / 1000,
      confidence: Math.round(confidence * 100) / 100,
      source: 'indicator_graph',
    };
  }
  return Object.keys(output).length ? output : null;
}

function attachTanitaIndicators(parsed, canvas) {
  if (!parsed) return parsed;
  const indicators = analyzeTanitaIndicators(canvas);
  if (!indicators) return parsed;
  parsed.indicators = indicators;
  const fields = new Set(parsed.extraction?.review_fields || ['measured_at_local']);
  for (const key of Object.keys(indicators)) fields.add(`indicators.${key}.reading`);
  const warnings = [...(parsed.extraction?.warnings || [])];

  const fat = parsed.metrics?.fat_percent;
  const fatRange = parsed.reference_ranges?.fat_percent;
  const fatLevel = indicators.fat_percent?.level;
  if (fat != null && fatRange?.min != null && fatRange?.max != null && fatLevel) {
    const numericallyInRange = fat >= fatRange.min && fat <= fatRange.max;
    const graphInRange = fatLevel === '0';
    if (numericallyInRange !== graphInRange) {
      warnings.push('Fat % OCR and the printed FAT % indicator band disagree; review the numeric fat percentage.');
    }
  }


  parsed.extraction = {
    ...parsed.extraction,
    warnings: [...new Set(warnings)],
    review_fields: [...fields],
  };
  return parsed;
}

async function readImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1500 / bitmap.width, 6500 / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { embeddedText: '', canvas };
}

function percentileFromHistogram(hist, total, fraction) {
  const target = total * fraction;
  let seen = 0;
  for (let i = 0; i < hist.length; i += 1) {
    seen += hist[i];
    if (seen >= target) return i;
  }
  return 255;
}

function enhanceContrast(sourceCanvas) {
  const canvas = document.createElement('canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const hist = new Uint32Array(256);

  for (let i = 0; i < data.length; i += 16) {
    const y = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    hist[y] += 1;
  }
  const total = hist.reduce((a, b) => a + b, 0);
  const low = percentileFromHistogram(hist, total, 0.01);
  const high = Math.max(low + 10, percentileFromHistogram(hist, total, 0.985));

  for (let i = 0; i < data.length; i += 4) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const stretched = Math.max(0, Math.min(255, ((y - low) * 255) / (high - low)));
    const v = Math.round(stretched);
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}


function localContrastCanvas(sourceCanvas, radius = 20, gain = 2.5) {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const image = sourceCtx.getImageData(0, 0, width, height);
  const pixels = image.data;
  const gray = new Uint8Array(width * height);

  for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
    gray[p] = Math.round(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]);
  }

  // Integral image gives a fast local mean without pulling in another image-processing library.
  const stride = width + 1;
  // Crop sizes are small enough that a 32-bit summed-area table cannot
  // overflow, and it halves memory versus Float64Array on iOS Safari.
  const integral = new Uint32Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    const row = y * width;
    const outRow = (y + 1) * stride;
    const prevRow = y * stride;
    for (let x = 0; x < width; x += 1) {
      rowSum += gray[row + x];
      integral[outRow + x + 1] = integral[prevRow + x + 1] + rowSum;
    }
  }

  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const outCtx = output.getContext('2d', { willReadFrequently: true });
  const outImage = outCtx.createImageData(width, height);
  const out = outImage.data;

  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width - 1, x + radius);
      const a = integral[top * stride + left];
      const b = integral[top * stride + right + 1];
      const c = integral[(bottom + 1) * stride + left];
      const d = integral[(bottom + 1) * stride + right + 1];
      const count = (right - left + 1) * (bottom - top + 1);
      const mean = (d - b - c + a) / count;
      const v = Math.max(0, Math.min(255, Math.round(245 + (gray[y * width + x] - mean) * gain)));
      const q = (y * width + x) * 4;
      out[q] = v;
      out[q + 1] = v;
      out[q + 2] = v;
      out[q + 3] = 255;
    }
  }
  outCtx.putImageData(outImage, 0, 0);
  return output;
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

function thresholdCanvas(sourceCanvas, threshold = 178) {
  const enhanced = enhanceContrast(sourceCanvas);
  const ctx = enhanced.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, enhanced.width, enhanced.height);
  const data = image.data;
  // A moderate fixed threshold is intentionally used only as a fallback pass.
  // It helps faint dot-matrix digits but is worse than grayscale for clean text.
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i] < threshold ? 0 : 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
  ctx.putImageData(image, 0, 0);
  return enhanced;
}

async function recognize(worker, canvas) {
  const result = await worker.recognize(canvas);
  return result?.data?.text || '';
}

function parseForSource(text, fileName = '') {
  const source = detectBodyCompositionSource(text, fileName);
  if (source === 'tanita') return { source, parsed: parseTanitaText(text, { sourceName: fileName }) };
  if (source === 'accuniq') return { source, parsed: parseAccuniqText(text, { sourceName: fileName }) };
  return { source: 'unknown', parsed: null };
}

function logForSource(source, parsed, fileName, method) {
  if (source === 'tanita') return toBodyCompositionLog(parsed, { sourceName: fileName, method });
  if (source === 'accuniq') return toAccuniqBodyCompositionLog(parsed, { sourceName: fileName, method });
  throw new Error('Unsupported body-composition source.');
}

function canvasBase64Jpeg(canvas, quality = 0.9) {
  // Cloud Vision accepts inline base64 image content. JPEG keeps a five-zone
  // TANITA batch small enough for iOS Safari without materially affecting the
  // high-contrast receipt text.
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function googleVisionText(response) {
  return response?.fullTextAnnotation?.text
    || response?.textAnnotations?.[0]?.description
    || '';
}

function visionVertexNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function googleVisionWords(response) {
  const words = [];
  for (const page of response?.fullTextAnnotation?.pages || []) {
    const pageWidth = Math.max(1, Number(page?.width) || 1);
    const pageHeight = Math.max(1, Number(page?.height) || 1);
    for (const block of page?.blocks || []) {
      for (const paragraph of block?.paragraphs || []) {
        for (const word of paragraph?.words || []) {
          const text = (word?.symbols || []).map((symbol) => symbol?.text || '').join('').trim();
          if (!text) continue;
          const pixelVertices = word?.boundingBox?.vertices || [];
          const normalizedVertices = word?.boundingBox?.normalizedVertices || [];
          const vertices = pixelVertices.length
            ? pixelVertices.map((vertex) => ({ x: visionVertexNumber(vertex?.x), y: visionVertexNumber(vertex?.y) }))
            : normalizedVertices.map((vertex) => ({
                x: visionVertexNumber(vertex?.x) * pageWidth,
                y: visionVertexNumber(vertex?.y) * pageHeight,
              }));
          if (!vertices.length) continue;
          const xs = vertices.map((vertex) => vertex.x);
          const ys = vertices.map((vertex) => vertex.y);
          const left = Math.min(...xs);
          const right = Math.max(...xs);
          const top = Math.min(...ys);
          const bottom = Math.max(...ys);
          const height = Math.max(1, bottom - top);
          const width = Math.max(1, right - left);
          words.push({
            text,
            left,
            right,
            top,
            bottom,
            width,
            height,
            centerY: (top + bottom) / 2,
          });
        }
      }
    }
  }
  return words;
}

/**
 * Cloud Vision's fullTextAnnotation.text follows document reading order. On a
 * TANITA receipt that can mean "all labels, then all values" because the RESULT
 * box is a two-column table. The word bounding boxes are substantially more
 * useful: rebuild visual rows first, then feed those rows to the normal parser.
 * This turns Vision into a structured receipt reader rather than another noisy
 * plain-text OCR source.
 */
function googleVisionSpatialText(response) {
  const words = googleVisionWords(response);
  if (!words.length) return '';

  const typicalHeight = median(words.map((word) => word.height).filter((height) => height > 0)) || 12;
  const sorted = [...words].sort((a, b) => a.centerY - b.centerY || a.left - b.left);
  const lines = [];

  for (const word of sorted) {
    let bestLine = null;
    let bestScore = Infinity;
    for (const line of lines) {
      const centerGap = Math.abs(word.centerY - line.centerY);
      const overlap = Math.max(0, Math.min(word.bottom, line.bottom) - Math.max(word.top, line.top));
      const overlapRatio = overlap / Math.max(1, Math.min(word.height, line.height));
      const tolerance = Math.max(4, typicalHeight * 0.85, Math.min(word.height, line.height) * 0.70);
      if (centerGap <= tolerance || overlapRatio >= 0.35) {
        const score = centerGap - overlapRatio * typicalHeight * 0.4;
        if (score < bestScore) {
          bestScore = score;
          bestLine = line;
        }
      }
    }

    if (!bestLine) {
      lines.push({
        words: [word],
        top: word.top,
        bottom: word.bottom,
        height: word.height,
        centerY: word.centerY,
      });
      continue;
    }

    bestLine.words.push(word);
    bestLine.top = Math.min(bestLine.top, word.top);
    bestLine.bottom = Math.max(bestLine.bottom, word.bottom);
    bestLine.height = Math.max(1, bestLine.bottom - bestLine.top);
    bestLine.centerY = bestLine.words.reduce((sum, item) => sum + item.centerY, 0) / bestLine.words.length;
  }

  lines.sort((a, b) => a.centerY - b.centerY || Math.min(...a.words.map((word) => word.left)) - Math.min(...b.words.map((word) => word.left)));
  return lines
    .map((line) => line.words.sort((a, b) => a.left - b.left).map((word) => word.text).join(' '))
    .filter(Boolean)
    .join('\n');
}

function insertDiagnosticDetails(diagnostic, details = []) {
  const clean = details.filter(Boolean).map((line) => redactDiagnosticText(line));
  if (!clean.length) return diagnostic;
  const marker = '--- END EXTRACTION DIAGNOSTICS ---';
  const index = diagnostic.lastIndexOf(marker);
  if (index < 0) return `${diagnostic}\n${clean.join('\n')}`;
  return `${diagnostic.slice(0, index)}${clean.join('\n')}\n${diagnostic.slice(index)}`;
}

function tanitaBioCount(parsed) {
  return [
    parsed?.bioelectrical?.['6.25_khz']?.r_ohm,
    parsed?.bioelectrical?.['6.25_khz']?.x_ohm,
    parsed?.bioelectrical?.['50_khz']?.r_ohm,
    parsed?.bioelectrical?.['50_khz']?.x_ohm,
  ].filter((value) => value != null).length;
}

function tanitaCoreCount(parsed) {
  const keys = ['weight_kg', 'fat_percent', 'ffm_kg', 'muscle_mass_kg', 'tbw_kg', 'tbw_percent', 'bone_mass_kg', 'bmr_kcal', 'visceral_fat_rating', 'bmi'];
  return keys.filter((key) => parsed?.metrics?.[key] != null).length;
}

function tanitaCloudResultIsStrong(parsed) {
  if (!parsed) return false;
  return (parsed.extraction?.completeness || 0) >= 0.90
    && (parsed.extraction?.warnings?.length || 0) <= 2
    && (parsed.extraction?.conflicted_fields?.length || 0) === 0
    && tanitaBioCount(parsed) >= 3;
}

function redactDiagnosticText(value) {
  return String(value ?? '')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-api-key]')
    .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(x-goog-api-key\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
}

function cloudErrorInfo(payload) {
  const error = payload?.error || null;
  const details = Array.isArray(error?.details) ? error.details : [];
  const info = details.find((detail) => /ErrorInfo$/i.test(String(detail?.['@type'] || ''))) || null;
  const legacyReasons = Array.isArray(error?.errors)
    ? error.errors.map((item) => item?.reason).filter(Boolean)
    : [];
  const reasons = [...new Set([info?.reason, ...legacyReasons].filter(Boolean))];

  const safeMetadata = {};
  for (const [key, value] of Object.entries(info?.metadata || {})) {
    if (/key|credential|token|authorization|secret/i.test(key)) continue;
    safeMetadata[key] = redactDiagnosticText(value);
  }

  return {
    code: error?.code ?? null,
    status: error?.status || '',
    message: redactDiagnosticText(error?.message || ''),
    reasons,
    metadata: safeMetadata,
  };
}

function browserOrigin() {
  try {
    return window.location?.origin || 'unknown';
  } catch {
    return 'unknown';
  }
}

function browserUserAgent() {
  try {
    return navigator.userAgent || 'unknown';
  } catch {
    return 'unknown';
  }
}

function makeCloudDiagnostic({
  configured = true,
  attempted = false,
  imageNames = [],
  elapsedMs = null,
  response = null,
  payload = null,
  rawResponseText = '',
  textCandidateCount = null,
  perImageErrors = [],
  outcome = '',
} = {}) {
  const lines = [
    '--- EXTRACTION DIAGNOSTICS ---',
    `Cloud Vision configured: ${configured ? 'yes' : 'no'}`,
    `Cloud Vision request attempted: ${attempted ? 'yes' : 'no'}`,
  ];

  if (attempted) {
    lines.push(
      'Cloud Vision endpoint: POST https://vision.googleapis.com/v1/images:annotate',
      'Cloud Vision authentication: x-goog-api-key header (key redacted)',
      `Page origin: ${browserOrigin()}`,
      `Browser: ${redactDiagnosticText(browserUserAgent())}`,
      `Batch images: ${imageNames.length}${imageNames.length ? ` (${imageNames.join(', ')})` : ''}`,
    );
    if (elapsedMs != null) lines.push(`Request elapsed: ${Math.round(elapsedMs)} ms`);
    if (response) {
      lines.push(`HTTP result: ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
      const requestId = response.headers?.get?.('x-request-id') || response.headers?.get?.('x-guploader-uploadid');
      if (requestId) lines.push(`Google request id: ${redactDiagnosticText(requestId)}`);
    } else {
      lines.push('HTTP result: no response (fetch/network/CORS failure before a readable response)');
    }

    const topError = cloudErrorInfo(payload);
    if (topError.code != null) lines.push(`Google error code: ${topError.code}`);
    if (topError.status) lines.push(`Google error status: ${topError.status}`);
    if (topError.reasons.length) lines.push(`Google error reason: ${topError.reasons.join(', ')}`);
    if (topError.message) lines.push(`Google error message: ${topError.message}`);
    if (Object.keys(topError.metadata).length) {
      lines.push(`Google error metadata: ${redactDiagnosticText(JSON.stringify(topError.metadata))}`);
    }

    if (!payload && rawResponseText) {
      lines.push(`Non-JSON response: ${redactDiagnosticText(rawResponseText).slice(0, 800)}`);
    }
    if (textCandidateCount != null) lines.push(`OCR text responses: ${textCandidateCount}/${imageNames.length}`);
    if (perImageErrors.length) {
      lines.push(`Per-image errors: ${perImageErrors.length}`);
      for (const item of perImageErrors) {
        lines.push(`- ${item.name}: ${redactDiagnosticText(item.message)}`);
      }
    }
  }

  if (outcome) lines.push(`Cloud Vision outcome: ${redactDiagnosticText(outcome)}`);
  lines.push('--- END EXTRACTION DIAGNOSTICS ---');
  return lines.join('\n');
}

function cloudVisionFailure(message, diagnostic, summary = '') {
  const error = new Error(message);
  error.cloudVisionDiagnostic = diagnostic;
  error.cloudVisionSummary = summary;
  return error;
}

async function googleVisionReceipt(canvas, { onStatus, fileName = '' } = {}) {
  const apiKey = String(CONFIG.googleVisionApiKey || '').trim();
  if (!apiKey) return null;

  const filenameLooksTanita = /TANITA|DC[-_ ]?360/i.test(fileName);
  const images = [{ name: 'FULL', canvas }];

  // A full receipt plus four source-specific crops is much more reliable on
  // faint thermal printing than one monolithic OCR call. Cloud Vision batches
  // them in a single HTTP request; each crop remains an independent OCR vote.
  if (filenameLooksTanita) {
    images.push(
      { name: 'INPUT', canvas: cropCanvas(canvas, 0.00, 0.30) },
      { name: 'RESULT', canvas: cropCanvas(canvas, 0.22, 0.56) },
      { name: 'RANGE', canvas: cropCanvas(canvas, 0.48, 0.70) },
      { name: 'BIOELECTRICAL', canvas: cropCanvas(canvas, 0.80, 1.00) },
    );
  }

  const imageNames = images.map(({ name }) => name);
  setStatus(onStatus, `Cloud OCR: Google Vision (${images.length} image${images.length === 1 ? '' : 's'})…`);
  const requests = images.map(({ canvas: imageCanvas }) => ({
    image: { content: canvasBase64Jpeg(imageCanvas) },
    features: [{ type: 'DOCUMENT_TEXT_DETECTION', model: 'builtin/latest' }],
    imageContext: { languageHints: ['en'] },
  }));

  const startedAt = performance.now();
  let response;
  try {
    response = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify({ requests }),
    });
  } catch (cause) {
    const elapsedMs = performance.now() - startedAt;
    const causeMessage = redactDiagnosticText(cause?.message || cause || 'Unknown fetch error');
    const diagnostic = makeCloudDiagnostic({
      attempted: true,
      imageNames,
      elapsedMs,
      outcome: `request failed before an HTTP response was readable: ${causeMessage}`,
    });
    throw cloudVisionFailure(
      `Google Cloud Vision OCR request failed before an HTTP response was readable: ${causeMessage}`,
      diagnostic,
      'network/CORS error',
    );
  }

  const elapsedMs = performance.now() - startedAt;
  const rawResponseText = await response.text();
  let payload = null;
  try {
    payload = rawResponseText ? JSON.parse(rawResponseText) : null;
  } catch {
    // The diagnostic section records a short redacted response excerpt.
  }

  if (!response.ok) {
    const info = cloudErrorInfo(payload);
    const summary = `HTTP ${response.status}${info.status ? ` ${info.status}` : ''}`;
    const diagnostic = makeCloudDiagnostic({
      attempted: true,
      imageNames,
      elapsedMs,
      response,
      payload,
      rawResponseText,
      outcome: 'request rejected; local Tesseract fallback will be used',
    });
    const detail = info.message || `HTTP ${response.status}`;
    throw cloudVisionFailure(`Google Cloud Vision OCR failed: ${detail}`, diagnostic, summary);
  }

  const responses = payload?.responses || [];
  const textCandidates = [];
  const displayCandidates = [];
  const perImageErrors = [];
  let spatialResponseCount = 0;
  let ocrTextResponseCount = 0;
  for (let i = 0; i < images.length; i += 1) {
    const item = responses[i];
    if (item?.error?.message) {
      perImageErrors.push({ name: images[i].name, message: item.error.message });
      continue;
    }

    const naturalText = googleVisionText(item).trim();
    const spatialText = googleVisionSpatialText(item).trim();
    if (naturalText || spatialText) ocrTextResponseCount += 1;

    // Parse the spatially reconstructed rows whenever geometry is available.
    // Unlike fullTextAnnotation.text this preserves TANITA's label/value rows.
    if (spatialText) {
      spatialResponseCount += 1;
      const name = `GOOGLE VISION ${images[i].name} (SPATIAL)`;
      textCandidates.push({ name, text: spatialText });
      displayCandidates.push({ name, text: spatialText });
    } else if (naturalText) {
      const name = `GOOGLE VISION ${images[i].name}`;
      textCandidates.push({ name, text: naturalText });
      displayCandidates.push({ name, text: naturalText });
    }

    // Keep the native reading-order text for the full page as a debugging aid.
    // It is intentionally not used as a parser vote when spatial text exists.
    if (i === 0 && naturalText && spatialText && naturalText !== spatialText) {
      displayCandidates.push({ name: 'GOOGLE VISION FULL (NATIVE READING ORDER)', text: naturalText });
    }
  }

  let diagnostic = makeCloudDiagnostic({
    attempted: true,
    imageNames,
    elapsedMs,
    response,
    payload,
    rawResponseText,
    textCandidateCount: ocrTextResponseCount,
    perImageErrors,
    outcome: textCandidates.length
      ? `request succeeded; ${ocrTextResponseCount} OCR response${ocrTextResponseCount === 1 ? '' : 's'} contained text`
      : 'request succeeded at HTTP level but returned no usable OCR text; local fallback will be used',
  });
  diagnostic = insertDiagnosticDetails(diagnostic, [
    `Spatial row reconstruction: ${spatialResponseCount}/${images.length} OCR image${images.length === 1 ? '' : 's'}`,
    spatialResponseCount
      ? 'Parser input: Cloud Vision word geometry reconstructed into visual rows'
      : 'Parser input: native Cloud Vision reading order (no word geometry returned)',
  ]);

  if (!textCandidates.length) {
    throw cloudVisionFailure(
      'Google Cloud Vision returned no OCR text.',
      diagnostic,
      perImageErrors.length ? 'per-image OCR errors' : 'empty OCR response',
    );
  }

  const combinedText = displayCandidates.map(({ name, text }) => `--- ${name} ---\n${text}`).join('\n');
  const detected = detectBodyCompositionSource(textCandidates[0].text, fileName);
  const source = filenameLooksTanita ? 'tanita' : detected;

  if (source === 'tanita') {
    const tanitaParses = textCandidates.map(({ text }) => parseTanitaText(text, { sourceName: fileName }));
    const parsed = mergeTanitaParses(tanitaParses);
    const fullParsed = /FULL/.test(textCandidates[0]?.name || '') ? tanitaParses[0] : null;
    // Crops are recovery votes, not peers of a complete full-page Vision read.
    // If the spatial full page is already internally consistent, a single crop
    // misreading one digit should not force several slow local-Tesseract passes.
    const fullStrong = tanitaCloudResultIsStrong(fullParsed);
    const strong = fullStrong || tanitaCloudResultIsStrong(parsed);
    diagnostic = insertDiagnosticDetails(diagnostic, [
      `Cloud parser completeness: ${Math.round((parsed?.extraction?.completeness || 0) * 100)}%`,
      `Cloud parser core fields: ${tanitaCoreCount(parsed)}/10`,
      `Cloud parser bioelectrical fields: ${tanitaBioCount(parsed)}/4`,
      `Cloud parser conflicts: ${(parsed?.extraction?.conflicted_fields || []).join(', ') || 'none'}`,
      `Full-page spatial candidate strong: ${fullStrong ? 'yes' : 'no'}`,
      `Cloud parser warnings: ${(parsed?.extraction?.warnings || []).length}`,
      `Local Tesseract required: ${strong ? 'no' : 'yes (Cloud parse did not meet the strong-result threshold)'}`,
    ]);
    return {
      source: 'tanita',
      parsed,
      text: combinedText,
      method: 'google-vision:spatial-document-consensus',
      textCandidates,
      tanitaParses,
      diagnostic,
    };
  }

  if (source === 'accuniq') {
    // Full-page document OCR preserves ACCUNIQ's table text well; parse the
    // full response first, then fall back to all cloud text if needed.
    let parsed = parseAccuniqText(textCandidates[0].text, { sourceName: fileName });
    if ((parsed.extraction?.completeness || 0) < 0.75) {
      parsed = parseAccuniqText(combinedText, { sourceName: fileName });
    }
    return {
      source: 'accuniq',
      parsed,
      text: combinedText,
      method: 'google-vision:document-text',
      textCandidates,
      tanitaParses: [],
      diagnostic,
    };
  }

  return {
    source: 'unknown',
    parsed: null,
    text: combinedText,
    method: 'google-vision:document-text',
    textCandidates,
    tanitaParses: [],
    diagnostic,
  };
}

async function ocrReceipt(canvas, { onStatus, fileName = '', seedTextCandidates = [], seedTanitaParses = [] } = {}) {
  if (!window.Tesseract?.createWorker) {
    throw new Error('OCR engine did not load. Check your internet connection and reload the page.');
  }

  setStatus(onStatus, 'Loading OCR engine…');
  const worker = await window.Tesseract.createWorker('eng');
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: window.Tesseract.PSM?.SINGLE_BLOCK || '6',
      preserve_interword_spaces: '1',
    });

    const textCandidates = [...seedTextCandidates];
    const tanitaParses = [...seedTanitaParses];
    const remember = (name, text) => {
      textCandidates.push({ name, text });
      tanitaParses.push(parseTanitaText(text, { sourceName: fileName }));
    };

    setStatus(onStatus, 'OCR pass 1: full page…');
    const raw = await recognize(worker, canvas);
    const first = parseForSource(raw, fileName);
    if (first.source === 'accuniq' && first.parsed.extraction.completeness >= 0.75) {
      return { text: raw, method: 'ocr:raw', source: first.source, parsed: first.parsed };
    }
    if (first.source === 'tanita') remember('RAW FULL', raw);

    const enhanced = enhanceContrast(canvas);
    setStatus(onStatus, 'OCR pass 2: contrast-enhanced page…');
    const enhancedText = await recognize(worker, enhanced);
    const second = parseForSource(enhancedText, fileName);
    if (second.source === 'tanita') remember('ENHANCED FULL', enhancedText);

    // ACCUNIQ reports have a different page layout from TANITA receipts. Full-page
    // OCR is more reliable than applying TANITA-specific crop coordinates.
    if (second.source === 'accuniq') {
      const combined = `${enhancedText}\n--- RAW FULL ---\n${raw}`;
      return { text: combined, method: 'ocr:enhanced', source: second.source, parsed: second.parsed };
    }

    // A very clean TANITA scan can stop here. Candidate merging still protects
    // against one pass reading a digit differently from the other.
    if (tanitaParses.length >= 2) {
      const quickMerged = mergeTanitaParses(tanitaParses);
      if (
        quickMerged?.extraction?.completeness >= 0.98
        && quickMerged.extraction.warnings.length <= 1
        && (quickMerged.extraction.conflicted_fields?.length || 0) === 0
      ) {
        return {
          text: textCandidates.map(({ name, text }) => `--- ${name} ---\n${text}`).join('\n'),
          method: seedTanitaParses.length ? 'google-vision+tesseract:consensus-full' : 'ocr:consensus-full',
          source: 'tanita',
          parsed: quickMerged,
        };
      }
    }

    const zones = [
      ['header/input', 0.00, 0.30],
      ['result', 0.22, 0.56],
      ['desirable range', 0.48, 0.70],
      ['bioelectrical', 0.82, 1.00],
    ];
    for (let i = 0; i < zones.length; i += 1) {
      const [name, y0, y1] = zones[i];
      setStatus(onStatus, `OCR pass ${i + 3}: ${name}…`);
      const crop = cropCanvas(canvas, y0, y1);
      const locallyEnhanced = localContrastCanvas(crop);
      const zoneText = await recognize(worker, locallyEnhanced);
      textCandidates.push({ name: name.toUpperCase(), text: zoneText });
      tanitaParses.push(parseTanitaText(zoneText, { sourceName: fileName }));
    }

    let merged = mergeTanitaParses(tanitaParses);

    const missingInput = !merged?.input?.age || !merged?.input?.height_cm || !merged?.input?.gender || merged?.input?.clothes_weight_kg == null;
    if (missingInput) {
      setStatus(onStatus, 'OCR fallback: high-threshold input block…');
      const headerCrop = cropCanvas(canvas, 0.00, 0.30);
      const headerText = await recognize(worker, thresholdCanvas(headerCrop, 220));
      textCandidates.push({ name: 'THRESHOLDED INPUT', text: headerText });
      tanitaParses.push(parseTanitaText(headerText, { sourceName: fileName }));
      merged = mergeTanitaParses(tanitaParses);
    }

    // On particularly faint thermal receipts, a binary pass can recover a
    // decimal digit that both grayscale full-page passes miss. Keep this
    // conditional so normal iPhone imports don't pay for another OCR pass.
    if (!merged || merged.extraction.completeness < 0.85 || merged.extraction.warnings.length > 3) {
      setStatus(onStatus, 'OCR fallback: thresholded result block…');
      const resultCrop = cropCanvas(canvas, 0.22, 0.56);
      const binaryText = await recognize(worker, thresholdCanvas(resultCrop));
      textCandidates.push({ name: 'THRESHOLDED RESULT', text: binaryText });
      tanitaParses.push(parseTanitaText(binaryText, { sourceName: fileName }));
      merged = mergeTanitaParses(tanitaParses);
    }

    const text = textCandidates.map(({ name, text: value }) => `--- ${name} ---\n${value}`).join('\n');
    const source = detectBodyCompositionSource(text, fileName);
    if (source === 'tanita' || /TANITA/i.test(fileName)) {
      return { text, method: seedTanitaParses.length ? 'google-vision+tesseract:consensus-multi-pass' : 'ocr:consensus-multi-pass', source: 'tanita', parsed: merged };
    }
    const parsed = parseForSource(text, fileName);
    return { text, method: 'ocr:multi-pass', source: parsed.source, parsed: parsed.parsed };
  } finally {
    await worker.terminate();
  }
}

async function readBodyCompositionReport(file, { onStatus } = {}) {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  setStatus(onStatus, isPdf ? 'Opening PDF…' : 'Opening image…');
  const { embeddedText, canvas } = isPdf ? await readPdf(file) : await readImage(file);
  const cloudConfigured = Boolean(String(CONFIG.googleVisionApiKey || '').trim());

  const embedded = parseForSource(embeddedText, file.name);
  const embeddedCompleteEnough = embedded.source === 'accuniq'
    ? (embedded.parsed?.extraction?.completeness || 0) >= 0.75
    : embedded.source === 'tanita'
      ? (embedded.parsed?.extraction?.completeness || 0) >= 0.90
      : false;
  if (embedded.source !== 'unknown' && embeddedText.trim().length > 40 && embeddedCompleteEnough) {
    const label = labelForSource(embedded.source);
    setStatus(onStatus, `Detected ${label}; using embedded PDF text.`);
    const parsed = embedded.source === 'tanita' ? attachTanitaIndicators(embedded.parsed, canvas) : embedded.parsed;
    const diagnostic = makeCloudDiagnostic({
      configured: cloudConfigured,
      attempted: false,
      outcome: 'not attempted because embedded PDF text was complete enough',
    });
    return {
      source: embedded.source,
      sourceLabel: label,
      parsed,
      log: logForSource(embedded.source, parsed, file.name, 'pdf-text'),
      rawText: `${diagnostic}\n\n--- FINAL EXTRACTION METHOD ---\npdf-text\n\n--- EMBEDDED PDF TEXT ---\n${embeddedText}`,
      previewCanvas: canvas,
    };
  }

  let cloud = null;
  let cloudDiagnostic = cloudConfigured
    ? ''
    : makeCloudDiagnostic({
      configured: false,
      attempted: false,
      outcome: 'not configured; local Tesseract OCR will be used',
    });

  if (cloudConfigured) {
    try {
      cloud = await googleVisionReceipt(canvas, { onStatus, fileName: file.name });
      cloudDiagnostic = cloud?.diagnostic || makeCloudDiagnostic({
        configured: true,
        attempted: true,
        outcome: 'request completed, but no diagnostic payload was produced',
      });
      if (cloud?.source === 'accuniq' && (cloud.parsed?.extraction?.completeness || 0) >= 0.75) {
        const label = labelForSource('accuniq');
        setStatus(onStatus, `Detected ${label} with Google Cloud Vision. Review the fields before saving.`);
        return {
          source: 'accuniq',
          sourceLabel: label,
          parsed: cloud.parsed,
          log: logForSource('accuniq', cloud.parsed, file.name, cloud.method),
          rawText: `${cloudDiagnostic}\n\n--- FINAL EXTRACTION METHOD ---\n${cloud.method}\n\n${cloud.text}`,
          previewCanvas: canvas,
        };
      }
      if (cloud?.source === 'tanita' && tanitaCloudResultIsStrong(cloud.parsed)) {
        const parsed = attachTanitaIndicators(cloud.parsed, canvas);
        const label = labelForSource('tanita');
        setStatus(onStatus, `Detected ${label} with Google Cloud Vision. Review the fields before saving.`);
        return {
          source: 'tanita',
          sourceLabel: label,
          parsed,
          log: logForSource('tanita', parsed, file.name, cloud.method),
          rawText: `${cloudDiagnostic}\n\n--- FINAL EXTRACTION METHOD ---\n${cloud.method}\n\n${cloud.text}`,
          previewCanvas: canvas,
        };
      }
      if (cloud?.source !== 'unknown') {
        setStatus(onStatus, 'Cloud OCR was partial; combining it with local OCR…');
      }
    } catch (error) {
      console.warn(error);
      cloudDiagnostic = error?.cloudVisionDiagnostic || makeCloudDiagnostic({
        configured: true,
        attempted: true,
        outcome: `request failed: ${redactDiagnosticText(error?.message || error)}`,
      });
      const summary = redactDiagnosticText(error?.cloudVisionSummary || 'request error');
      setStatus(onStatus, `Google Cloud Vision failed (${summary}); falling back to local OCR…`);
      cloud = null;
    }
  }

  const { text, method, source: ocrSource, parsed: ocrParsed } = await ocrReceipt(canvas, {
    onStatus,
    fileName: file.name,
    seedTextCandidates: cloud?.source === 'tanita' ? cloud.textCandidates : [],
    seedTanitaParses: cloud?.source === 'tanita' ? cloud.tanitaParses : [],
  });
  const parsedResult = ocrParsed ? { source: ocrSource, parsed: ocrParsed } : parseForSource(text, file.name);
  const source = parsedResult.source !== 'unknown' ? parsedResult.source : ocrSource;
  if (source === 'unknown') {
    throw new Error('Could not recognize this body-composition report. Supported sources are TANITA DC-360 and ACCUNIQ.');
  }
  let parsed = parsedResult.parsed || parseForSource(text, file.name).parsed;
  if (source === 'tanita') parsed = attachTanitaIndicators(parsed, canvas);
  const label = labelForSource(source);
  setStatus(onStatus, `Detected ${label}. Review the fields before saving.`);
  return {
    source,
    sourceLabel: label,
    parsed,
    log: logForSource(source, parsed, file.name, method),
    rawText: `${cloudDiagnostic}\n\n--- FINAL EXTRACTION METHOD ---\n${method}\n\n--- OCR TEXT USED FOR PARSING ---\n${text}`,
    previewCanvas: canvas,
  };
}

const readTanitaReceipt = readBodyCompositionReport;

export {
  readBodyCompositionReport,
  readTanitaReceipt,
  enhanceContrast,
  localContrastCanvas,
  analyzeTanitaIndicators,
};
