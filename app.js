import { CONFIG, configProblems } from './config.js';
import { importUploadedFile } from './src/import-router.js?v=6';
import {
  saveLog,
  saveLogs,
  getAllLogs,
  deleteLog,
  clearLogs,
  exportJsonl,
  sortLogs,
  mergeLogs,
  sameUploadRecord,
  assertPrivateRepo,
} from './src/storage.js?v=8';
import {
  setAccessToken,
  clearAuth,
  getAuthenticatedUser,
  hasStoredAuth,
  fineGrainedTokenUrl,
  savedTokenFileUrl,
} from './src/github-auth.js';
import {
  decimalStep,
  stepIndicatorReading,
  parseIndicatorReading,
  recordEntries,
  coerceRecordValue,
} from './src/ui-helpers.js?v=2';
import {
  refineTanitaIndicators,
  cropIndicatorCanvas,
  preserveReviewedIndicators,
} from './src/tanita-indicator-review.js?v=2';

const $ = (selector) => document.querySelector(selector);

let pendingBodyLog = null;
let pendingHealthLogs = [];
let signedInUser = null;
let currentPreviewCanvas = null;
let indicatorRegions = {};
let logsCache = [];
let editingLog = null;

const commonBodyFields = [
  ['measured_at_local', 'Measured at', 'text'],
  ['metrics.weight_kg', 'Weight (kg)', 'number'],
  ['metrics.fat_percent', 'Body fat (%)', 'number'],
  ['metrics.fat_mass_kg', 'Fat mass (kg)', 'number'],
  ['metrics.ffm_kg', 'Fat-free mass (kg)', 'number'],
  ['metrics.muscle_mass_kg', 'Muscle mass (kg)', 'number'],
];

const tanitaReviewFields = [
  ['input.body_type', 'Body type', 'text'],
  ['input.gender', 'Gender', 'text'],
  ['input.age', 'Age', 'number'],
  ['input.height_cm', 'Height (cm)', 'number'],
  ['input.clothes_weight_kg', 'Clothes weight (kg)', 'number'],
  ['measured_at_local', 'Measured at', 'text'],

  ['metrics.weight_kg', 'Weight (kg)', 'number'],
  ['metrics.fat_percent', 'Body fat (%)', 'number'],
  ['metrics.fat_mass_kg', 'Fat mass (kg)', 'number'],
  ['metrics.ffm_kg', 'Fat-free mass (kg)', 'number'],
  ['metrics.muscle_mass_kg', 'Muscle mass (kg)', 'number'],
  ['metrics.tbw_kg', 'TBW (kg)', 'number'],
  ['metrics.tbw_percent', 'TBW (%)', 'number'],
  ['metrics.bone_mass_kg', 'Bone mass (kg)', 'number'],
  ['metrics.bmr_kj', 'BMR (kJ)', 'number'],
  ['metrics.bmr_kcal', 'BMR (kcal)', 'number'],
  ['metrics.metabolic_age', 'Metabolic age', 'number'],
  ['metrics.visceral_fat_rating', 'Visceral fat rating', 'number'],
  ['metrics.bmi', 'BMI', 'number'],
  ['metrics.ideal_body_weight_kg', 'Ideal body weight (kg)', 'number'],
  ['metrics.degree_of_obesity_percent', 'Degree of obesity (%)', 'number'],

  ['reference_ranges.fat_percent.min', 'Fat % range min', 'number'],
  ['reference_ranges.fat_percent.max', 'Fat % range max', 'number'],
  ['reference_ranges.fat_mass_kg.min', 'Fat mass range min (kg)', 'number'],
  ['reference_ranges.fat_mass_kg.max', 'Fat mass range max (kg)', 'number'],

  ['indicators.fat_percent.reading', 'Fat % indicator', 'text'],
  ['indicators.bmi.reading', 'BMI indicator', 'text'],
  ['indicators.muscle_mass.reading', 'Muscle mass indicator', 'text'],
  ['indicators.bmr.reading', 'BMR indicator', 'text'],
  ['qualitative.physique_rating', 'Physique rating', 'text'],

  ['bioelectrical.6.25_khz.r_ohm', 'R 6.25 kHz (Ω)', 'number'],
  ['bioelectrical.50_khz.r_ohm', 'R 50 kHz (Ω)', 'number'],
  ['bioelectrical.6.25_khz.x_ohm', 'X 6.25 kHz (Ω)', 'number'],
  ['bioelectrical.50_khz.x_ohm', 'X 50 kHz (Ω)', 'number'],
];

const accuniqFields = [
  ['metrics.body_water_l', 'Body water (L)', 'number'],
  ['metrics.protein_kg', 'Protein (kg)', 'number'],
  ['metrics.minerals_kg', 'Minerals (kg)', 'number'],
  ['metrics.bmr_kcal', 'BMR (kcal)', 'number'],
  ['metrics.tdee_kcal', 'TDE (kcal)', 'number'],
  ['metrics.physical_age', 'Physical age', 'number'],
  ['analysis.score', 'Analysis score', 'number'],
  ['qualitative.body_type', 'Body type', 'text'],
  ['targets.target_weight_kg', 'Target weight (kg)', 'number'],
  ['targets.weight_control_kg', 'Weight control (kg)', 'number'],
  ['targets.muscle_control_kg', 'Muscle control (kg)', 'number'],
  ['targets.fat_control_kg', 'Fat control (kg)', 'number'],
  ['reference_ranges.body_water_l.min', 'Body water range min (L)', 'number'],
  ['reference_ranges.body_water_l.max', 'Body water range max (L)', 'number'],
  ['reference_ranges.protein_kg.min', 'Protein range min (kg)', 'number'],
  ['reference_ranges.protein_kg.max', 'Protein range max (kg)', 'number'],
  ['reference_ranges.minerals_kg.min', 'Minerals range min (kg)', 'number'],
  ['reference_ranges.minerals_kg.max', 'Minerals range max (kg)', 'number'],
  ['reference_ranges.muscle_mass_kg.min', 'Muscle mass range min (kg)', 'number'],
  ['reference_ranges.muscle_mass_kg.max', 'Muscle mass range max (kg)', 'number'],
  ['reference_ranges.ffm_kg.min', 'FFM range min (kg)', 'number'],
  ['reference_ranges.ffm_kg.max', 'FFM range max (kg)', 'number'],
  ['reference_ranges.fat_mass_kg.min', 'Fat mass range min (kg)', 'number'],
  ['reference_ranges.fat_mass_kg.max', 'Fat mass range max (kg)', 'number'],
  ['reference_ranges.weight_kg.min', 'Weight range min (kg)', 'number'],
  ['reference_ranges.weight_kg.max', 'Weight range max (kg)', 'number'],
];

const indicatorKeys = ['fat_percent', 'bmi', 'muscle_mass', 'bmr'];

function pathParts(path) {
  return path
    .replace('6.25_khz', '6__25_khz')
    .split('.')
    .map((key) => key === '6__25_khz' ? '6.25_khz' : key);
}

function getPath(obj, path) {
  return pathParts(path).reduce((value, key) => value?.[key], obj);
}

function setPath(obj, path, value) {
  const parts = pathParts(path);
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts.at(-1)] = value;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[char]);
}

function sourceLabel(log) {
  const type = log?.source?.type;
  if (type === 'tanita_receipt') return 'TANITA DC-360';
  if (type === 'accuniq_report') return 'ACCUNIQ';
  if (type === 'apple_health_export') return 'Apple Health';
  return log?.source?.device || type || 'Unknown';
}

function downloadText(text, filename, type = 'application/x-ndjson') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setBusy(element, busy) {
  if (!element) return;
  element.classList.toggle('is-busy', busy);
  element.setAttribute('aria-busy', busy ? 'true' : 'false');
  if ('disabled' in element) element.disabled = busy;
  const fileInput = element.querySelector?.('input[type="file"]');
  if (fileInput) fileInput.disabled = busy;
}

function setActionStatus(selector, message = '', state = '') {
  const element = $(selector);
  if (!element) return;
  element.textContent = message;
  element.dataset.state = state;
}

function resetImportReview() {
  pendingBodyLog = null;
  pendingHealthLogs = [];
  currentPreviewCanvas = null;
  indicatorRegions = {};
  $('#body-review').hidden = true;
  $('#health-review').hidden = true;
  $('#body-preview').hidden = true;
  $('#body-preview').innerHTML = '';
  $('#detected-source').hidden = true;
  $('#detected-source').textContent = '';
  $('#ocr-notice').hidden = true;
  $('#ocr-notice').textContent = '';
  setActionStatus('#save-body-status');
  setActionStatus('#save-health-status');
}

function attachPreview(canvas) {
  currentPreviewCanvas = canvas;
  const holder = $('#body-preview');
  holder.innerHTML = '';
  holder.hidden = false;
  const clone = document.createElement('canvas');
  clone.width = canvas.width;
  clone.height = canvas.height;
  clone.getContext('2d').drawImage(canvas, 0, 0);
  holder.append(clone);
}

function fieldsForBodyLog(log) {
  const available = log.source?.type === 'accuniq_report'
    ? [...commonBodyFields, ...accuniqFields]
    : tanitaReviewFields;
  const reviewFields = log.extraction?.review_fields;
  if (!Array.isArray(reviewFields) || !reviewFields.length) return available;
  const wanted = new Set(reviewFields);
  return available.filter(([path]) => wanted.has(path));
}

function graphKeyForPath(path) {
  return path.match(/^indicators\.(fat_percent|bmi|muscle_mass|bmr)\.reading$/)?.[1] || null;
}

function findExistingUpload(log) {
  return logsCache.find((existing) => sameUploadRecord(existing, log)) || null;
}

function createStepper(input, { indicatorPath = null } = {}) {
  const shell = document.createElement('div');
  shell.className = 'input-stepper';

  const down = document.createElement('button');
  down.type = 'button';
  down.className = 'step-button';
  down.textContent = '−';
  down.setAttribute('aria-label', 'Decrease value');

  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'step-button';
  up.textContent = '+';
  up.setAttribute('aria-label', 'Increase value');

  const step = (direction) => {
    input.value = indicatorPath
      ? stepIndicatorReading(input.value, direction, indicatorPath)
      : String(decimalStep(input.value, direction, 0.1));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  down.addEventListener('click', () => step(-1));
  up.addEventListener('click', () => step(1));
  shell.append(down, input, up);
  return shell;
}

function renderBodyField(form, path, label, type) {
  const wrapper = document.createElement('div');
  wrapper.className = 'field';

  const graphKey = graphKeyForPath(path);
  if (graphKey) wrapper.classList.add('graph-field');

  const labelElement = document.createElement('label');
  labelElement.textContent = label;

  const input = document.createElement('input');
  input.dataset.path = path;
  input.dataset.valueType = type;
  input.type = type;
  if (type === 'number') {
    input.step = '0.1';
    input.inputMode = 'decimal';
  }
  input.value = getPath(pendingBodyLog, path) ?? '';
  input.dataset.originalValue = input.value;

  const control = type === 'number' || graphKey
    ? createStepper(input, { indicatorPath: graphKey ? path : null })
    : input;

  if (graphKey && currentPreviewCanvas && indicatorRegions[graphKey]) {
    const crop = cropIndicatorCanvas(currentPreviewCanvas, indicatorRegions[graphKey]);
    if (crop) {
      const cropHolder = document.createElement('div');
      cropHolder.className = 'graph-crop';
      cropHolder.append(crop);
      wrapper.append(labelElement, cropHolder, control);
    } else {
      wrapper.append(labelElement, control);
    }
  } else {
    wrapper.append(labelElement, control);
  }

  form.append(wrapper);
}

function normalizeIndicators(log, originalLog = null) {
  for (const key of indicatorKeys) {
    const indicator = log.indicators?.[key];
    const parsed = parseIndicatorReading(indicator?.reading);
    if (!indicator || !parsed) continue;

    indicator.level = parsed.level;
    indicator.section_percent = parsed.percent;
    indicator.reading = `${parsed.level}: ${parsed.percent}%`;

    const originalReading = originalLog?.indicators?.[key]?.reading;
    if (originalLog && indicator.reading !== originalReading) {
      delete indicator.position;
      delete indicator.confidence;
      delete indicator.locator;
      indicator.source = 'manual_review';
    }
  }
}

function renderBodyReview(result) {
  pendingBodyLog = deepClone(result.log);

  if (pendingBodyLog.source?.type === 'tanita_receipt' && result.previewCanvas) {
    const refined = refineTanitaIndicators(result.previewCanvas, pendingBodyLog);
    pendingBodyLog = refined.log;
    indicatorRegions = refined.regions;

    const storedVersion = findExistingUpload(pendingBodyLog);
    if (storedVersion) pendingBodyLog = preserveReviewedIndicators(pendingBodyLog, storedVersion);
  }

  $('#body-review').hidden = false;
  $('#body-raw').textContent = result.rawText;
  $('#body-source-summary').textContent = `${result.sourceLabel} · ${result.log.source?.filename || ''}`;
  $('#ocr-notice').textContent = result.ocrNotice || '';
  $('#ocr-notice').hidden = !result.ocrNotice;

  const warnings = [...(pendingBodyLog.extraction?.warnings || [])];
  const reusedReviewedIndicator = indicatorKeys.some((key) => pendingBodyLog.indicators?.[key]?.source === 'manual_review');
  if (reusedReviewedIndicator) {
    warnings.unshift('Existing reviewed TANITA graph corrections were kept for this re-upload.');
  }

  $('#body-warnings').innerHTML = warnings.length
    ? warnings.map((warning) => `<div class="warning">${escapeHtml(warning)}</div>`).join('')
    : '<p>No validation warnings. Still compare the fields with the report before saving.</p>';

  const form = $('#body-form');
  form.innerHTML = '';
  for (const [path, label, type] of fieldsForBodyLog(pendingBodyLog)) {
    renderBodyField(form, path, label, type);
  }
}

function applyBodyForm() {
  const original = deepClone(pendingBodyLog);
  const log = deepClone(pendingBodyLog);

  for (const input of $('#body-form').querySelectorAll('input[data-path]')) {
    const raw = input.value.trim();
    const value = raw === ''
      ? null
      : input.dataset.valueType === 'number'
        ? Number(raw)
        : raw;
    setPath(log, input.dataset.path, value);
  }

  normalizeIndicators(log, original);

  if (!log.measured_at_local) throw new Error('Measured at is required before saving.');
  const prefix = log.source?.type === 'accuniq_report' ? 'accuniq' : 'tanita';
  log.id = `${prefix}:${log.measured_at_local}`;

  const derivedFields = log.extraction?.derived_fields || [];
  if (derivedFields.length) log.extraction = { derived_fields: derivedFields };
  else delete log.extraction;

  return log;
}

function renderHealthReview(logs) {
  pendingHealthLogs = logs;
  if (!logs.length) {
    $('#import-status').textContent = 'Apple Health was detected, but no Traditional Strength Training workouts were found.';
    return;
  }

  const ordered = sortLogs(logs);
  const first = ordered[0]?.start_at;
  const last = ordered.at(-1)?.start_at;
  const withHr = logs.filter((item) => item.heart_rate_bpm?.average_bpm != null).length;
  const withSamples = logs.filter((item) => Array.isArray(item.heart_rate_bpm?.samples) && item.heart_rate_bpm.samples.length).length;
  const sampleCount = logs.reduce((sum, item) => sum + (Array.isArray(item.heart_rate_bpm?.samples) ? item.heart_rate_bpm.samples.length : 0), 0);

  $('#health-summary').innerHTML = `
    <p><strong>${logs.length}</strong> Traditional Strength Training workout${logs.length === 1 ? '' : 's'} found.</p>
    <p>${escapeHtml(first || '')} → ${escapeHtml(last || '')}</p>
    <p>Heart-rate summary available for ${withHr} workout${withHr === 1 ? '' : 's'}.</p>
    <p>Raw heart-rate readings: <strong>${sampleCount.toLocaleString()}</strong> across ${withSamples} workout${withSamples === 1 ? '' : 's'}.</p>
    <p class="muted compact">Re-importing a full export updates existing workout IDs instead of duplicating them.</p>`;

  $('#health-review').hidden = false;
  $('#import-status').textContent = 'Apple Health import finished. Review the summary, then save to GitHub.';
}

function summaryForLog(log) {
  if (log.kind === 'body_composition') {
    const metrics = log.metrics || {};
    return [
      metrics.weight_kg != null ? `${metrics.weight_kg} kg` : null,
      metrics.fat_percent != null ? `${metrics.fat_percent}% fat` : null,
      metrics.muscle_mass_kg != null ? `${metrics.muscle_mass_kg} kg muscle` : null,
    ].filter(Boolean).join(' · ');
  }

  if (log.kind === 'workout') {
    return [
      log.duration_minutes != null ? `${Math.round(log.duration_minutes)} min` : null,
      log.active_energy_kcal != null ? `${Math.round(log.active_energy_kcal)} kcal` : null,
      log.heart_rate_bpm?.average_bpm != null ? `${Math.round(log.heart_rate_bpm.average_bpm)} bpm avg` : null,
    ].filter(Boolean).join(' · ');
  }

  return '';
}

function renderLogs(logs) {
  logsCache = sortLogs(logs).reverse();
  $('#log-count').textContent = String(logsCache.length);

  const body = $('#logs-body');
  body.innerHTML = '';

  for (const log of logsCache) {
    const row = document.createElement('tr');
    const date = log.measured_at_local || log.start_at || '';
    const kind = log.kind === 'body_composition'
      ? 'Body composition'
      : log.kind === 'workout'
        ? 'Workout'
        : log.kind;

    row.innerHTML = `
      <td>${escapeHtml(date)}</td>
      <td>${escapeHtml(sourceLabel(log))}</td>
      <td>${escapeHtml(kind)}</td>
      <td>${escapeHtml(summaryForLog(log))}</td>`;

    const actions = document.createElement('td');
    actions.className = 'row-actions';

    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'secondary compact-button';
    view.textContent = 'View / edit';
    view.addEventListener('click', () => openRecordEditor(log));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger compact-button';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      if (!confirm('Delete this log from the private repository? Git history may still contain an earlier revision.')) return;
      setBusy(remove, true);
      $('#log-status').textContent = 'Deleting log from GitHub…';
      try {
        await deleteLog(log.id);
        logsCache = logsCache.filter((item) => item.id !== log.id);
        renderLogs(logsCache);
        await refreshLogs('Log deleted.');
      } catch (error) {
        $('#log-status').textContent = error.message;
      } finally {
        setBusy(remove, false);
      }
    });

    actions.append(view, remove);
    row.append(actions);
    body.append(row);
  }
}

async function refreshLogs(message = '') {
  $('#sync-state').textContent = 'Syncing…';
  $('#sync-state').classList.add('is-syncing');

  try {
    const logs = await getAllLogs({
      onLatest: (latest) => {
        if (latest.length || !logsCache.length) renderLogs(mergeLogs(logsCache, latest));
      },
    });
    renderLogs(logs);
    $('#sync-state').textContent = 'Synced';
    if (message) $('#log-status').textContent = message;
  } catch (error) {
    $('#sync-state').textContent = 'Sync error';
    throw error;
  } finally {
    $('#sync-state').classList.remove('is-syncing');
  }
}

function showAuthGate(message = '') {
  $('#app-shell').hidden = true;
  $('#auth-gate').hidden = false;
  $('#auth-loading').hidden = true;
  $('#token-setup').hidden = false;
  $('#auth-status').textContent = message;

  const problems = configProblems();
  $('#connect-github').disabled = problems.length > 0;
  $('#saved-token-link').classList.toggle('disabled-link', problems.length > 0);
  $('#create-token-link').classList.toggle('disabled-link', problems.length > 0);

  if (!problems.length) {
    $('#saved-token-link').href = savedTokenFileUrl(CONFIG);
    $('#create-token-link').href = fineGrainedTokenUrl(CONFIG);
  }

  $('#setup-problems').hidden = problems.length === 0;
  $('#setup-problems').innerHTML = problems
    .map((problem) => `<div class="warning">${escapeHtml(problem)}</div>`)
    .join('');
}

function showAuthLoading(message = 'Connecting to GitHub…') {
  $('#app-shell').hidden = true;
  $('#auth-gate').hidden = false;
  $('#token-setup').hidden = true;
  $('#setup-problems').hidden = true;
  $('#auth-loading').hidden = false;
  $('#auth-loading-status').textContent = message;
}

async function showApp() {
  $('#auth-gate').hidden = true;
  $('#app-shell').hidden = false;
  $('#github-user').textContent = `@${signedInUser.login}`;
  $('#repo-name').textContent = `${CONFIG.githubOwner}/${CONFIG.githubRepo}`;
  await refreshLogs();
}

async function finishGithubConnection() {
  signedInUser = await getAuthenticatedUser();
  if (!signedInUser) throw new Error('GitHub access token was not available. Paste it again.');
  const repo = await assertPrivateRepo();
  $('#repo-visibility').textContent = repo.private ? 'Private repository' : 'Public repository';
  await showApp();
}

async function connectWithToken() {
  const problems = configProblems();
  if (problems.length) {
    showAuthGate('Complete the one-time GitHub setup in config.js first.');
    return;
  }

  const token = $('#github-token').value.trim();
  if (!token) {
    $('#auth-status').textContent = 'Paste the fine-grained GitHub token first.';
    $('#github-token').focus();
    return;
  }

  const button = $('#connect-github');
  setBusy(button, true);
  $('#auth-status').textContent = 'Checking GitHub and the private data repository…';

  try {
    setAccessToken(token, { remember: $('#remember-token').checked });
    showAuthLoading();
    await finishGithubConnection();
    $('#github-token').value = '';
  } catch (error) {
    console.error(error);
    clearAuth();
    showAuthGate(error.message);
  } finally {
    setBusy(button, false);
  }
}

async function bootstrapAuth() {
  const problems = configProblems();
  if (problems.length) {
    showAuthGate('Complete the one-time GitHub setup in config.js first.');
    return;
  }

  if (!hasStoredAuth()) {
    showAuthGate('Open the saved token in your private GitHub repository, copy it, then paste it below.');
    return;
  }

  showAuthLoading();
  try {
    await finishGithubConnection();
  } catch (error) {
    console.error(error);
    if (error.code === 'AUTH_EXPIRED' || error.code === 'AUTH_REQUIRED') {
      clearAuth();
      showAuthGate(error.message);
    } else {
      showAuthLoading(error.message);
    }
  }
}

function openRecordEditor(log) {
  editingLog = deepClone(log);
  $('#record-title').textContent = `${sourceLabel(log)} · ${log.measured_at_local || log.start_at || 'record'}`;
  $('#record-status').textContent = '';

  const form = $('#record-form');
  form.innerHTML = '';

  for (const entry of recordEntries(editingLog)) {
    const field = document.createElement('div');
    field.className = 'field record-field';

    const label = document.createElement('label');
    label.textContent = entry.path;

    let input;
    if (entry.kind === 'json') {
      input = document.createElement('textarea');
      input.rows = 7;
    } else if (entry.kind === 'boolean') {
      input = document.createElement('select');
      input.innerHTML = '<option value="true">true</option><option value="false">false</option>';
    } else {
      input = document.createElement('input');
      input.type = entry.kind === 'number' ? 'number' : 'text';
      if (entry.kind === 'number') {
        input.step = '0.1';
        input.inputMode = 'decimal';
      }
    }

    input.value = entry.value;
    input.dataset.recordPath = entry.path;
    input.dataset.recordKind = entry.kind;
    if (entry.path === 'id' || entry.path === 'schema_version') input.disabled = true;

    const graphPath = graphKeyForPath(entry.path) ? entry.path : null;
    const control = (entry.kind === 'number' || graphPath) && !input.disabled
      ? createStepper(input, { indicatorPath: graphPath })
      : input;

    field.append(label, control);
    form.append(field);
  }

  $('#record-dialog').showModal();
}

async function saveRecordEditor() {
  if (!editingLog) return;
  const next = deepClone(editingLog);
  const button = $('#record-save');

  try {
    for (const input of $('#record-form').querySelectorAll('[data-record-path]')) {
      if (input.disabled) continue;
      setPath(next, input.dataset.recordPath, coerceRecordValue(input.value, input.dataset.recordKind));
    }

    normalizeIndicators(next, editingLog);

    if (next.kind === 'body_composition' && next.measured_at_local) {
      const prefix = next.source?.type === 'accuniq_report' ? 'accuniq' : 'tanita';
      next.id = `${prefix}:${next.measured_at_local}`;
    }

    setBusy(button, true);
    $('#record-status').textContent = 'Saving changes to GitHub…';
    await saveLog(next);
    if (next.id !== editingLog.id) await deleteLog(editingLog.id);

    logsCache = mergeLogs(logsCache, [next]);
    renderLogs(logsCache);
    $('#record-status').textContent = 'Saved.';
    await refreshLogs('Record updated.');
    $('#record-dialog').close();
  } catch (error) {
    $('#record-status').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
}

$('#connect-github').addEventListener('click', connectWithToken);
$('#github-token').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connectWithToken();
});

$('#auth-forget-saved').addEventListener('click', () => {
  clearAuth();
  showAuthGate('Saved token forgotten. Paste a token to reconnect.');
});

$('#signout-github').addEventListener('click', () => {
  clearAuth();
  signedInUser = null;
  resetImportReview();
  showAuthGate('GitHub token forgotten on this browser. Your repository data is unchanged.');
});

$('#sync-now').addEventListener('click', async () => {
  const button = $('#sync-now');
  setBusy(button, true);
  try {
    await refreshLogs('Synced with GitHub.');
  } catch (error) {
    $('#log-status').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});

$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  resetImportReview();
  setBusy($('#choose-file-button'), true);
  $('#import-status').textContent = 'Inspecting file…';

  try {
    const imported = await importUploadedFile(file, {
      onStatus: (message) => { $('#import-status').textContent = message; },
    });

    $('#detected-source').textContent = imported.sourceLabel;
    $('#detected-source').hidden = false;

    if (imported.category === 'body_composition') {
      attachPreview(imported.result.previewCanvas);
      renderBodyReview(imported.result);
      $('#import-status').textContent = `Detected ${imported.sourceLabel}. Review the extracted measurements, then save.`;
    } else if (imported.category === 'apple_health') {
      renderHealthReview(imported.logs);
    }

    refreshLogs().catch((error) => { $('#log-status').textContent = error.message; });
  } catch (error) {
    console.error(error);
    $('#import-status').textContent = `Could not import file: ${error.message}`;
  } finally {
    setBusy($('#choose-file-button'), false);
    event.target.value = '';
  }
});

$('#save-body').addEventListener('click', async () => {
  if (!pendingBodyLog) return;
  const button = $('#save-body');
  setBusy(button, true);
  setActionStatus('#save-body-status', 'Saving to GitHub…', 'busy');

  try {
    const log = applyBodyForm();
    const previousUpload = findExistingUpload(log);
    const written = await saveLog(log);
    if (previousUpload && previousUpload.id !== log.id) await deleteLog(previousUpload.id);

    logsCache = mergeLogs(logsCache, [log]);
    renderLogs(logsCache);

    const message = written ? `${sourceLabel(log)} saved to GitHub.` : `${sourceLabel(log)} is unchanged.`;
    setActionStatus('#save-body-status', message, 'success');
    $('#import-status').textContent = message;
    await refreshLogs(`${sourceLabel(log)} body-composition log is up to date.`);
  } catch (error) {
    setActionStatus('#save-body-status', error.message, 'error');
    $('#import-status').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});

$('#save-health').addEventListener('click', async () => {
  if (!pendingHealthLogs.length) return;
  const button = $('#save-health');
  const total = pendingHealthLogs.length;
  setBusy(button, true);
  setActionStatus('#save-health-status', `Comparing ${total} workout logs…`, 'busy');

  try {
    const written = await saveLogs(pendingHealthLogs);
    const skipped = Math.max(0, total - written);
    const message = written
      ? `Saved ${written} new/changed workout${written === 1 ? '' : 's'}${skipped ? `; ${skipped} unchanged` : ''}.`
      : `All ${total} workout${total === 1 ? '' : 's'} were unchanged.`;

    logsCache = mergeLogs(logsCache, pendingHealthLogs);
    renderLogs(logsCache);
    setActionStatus('#save-health-status', message, 'success');
    $('#import-status').textContent = message;
    await refreshLogs(message);
  } catch (error) {
    setActionStatus('#save-health-status', error.message, 'error');
    $('#import-status').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});

$('#record-save').addEventListener('click', saveRecordEditor);
$('#record-close').addEventListener('click', () => $('#record-dialog').close());

$('#export-logs').addEventListener('click', async () => {
  const button = $('#export-logs');
  setBusy(button, true);
  try {
    const text = await exportJsonl();
    if (!text) {
      $('#log-status').textContent = 'There are no logs to export.';
      return;
    }
    downloadText(text, `fitness-tracker-${new Date().toISOString().slice(0, 10)}.jsonl`);
    $('#log-status').textContent = 'JSONL export downloaded.';
  } catch (error) {
    $('#log-status').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});

$('#clear-logs').addEventListener('click', async () => {
  if (!confirm('Delete ALL tracker logs from the private repository?')) return;
  if (!confirm('This will remove every current log. Continue?')) return;

  const button = $('#clear-logs');
  setBusy(button, true);
  try {
    await clearLogs();
    logsCache = [];
    renderLogs([]);
    await refreshLogs('All logs deleted.');
  } catch (error) {
    $('#log-status').textContent = error.message;
  } finally {
    setBusy(button, false);
  }
});

await bootstrapAuth();
