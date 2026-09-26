import { CONFIG } from '../config.js';
import {
  debugLog,
  debugError,
  debugText,
  downloadDebugLog,
  initDebugCapture,
} from './tanita-scan-debug.js?v=2';
import { normalizeTanitaDate, resolveDateFromOcr, tanitaPdfFilename } from './tanita-scan-core.js';
import {
  imageFileToCanvas,
  rotateCanvas180,
  cropCanvas,
  copyCanvas,
} from './tanita-scan-image.js?v=4';
import {
  scanReceiptsInWorker,
  resetScannerWorker,
} from './tanita-scan-worker-client.js?v=1';

const $ = (selector) => document.querySelector(selector);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const state = {
  sourceCanvas: null,
  receipts: [],
  reviewIndex: 0,
};

const diagnosticEntries = [];

function summarizeDebugEntry(entry) {
  const data = entry?.data == null ? '' : ' ' + JSON.stringify(entry.data);
  return '[' + (entry?.elapsedMs ?? 0) + 'ms] ' + (entry?.event || 'event') + data;
}

function updateDiagnosticPanel(entry = null) {
  if (entry) {
    diagnosticEntries.push(entry);
    if (diagnosticEntries.length > 12) diagnosticEntries.shift();
  }

  const last = diagnosticEntries.at(-1);
  const count = $('#diagnostic-count');
  const lastEvent = $('#diagnostic-last-event');
  const tail = $('#diagnostic-tail');
  if (count) count.textContent = String(window.__tanitaDebugCount || diagnosticEntries.length);
  if (lastEvent && last) lastEvent.textContent = last.event || 'Event';
  if (tail) {
    tail.textContent = diagnosticEntries.length
      ? diagnosticEntries.map(summarizeDebugEntry).join('\n')
      : 'No events yet.';
  }
}

function setDiagnosticStage(stage, state = '') {
  const stageNode = $('#diagnostic-stage');
  const badge = $('#diagnostic-state');
  if (stageNode) stageNode.textContent = stage;
  if (badge) {
    badge.textContent = state || stage;
    badge.dataset.state = state ? state.toLowerCase() : '';
  }
  debugLog('stage', { stage, state });
}

window.addEventListener('tanita-scan-debug-entry', (event) => {
  window.__tanitaDebugCount = (window.__tanitaDebugCount || 0) + 1;
  updateDiagnosticPanel(event.detail);
});

initDebugCapture();
debugLog('scanner-controller-loaded', {
  module: 'tanita-scan.js',
  build: 4,
  googleVisionConfigured: Boolean(String(CONFIG.googleVisionApiKey || '').trim()),
});

function setStatus(message, kind = '') {
  const node = $('#scan-status');
  node.textContent = message;
  node.dataset.state = kind;
  debugLog('ui-status', { message, kind });
}

function setProcessing(busy) {
  for (const input of [$('#camera-input'), $('#photo-input')]) input.disabled = busy;
  $('#start-review').disabled = busy;
  document.body.classList.toggle('scan-busy', busy);
}

function resizeCanvas(source, maxWidth) {
  if (source.width <= maxWidth) return source;
  const canvas = document.createElement('canvas');
  canvas.width = maxWidth;
  canvas.height = Math.max(1, Math.round(source.height * maxWidth / source.width));
  canvas.getContext('2d', { alpha: false }).drawImage(
    source,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

function jpegBase64(source) {
  const image = resizeCanvas(source, 950);
  return image.toDataURL('image/jpeg', 0.88).split(',', 2)[1];
}

function visionText(response) {
  return String(
    response?.fullTextAnnotation?.text
    || response?.textAnnotations?.[0]?.description
    || '',
  ).trim();
}

function headerScore(text) {
  const source = String(text || '').toUpperCase();
  let score = 0;
  if (/\bTANITA\b/.test(source)) score += 4;
  if (/BODY\s+COMPOSITION/.test(source)) score += 2;
  if (/DC\s*[- ]?\s*360/.test(source)) score += 2;
  return score;
}

async function annotateVisionRequests(requests) {
  const key = String(CONFIG.googleVisionApiKey || '').trim();
  if (!key) throw new Error('Google date OCR is not configured.');

  const responses = [];
  for (let offset = 0; offset < requests.length; offset += 16) {
    const chunk = requests.slice(offset, offset + 16);
    const response = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
      },
      body: JSON.stringify({ requests: chunk }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.error?.message
        ? String(payload.error.message)
        : 'request rejected';
      throw new Error('Google date OCR failed: ' + detail);
    }
    responses.push(...(payload?.responses || []));
  }
  return responses;
}

async function readReceiptDates(receipts) {
  const requests = [];
  const metadata = [];

  for (let i = 0; i < receipts.length; i += 1) {
    const receipt = receipts[i];
    const top = cropCanvas(receipt.canvas, 0, 0.31);
    const bottom = cropCanvas(receipt.canvas, 0.69, 1);

    for (const [side, canvas] of [['top', top], ['bottom', bottom]]) {
      metadata.push({ receiptIndex: i, side });
      requests.push({
        image: { content: jpegBase64(canvas) },
        features: [{ type: 'TEXT_DETECTION', maxResults: 20 }],
        imageContext: { languageHints: ['en'] },
      });
    }
  }

  const responses = await annotateVisionRequests(requests);
  const texts = receipts.map(() => ({ top: '', bottom: '' }));

  for (let i = 0; i < metadata.length; i += 1) {
    const meta = metadata[i];
    texts[meta.receiptIndex][meta.side] = visionText(responses[i]);
  }

  for (let i = 0; i < receipts.length; i += 1) {
    const receipt = receipts[i];
    const topText = texts[i].top;
    const bottomText = texts[i].bottom;
    const resolved = resolveDateFromOcr(topText, bottomText);
    let orientation = resolved.orientation;

    if (orientation == null) {
      const topHeader = headerScore(topText);
      const bottomHeader = headerScore(bottomText);
      if (topHeader > bottomHeader && topHeader >= 2) orientation = 0;
      if (bottomHeader > topHeader && bottomHeader >= 2) orientation = 180;
    }

    if (orientation === 180) receipt.canvas = rotateCanvas180(receipt.canvas);
    receipt.orientationKnown = orientation != null;
    receipt.date = resolved.date;
    receipt.needsManualDate = resolved.needsManual;
    receipt.ocrTopText = topText;
    receipt.ocrBottomText = bottomText;
  }
}

function defaultFilenameFor(index) {
  const receipt = state.receipts[index];
  if (!receipt?.date) return 'TANITA.pdf';

  let duplicateIndex = 1;
  for (let i = 0; i < index; i += 1) {
    if (state.receipts[i].date === receipt.date) duplicateIndex += 1;
  }
  return tanitaPdfFilename(receipt.date, duplicateIndex) || 'TANITA.pdf';
}

function assignDefaultFilenames() {
  for (let i = 0; i < state.receipts.length; i += 1) {
    state.receipts[i].fileName = defaultFilenameFor(i);
    state.receipts[i].customName = false;
  }
}

function renderSourcePreview(quads) {
  const preview = $('#source-preview');
  const maxWidth = 900;
  const scale = Math.min(1, maxWidth / state.sourceCanvas.width);
  preview.width = Math.max(1, Math.round(state.sourceCanvas.width * scale));
  preview.height = Math.max(1, Math.round(state.sourceCanvas.height * scale));

  const context = preview.getContext('2d');
  context.drawImage(state.sourceCanvas, 0, 0, preview.width, preview.height);
  context.lineWidth = Math.max(2, preview.width / 350);
  context.strokeStyle = '#2563eb';
  context.fillStyle = '#2563eb';
  context.font = '700 ' + Math.max(14, Math.round(preview.width / 35)) + 'px system-ui';

  quads.forEach((quad, index) => {
    const points = quad.points.map((point) => ({
      x: point.x * scale,
      y: point.y * scale,
    }));
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) context.lineTo(points[i].x, points[i].y);
    context.closePath();
    context.stroke();
    context.fillText(String(index + 1), points[0].x + 8, points[0].y + 28);
  });

  $('#source-preview-wrap').hidden = false;
}

function renderReceiptCards() {
  const list = $('#receipt-list');
  list.replaceChildren();

  state.receipts.forEach((receipt, index) => {
    const card = document.createElement('article');
    card.className = 'receipt-card';

    const canvas = document.createElement('canvas');
    copyCanvas(receipt.canvas, canvas, 220);

    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = 'Receipt ' + (index + 1);

    const detail = document.createElement('span');
    detail.textContent = receipt.date
      ? receipt.fileName
      : 'Date needs confirmation';

    info.append(title, detail);
    card.append(canvas, info);
    list.append(card);
  });

  $('#receipt-results').hidden = false;
}

function resetResults() {
  state.receipts = [];
  state.reviewIndex = 0;
  $('#source-preview-wrap').hidden = true;
  $('#receipt-results').hidden = true;
  $('#receipt-list').replaceChildren();
  $('#start-review').hidden = true;
}

async function processPhoto(file) {
  if (!file) return;
  resetResults();
  setProcessing(true);

  try {
    debugLog('photo-selected', {
      type: file.type || '',
      sizeBytes: file.size || 0,
      lastModified: file.lastModified || null,
    });
    setDiagnosticStage('Opening photo', 'Working');
    setStatus('Opening full-quality photo...');
    const photoStarted = performance.now();
    state.sourceCanvas = await imageFileToCanvas(file);
    debugLog('photo-opened', {
      elapsedMs: Math.round(performance.now() - photoStarted),
      width: state.sourceCanvas.width,
      height: state.sourceCanvas.height,
      pixels: state.sourceCanvas.width * state.sourceCanvas.height,
    });

    setDiagnosticStage('Starting background detector', 'Working');
    setStatus('Starting receipt detector in background...');

    const detectorStarted = performance.now();
    const scanResult = await scanReceiptsInWorker(state.sourceCanvas, {
      onStage(stage) {
        if (stage.phase === 'loading-detector') {
          setDiagnosticStage('Loading detector in background', 'Working');
          setStatus(
            'Loading receipt detector in background'
            + (stage.sourceCount > 1 ? ' (' + stage.sourceIndex + '/' + stage.sourceCount + ')' : '')
            + '...',
          );
        } else if (stage.phase === 'transferring-photo') {
          setDiagnosticStage('Sending photo to detector', 'Working');
          setStatus('Sending photo to background detector...');
        } else if (stage.phase === 'detecting') {
          setDiagnosticStage('Finding corners in background', 'Working');
          setStatus('Finding receipt corners in background...');
        } else if (stage.phase === 'receiving-results') {
          setDiagnosticStage('Receiving scan results', 'Working');
          setStatus('Preparing detected receipts...');
        }
      },
    });

    const quads = scanResult.quads;
    const canvases = scanResult.canvases;
    debugLog('background-scan-finished', {
      elapsedMs: Math.round(performance.now() - detectorStarted),
      count: quads.length,
      source: scanResult.source,
      quads: quads.map((quad) => ({
        method: quad.method,
        subpixelRefined: Boolean(quad.subpixelRefined),
        refinedEdges: quad.refinedEdges ?? 0,
        points: quad.points.map((point) => ({
          x: Math.round(point.x * 100) / 100,
          y: Math.round(point.y * 100) / 100,
        })),
      })),
    });

    if (!quads.length) {
      throw new Error(
        'No complete TANITA receipts were found. Keep all four corners visible and leave a small gap between receipts.',
      );
    }

    renderSourcePreview(quads);
    state.receipts = canvases.map((canvas, index) => ({
      id: index + 1,
      canvas,
      date: null,
      fileName: 'TANITA.pdf',
      customName: false,
      needsManualDate: true,
      orientationKnown: false,
    }));

    setDiagnosticStage('Reading dates', 'Working');
    setStatus('Reading only the printed date on each receipt...');
    try {
      await readReceiptDates(state.receipts);
      setStatus(
        'Found ' + state.receipts.length + ' receipt'
        + (state.receipts.length === 1 ? '' : 's')
        + '. Review each PDF before downloading.',
        'success',
      );
    } catch (error) {
      for (const receipt of state.receipts) {
        receipt.needsManualDate = true;
        receipt.date = null;
      }
      setStatus(
        'Found ' + state.receipts.length + ' receipt'
        + (state.receipts.length === 1 ? '' : 's')
        + '. Date OCR was unavailable, so the date will be entered during review.',
        'warning',
      );
      console.warn(error);
    }

    assignDefaultFilenames();
    renderReceiptCards();
    $('#start-review').hidden = false;
    setDiagnosticStage('Ready for review', 'Ready');
    debugLog('photo-processing-complete', { receiptCount: state.receipts.length });
  } catch (error) {
    console.error(error);
    debugError('photo-processing-failed', error);
    setDiagnosticStage('Failed', 'Error');
    setStatus(error.message || String(error), 'error');
  } finally {
    setProcessing(false);
  }
}

function renderDateCrops(receipt) {
  const container = $('#manual-date-crops');
  container.replaceChildren();

  const items = receipt.orientationKnown
    ? [['Date area', cropCanvas(receipt.canvas, 0.07, 0.25)]]
    : [
      ['One end', cropCanvas(receipt.canvas, 0.07, 0.25)],
      ['Other end', cropCanvas(receipt.canvas, 0.75, 0.93, true)],
    ];

  for (const [label, source] of items) {
    const item = document.createElement('div');
    item.className = 'date-crop';

    const text = document.createElement('span');
    text.textContent = label;

    const canvas = document.createElement('canvas');
    copyCanvas(source, canvas, 700);

    item.append(text, canvas);
    container.append(item);
  }
}

function renderReviewPreview(receipt) {
  copyCanvas(receipt.canvas, $('#review-canvas'), 950);
}

function reviewDateState(receipt) {
  const manual = $('#manual-date-panel');
  const auto = $('#auto-date-status');
  const confirm = $('#confirm-download');

  if (receipt.needsManualDate || !receipt.date) {
    manual.hidden = false;
    auto.hidden = true;
    renderDateCrops(receipt);
    $('#manual-date').value = receipt.manualDateText || '';
    $('#manual-date-status').textContent = '';
    confirm.disabled = !receipt.date;
  } else {
    manual.hidden = true;
    auto.hidden = false;
    auto.textContent = 'Date read as ' + receipt.date + '.';
    confirm.disabled = false;
  }
}

function openReview(index) {
  if (!state.receipts.length) return;

  state.reviewIndex = clamp(index, 0, state.receipts.length - 1);
  const receipt = state.receipts[state.reviewIndex];
  if (!receipt.customName) receipt.fileName = defaultFilenameFor(state.reviewIndex);

  $('#review-progress').textContent =
    'Receipt ' + (state.reviewIndex + 1) + ' of ' + state.receipts.length;
  $('#review-name').value = receipt.fileName;
  $('#review-status').textContent = '';

  renderReviewPreview(receipt);
  reviewDateState(receipt);

  $('#review-screen').hidden = false;
  $('#review-complete').hidden = true;
  $('#review-content').hidden = false;
  document.body.classList.add('review-open');
  window.scrollTo(0, 0);
}

function closeReview() {
  $('#review-screen').hidden = true;
  document.body.classList.remove('review-open');
}

function sanitizePdfName(input) {
  let value = String(input || '').trim().replace(/[\\/:*?"<>|]+/g, '-');
  if (!value) value = 'TANITA.pdf';
  if (!/\.pdf$/i.test(value)) value += '.pdf';
  return value;
}

async function createPdfBlob(canvas) {
  const jsPDF = window.jspdf?.jsPDF;
  if (!jsPDF) {
    throw new Error('The PDF generator did not load. Reload the page and try again.');
  }

  const pageWidth = 360;
  const pageHeight = Math.max(1, pageWidth * canvas.height / canvas.width);
  const pdf = new jsPDF({
    orientation: pageHeight >= pageWidth ? 'portrait' : 'landscape',
    unit: 'pt',
    format: [pageWidth, pageHeight],
    compress: true,
  });

  const image = canvas.toDataURL('image/jpeg', 0.94);
  pdf.addImage(
    image,
    'JPEG',
    0,
    0,
    pageWidth,
    pageHeight,
    undefined,
    'MEDIUM',
  );
  return pdf.output('blob');
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function confirmCurrentReceipt() {
  const receipt = state.receipts[state.reviewIndex];
  if (!receipt) return;

  if (!receipt.date) {
    $('#review-status').textContent = 'Enter the printed date before downloading.';
    return;
  }

  const button = $('#confirm-download');
  button.disabled = true;
  $('#review-status').textContent = 'Creating PDF...';

  try {
    receipt.fileName = sanitizePdfName($('#review-name').value);
    const blob = await createPdfBlob(receipt.canvas);
    downloadBlob(blob, receipt.fileName);
    receipt.downloaded = true;

    if (state.reviewIndex + 1 < state.receipts.length) {
      openReview(state.reviewIndex + 1);
    } else {
      $('#review-content').hidden = true;
      $('#review-complete').hidden = false;
      $('#review-complete-count').textContent = String(
        state.receipts.filter((item) => item.downloaded).length,
      );
    }
  } catch (error) {
    console.error(error);
    $('#review-status').textContent = error.message || String(error);
    button.disabled = false;
  }
}

function applyManualDate(value) {
  const receipt = state.receipts[state.reviewIndex];
  if (!receipt) return;

  receipt.manualDateText = value;
  const parsed = normalizeTanitaDate(value);
  const status = $('#manual-date-status');

  if (!parsed) {
    receipt.date = null;
    receipt.needsManualDate = true;
    status.textContent = value.trim()
      ? 'Use the printed date, for example 23/SEP/2026.'
      : '';
    $('#confirm-download').disabled = true;
    return;
  }

  receipt.date = parsed;
  receipt.needsManualDate = false;
  status.textContent = 'Date accepted: ' + parsed;

  if (!receipt.customName) {
    receipt.fileName = defaultFilenameFor(state.reviewIndex);
    $('#review-name').value = receipt.fileName;
  }

  $('#confirm-download').disabled = false;
}

function rotateCurrentReceipt() {
  const receipt = state.receipts[state.reviewIndex];
  if (!receipt) return;

  receipt.canvas = rotateCanvas180(receipt.canvas);
  receipt.orientationKnown = true;
  renderReviewPreview(receipt);

  if (!$('#manual-date-panel').hidden) renderDateCrops(receipt);
}

function resetScanner() {
  closeReview();
  resetResults();
  resetScannerWorker();
  state.sourceCanvas = null;
  $('#camera-input').value = '';
  $('#photo-input').value = '';
  setStatus('Take one photo with all receipt corners visible.');
}

for (const input of [$('#camera-input'), $('#photo-input')]) {
  input.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    await processPhoto(file);
    event.target.value = '';
  });
}

$('#start-review').addEventListener('click', () => openReview(0));
$('#review-close').addEventListener('click', closeReview);
$('#review-rotate').addEventListener('click', rotateCurrentReceipt);
$('#confirm-download').addEventListener('click', confirmCurrentReceipt);
$('#manual-date').addEventListener('input', (event) => {
  applyManualDate(event.target.value);
});
$('#review-name').addEventListener('input', (event) => {
  const receipt = state.receipts[state.reviewIndex];
  if (!receipt) return;
  receipt.fileName = event.target.value;
  receipt.customName = true;
});
$('#scan-another').addEventListener('click', resetScanner);

$('#download-debug-log').addEventListener('click', () => {
  downloadDebugLog();
  $('#diagnostic-action-status').textContent = 'Diagnostic log downloaded.';
});

$('#copy-debug-log').addEventListener('click', async () => {
  const status = $('#diagnostic-action-status');
  try {
    await navigator.clipboard.writeText(debugText());
    debugLog('debug-log-copied');
    status.textContent = 'Diagnostic log copied.';
  } catch (error) {
    debugError('debug-log-copy-failed', error);
    status.textContent = 'Copy failed; use Download diagnostic log instead.';
  }
});

setDiagnosticStage('Waiting for photo', 'Ready');
updateDiagnosticPanel();
