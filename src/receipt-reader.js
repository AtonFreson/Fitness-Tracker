import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.mjs';
import { parseTanitaText, toBodyCompositionLog } from './tanita-parser.js';
import { parseAccuniqText, toAccuniqBodyCompositionLog } from './accuniq-parser.js';
import { detectBodyCompositionSource, labelForSource } from './source-detection.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/build/pdf.worker.min.mjs';

function setStatus(onStatus, message) {
  if (typeof onStatus === 'function') onStatus(message);
}

async function getTextContentSafariSafe(page) {
  const reader = page.streamTextContent().getReader();
  const items = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.items?.length) items.push(...value.items);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  return items;
}

async function readPdf(file) {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  if (pdf.numPages < 1) throw new Error('The PDF has no pages.');
  const page = await pdf.getPage(1);

  // PDF.js 6 uses ReadableStream async iteration inside getTextContent().
  // Safari 26 can expose ReadableStream without the async-iterator methods,
  // so consume the same stream through getReader() instead.
  const textItems = await getTextContentSafariSafe(page);
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
  const integral = new Float64Array((width + 1) * (height + 1));
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

async function ocrReceipt(canvas, { onStatus, fileName = '' } = {}) {
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

    setStatus(onStatus, 'OCR pass 1/6: full page…');
    const raw = await recognize(worker, canvas);
    const first = parseForSource(raw, fileName);
    if (first.source === 'accuniq' && first.parsed.extraction.completeness >= 0.75) {
      return { text: raw, method: 'ocr:raw', source: first.source };
    }
    if (first.source === 'tanita' && first.parsed.extraction.completeness >= 0.9 && first.parsed.extraction.warnings.length <= 1) {
      return { text: raw, method: 'ocr:raw', source: first.source };
    }

    const enhanced = enhanceContrast(canvas);
    setStatus(onStatus, 'OCR pass 2/6: enhanced full page…');
    const enhancedText = await recognize(worker, enhanced);
    const combined = `${enhancedText}\n--- RAW FULL ---\n${raw}`;
    const second = parseForSource(combined, fileName);

    // ACCUNIQ reports have a different page layout from TANITA receipts. Full-page
    // OCR is more reliable than applying TANITA-specific crop coordinates.
    if (second.source === 'accuniq') {
      return { text: combined, method: 'ocr:enhanced', source: second.source };
    }

    const zones = [
      ['header/input', 0.00, 0.30],
      ['result', 0.25, 0.56],
      ['desirable range', 0.50, 0.70],
      ['bioelectrical', 0.86, 1.00],
    ];
    const zoneTexts = [];
    for (let i = 0; i < zones.length; i += 1) {
      const [name, y0, y1] = zones[i];
      setStatus(onStatus, `OCR pass ${i + 3}/6: ${name}…`);
      const crop = cropCanvas(canvas, y0, y1);
      const locallyEnhanced = localContrastCanvas(crop);
      zoneTexts.push(`\n--- ${name.toUpperCase()} ---\n${await recognize(worker, locallyEnhanced)}`);
    }

    const text = `${zoneTexts.join('\n')}\n--- ENHANCED FULL ---\n${enhancedText}\n--- RAW FULL ---\n${raw}`;
    const source = detectBodyCompositionSource(text, fileName);
    return { text, method: 'ocr:multi-pass', source };
  } finally {
    await worker.terminate();
  }
}

async function readBodyCompositionReport(file, { onStatus } = {}) {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  setStatus(onStatus, isPdf ? 'Opening PDF…' : 'Opening image…');
  const { embeddedText, canvas } = isPdf ? await readPdf(file) : await readImage(file);

  const embedded = parseForSource(embeddedText, file.name);
  if (embedded.source !== 'unknown' && embeddedText.trim().length > 40) {
    const label = labelForSource(embedded.source);
    setStatus(onStatus, `Detected ${label}; using embedded PDF text.`);
    return {
      source: embedded.source,
      sourceLabel: label,
      parsed: embedded.parsed,
      log: logForSource(embedded.source, embedded.parsed, file.name, 'pdf-text'),
      rawText: embeddedText,
      previewCanvas: canvas,
    };
  }

  const { text, method, source: ocrSource } = await ocrReceipt(canvas, { onStatus, fileName: file.name });
  const parsedResult = parseForSource(text, file.name);
  const source = parsedResult.source !== 'unknown' ? parsedResult.source : ocrSource;
  if (source === 'unknown') {
    throw new Error('Could not recognize this body-composition report. Supported sources are TANITA DC-360 and ACCUNIQ.');
  }
  const parsed = parsedResult.parsed || parseForSource(text, file.name).parsed;
  const label = labelForSource(source);
  setStatus(onStatus, `Detected ${label}. Review the fields before saving.`);
  return {
    source,
    sourceLabel: label,
    parsed,
    log: logForSource(source, parsed, file.name, method),
    rawText: text,
    previewCanvas: canvas,
  };
}

const readTanitaReceipt = readBodyCompositionReport;

export { readBodyCompositionReport, readTanitaReceipt, enhanceContrast, localContrastCanvas };
