/*
 * QUARANTINED FALLBACK OCR
 *
 * This module is intentionally separate from the Google Vision path.
 * It is loaded only when Vision is unavailable or unusable. Keep its OCR
 * candidates and parsing independent; do not merge them into Vision results.
 */

import { parseTanitaText, mergeTanitaParses } from '../tanita-parser.js';
import { parseAccuniqText } from '../accuniq-parser.js';
import { detectBodyCompositionSource } from '../source-detection.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js';
let loaderPromise = null;

function setStatus(onStatus, message) {
  onStatus?.(message);
}

async function ensureTesseract() {
  if (window.Tesseract?.createWorker) return window.Tesseract;
  if (!loaderPromise) {
    loaderPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TESSERACT_URL;
      script.async = true;
      script.onload = () => window.Tesseract?.createWorker
        ? resolve(window.Tesseract)
        : reject(new Error('Local OCR loaded without a usable Tesseract API.'));
      script.onerror = () => reject(new Error('Local OCR engine could not be downloaded.'));
      document.head.append(script);
    });
  }
  return loaderPromise;
}

function percentile(histogram, total, fraction) {
  const target = total * fraction;
  let seen = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    seen += histogram[i];
    if (seen >= target) return i;
  }
  return 255;
}

function enhanceContrast(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const histogram = new Uint32Array(256);

  for (let i = 0; i < image.data.length; i += 16) {
    const value = Math.round(0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2]);
    histogram[value] += 1;
  }
  const total = histogram.reduce((sum, value) => sum + value, 0);
  const low = percentile(histogram, total, 0.01);
  const high = Math.max(low + 10, percentile(histogram, total, 0.985));

  for (let i = 0; i < image.data.length; i += 4) {
    const gray = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
    const value = Math.round(Math.max(0, Math.min(255, ((gray - low) * 255) / (high - low))));
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
  }
  ctx.putImageData(image, 0, 0);
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

async function recognize(worker, canvas) {
  const result = await worker.recognize(canvas);
  return String(result?.data?.text || '').trim();
}

function parseCandidate(text, fileName) {
  const source = detectBodyCompositionSource(text, fileName);
  if (source === 'tanita') return { source, parsed: parseTanitaText(text, { sourceName: fileName }) };
  if (source === 'accuniq') return { source, parsed: parseAccuniqText(text, { sourceName: fileName }) };
  return { source: 'unknown', parsed: null };
}

function completeness(parsed) {
  return parsed?.extraction?.completeness || 0;
}

async function runLocalOcrFallback(canvas, { onStatus, fileName = '', reason = '' } = {}) {
  setStatus(onStatus, 'Google OCR unavailable — using local OCR fallback…');
  const Tesseract = await ensureTesseract();
  const worker = await Tesseract.createWorker('eng');
  const candidates = [];

  try {
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM?.SINGLE_BLOCK || '6',
      preserve_interword_spaces: '1',
    });

    setStatus(onStatus, 'Local OCR fallback: reading full page…');
    const raw = await recognize(worker, canvas);
    if (raw) candidates.push({ name: 'RAW FULL', text: raw, ...parseCandidate(raw, fileName) });

    setStatus(onStatus, 'Local OCR fallback: enhancing scan…');
    const enhanced = await recognize(worker, enhanceContrast(canvas));
    if (enhanced) candidates.push({ name: 'ENHANCED FULL', text: enhanced, ...parseCandidate(enhanced, fileName) });

    const detected = candidates.find((candidate) => candidate.source !== 'unknown')?.source
      || (/TANITA|DC[-_ ]?360/i.test(fileName) ? 'tanita' : /ACCUNIQ/i.test(fileName) ? 'accuniq' : 'unknown');

    if (detected === 'tanita') {
      const zones = [
        ['INPUT', 0.00, 0.30],
        ['RESULT', 0.22, 0.56],
        ['RANGE', 0.48, 0.70],
        ['BIOELECTRICAL', 0.80, 1.00],
      ];
      for (const [name, y0, y1] of zones) {
        setStatus(onStatus, `Local OCR fallback: ${name.toLowerCase()}…`);
        const text = await recognize(worker, enhanceContrast(cropCanvas(canvas, y0, y1)));
        if (text) candidates.push({ name, text, source: 'tanita', parsed: parseTanitaText(text, { sourceName: fileName }) });
      }

      const parses = candidates.filter((candidate) => candidate.source === 'tanita' && candidate.parsed).map((candidate) => candidate.parsed);
      const parsed = parses.length ? mergeTanitaParses(parses) : null;
      return {
        source: 'tanita',
        parsed,
        text: candidates.map(({ name, text }) => `--- LOCAL OCR ${name} ---\n${text}`).join('\n\n'),
        method: 'local-tesseract:fallback',
        diagnostic: [
          '--- LOCAL OCR FALLBACK ---',
          `Reason: ${reason || 'Google OCR was unavailable'}`,
          `Candidates: ${candidates.length}`,
          `Parser completeness: ${Math.round(completeness(parsed) * 100)}%`,
          '--- END LOCAL OCR FALLBACK ---',
        ].join('\n'),
      };
    }

    if (detected === 'accuniq') {
      const parsedCandidates = candidates
        .filter((candidate) => candidate.source === 'accuniq' && candidate.parsed)
        .sort((a, b) => completeness(b.parsed) - completeness(a.parsed));
      const best = parsedCandidates[0];
      return {
        source: 'accuniq',
        parsed: best?.parsed || null,
        text: candidates.map(({ name, text }) => `--- LOCAL OCR ${name} ---\n${text}`).join('\n\n'),
        method: 'local-tesseract:fallback',
        diagnostic: [
          '--- LOCAL OCR FALLBACK ---',
          `Reason: ${reason || 'Google OCR was unavailable'}`,
          `Candidates: ${candidates.length}`,
          `Parser completeness: ${Math.round(completeness(best?.parsed) * 100)}%`,
          '--- END LOCAL OCR FALLBACK ---',
        ].join('\n'),
      };
    }

    throw new Error('Local OCR could not recognize the report source.');
  } finally {
    await worker.terminate();
  }
}

export { runLocalOcrFallback };
