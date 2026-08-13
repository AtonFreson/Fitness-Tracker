import { CONFIG, configProblems } from './config.js';
import { importUploadedFile } from './src/import-router.js';
import {
  saveLog,
  saveLogs,
  getAllLogs,
  deleteLog,
  clearLogs,
  exportJsonl,
  parseJsonl,
  sortLogs,
  assertPrivateRepo,
} from './src/storage.js';
import {
  setAccessToken,
  clearAuth,
  getAuthenticatedUser,
  hasStoredAuth,
  fineGrainedTokenUrl,
  savedTokenFileUrl,
} from './src/github-auth.js';

const $ = (selector) => document.querySelector(selector);
let pendingBodyLog = null;
let pendingHealthLogs = [];
let signedInUser = null;

const commonBodyFields = [
  ['measured_at_local', 'Measured at', 'text'],
  ['metrics.weight_kg', 'Weight (kg)', 'number'],
  ['metrics.fat_percent', 'Body fat (%)', 'number'],
  ['metrics.fat_mass_kg', 'Fat mass (kg)', 'number'],
  ['metrics.ffm_kg', 'Fat-free mass (kg)', 'number'],
  ['metrics.muscle_mass_kg', 'Muscle mass (kg)', 'number'],
];

const tanitaFields = [
  ['input.body_type', 'Body type', 'text'],
  ['input.gender', 'Gender', 'text'],
  ['input.age', 'Age', 'number'],
  ['input.height_cm', 'Height (cm)', 'number'],
  ['input.clothes_weight_kg', 'Clothes weight (kg)', 'number'],
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
  ['qualitative.physique_rating', 'Physique rating', 'text'],
  ['bioelectrical.6.25_khz.r_ohm', 'R 6.25 kHz (Ω)', 'number'],
  ['bioelectrical.6.25_khz.x_ohm', 'X 6.25 kHz (Ω)', 'number'],
  ['bioelectrical.50_khz.r_ohm', 'R 50 kHz (Ω)', 'number'],
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

function getPath(obj, path) {
  return path.split('.').reduce((value, key) => value?.[key], obj);
}

function setPath(obj, path, value) {
  const parts = path.split('.');
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
  return String(value).replace(/[&<>'"]/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[ch]);
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
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetImportReview() {
  pendingBodyLog = null;
  pendingHealthLogs = [];
  $('#body-review').hidden = true;
  $('#health-review').hidden = true;
  $('#body-preview').hidden = true;
  $('#body-preview').innerHTML = '';
  $('#detected-source').hidden = true;
  $('#detected-source').textContent = '';
}

function attachPreview(canvas) {
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
  return [...commonBodyFields, ...(log.source?.type === 'accuniq_report' ? accuniqFields : tanitaFields)];
}

function renderBodyReview(result) {
  pendingBodyLog = deepClone(result.log);
  $('#body-review').hidden = false;
  $('#body-raw').textContent = result.rawText;
  $('#body-source-summary').textContent = `${result.sourceLabel} · ${result.log.source?.filename || ''}`;
  const warnings = pendingBodyLog.extraction?.warnings || [];
  $('#body-warnings').innerHTML = warnings.length
    ? warnings.map((w) => `<div class="warning">${escapeHtml(w)}</div>`).join('')
    : '<p>No validation warnings. Still compare the fields with the report before saving.</p>';

  const form = $('#body-form');
  form.innerHTML = '';
  for (const [path, label, type] of fieldsForBodyLog(pendingBodyLog)) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    const lab = document.createElement('label');
    lab.textContent = label;
    const input = document.createElement('input');
    input.dataset.path = path;
    input.dataset.valueType = type;
    input.type = type;
    if (type === 'number') input.step = 'any';
    input.value = getPath(pendingBodyLog, path) ?? '';
    wrapper.append(lab, input);
    form.append(wrapper);
  }
}

function applyBodyForm() {
  const log = deepClone(pendingBodyLog);
  for (const input of $('#body-form').querySelectorAll('input[data-path]')) {
    const raw = input.value.trim();
    const value = raw === '' ? null : input.dataset.valueType === 'number' ? Number(raw) : raw;
    setPath(log, input.dataset.path, value);
  }
  if (log.measured_at_local) {
    const prefix = log.source?.type === 'accuniq_report' ? 'accuniq' : 'tanita';
    log.id = `${prefix}:${log.measured_at_local}`;
  }
  log.extraction = { ...log.extraction, reviewed_by_user: true };
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
  const withHr = logs.filter((x) => x.heart_rate_bpm?.samples || x.heart_rate_bpm?.average_bpm).length;
  $('#health-summary').innerHTML = `
    <p><strong>${logs.length}</strong> Traditional Strength Training workout${logs.length === 1 ? '' : 's'} found.</p>
    <p>${escapeHtml(first || '')} → ${escapeHtml(last || '')}</p>
    <p>Heart-rate summary available for ${withHr} workout${withHr === 1 ? '' : 's'}.</p>`;
  $('#health-review').hidden = false;
  $('#import-status').textContent = 'Apple Health import finished. Review the summary, then save to GitHub.';
}

function summaryForLog(log) {
  if (log.kind === 'body_composition') {
    const m = log.metrics || {};
    return [
      m.weight_kg != null ? `${m.weight_kg} kg` : null,
      m.fat_percent != null ? `${m.fat_percent}% fat` : null,
      m.muscle_mass_kg != null ? `${m.muscle_mass_kg} kg muscle` : null,
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

async function refreshLogs(message = '') {
  $('#sync-state').textContent = 'Syncing…';
  try {
    const logs = sortLogs(await getAllLogs()).reverse();
    $('#log-count').textContent = String(logs.length);
    const body = $('#logs-body');
    body.innerHTML = '';
    for (const log of logs) {
      const tr = document.createElement('tr');
      const date = log.measured_at_local || log.start_at || '';
      const kind = log.kind === 'body_composition' ? 'Body composition' : log.kind === 'workout' ? 'Workout' : log.kind;
      tr.innerHTML = `<td>${escapeHtml(date)}</td><td>${escapeHtml(sourceLabel(log))}</td><td>${escapeHtml(kind)}</td><td>${escapeHtml(summaryForLog(log))}</td>`;
      const action = document.createElement('td');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'danger';
      button.textContent = 'Hide';
      button.addEventListener('click', async () => {
        if (!confirm('Hide this log from the tracker? The original import event stays in the private GitHub repository, so it can be recovered.')) return;
        $('#log-status').textContent = 'Saving a hide event to GitHub…';
        await deleteLog(log.id);
        await refreshLogs('Log hidden. Its original import remains recoverable in GitHub.');
      });
      action.append(button);
      tr.append(action);
      body.append(tr);
    }
    $('#sync-state').textContent = 'Synced';
    if (message) $('#log-status').textContent = message;
  } catch (error) {
    $('#sync-state').textContent = 'Sync error';
    throw error;
  }
}

function showAuthGate(message = '') {
  $('#app-shell').hidden = true;
  $('#auth-gate').hidden = false;
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
  $('#setup-problems').innerHTML = problems.map((x) => `<div class="warning">${escapeHtml(x)}</div>`).join('');
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
    showAuthGate('Paste the fine-grained GitHub token first.');
    $('#github-token').focus();
    return;
  }

  $('#connect-github').disabled = true;
  $('#auth-status').textContent = 'Checking GitHub and the private data repository…';
  try {
    setAccessToken(token, { remember: $('#remember-token').checked });
    await finishGithubConnection();
    $('#github-token').value = '';
  } catch (error) {
    console.error(error);
    clearAuth();
    showAuthGate(error.message);
  } finally {
    $('#connect-github').disabled = configProblems().length > 0;
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
  $('#auth-status').textContent = 'Connecting to GitHub…';
  try {
    await finishGithubConnection();
  } catch (error) {
    console.error(error);
    if (error.code === 'AUTH_EXPIRED' || error.code === 'AUTH_REQUIRED') clearAuth();
    showAuthGate(error.message);
  }
}

$('#connect-github').addEventListener('click', connectWithToken);
$('#github-token').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connectWithToken();
});

$('#signout-github').addEventListener('click', () => {
  clearAuth();
  signedInUser = null;
  resetImportReview();
  showAuthGate('GitHub token forgotten on this browser. Your repository data is unchanged.');
});

$('#sync-now').addEventListener('click', async () => {
  try { await refreshLogs('Synced with GitHub.'); } catch (error) { $('#log-status').textContent = error.message; }
});

$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  resetImportReview();
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
  } catch (error) {
    console.error(error);
    $('#import-status').textContent = `Could not import file: ${error.message}`;
  } finally {
    event.target.value = '';
  }
});

$('#save-body').addEventListener('click', async () => {
  if (!pendingBodyLog) return;
  try {
    const log = applyBodyForm();
    $('#import-status').textContent = 'Saving to private GitHub repository…';
    await saveLog(log);
    await refreshLogs(`${sourceLabel(log)} body-composition log saved to GitHub.`);
    $('#import-status').textContent = `${sourceLabel(log)} saved to GitHub.`;
  } catch (error) {
    $('#import-status').textContent = error.message;
  }
});

$('#save-health').addEventListener('click', async () => {
  if (!pendingHealthLogs.length) return;
  try {
    $('#import-status').textContent = `Saving ${pendingHealthLogs.length} workout logs to GitHub…`;
    await saveLogs(pendingHealthLogs);
    await refreshLogs(`${pendingHealthLogs.length} Apple Health workout log${pendingHealthLogs.length === 1 ? '' : 's'} saved to GitHub.`);
    $('#import-status').textContent = `Saved ${pendingHealthLogs.length} Apple Health workout log${pendingHealthLogs.length === 1 ? '' : 's'} to GitHub.`;
  } catch (error) {
    $('#import-status').textContent = error.message;
  }
});

$('#export-logs').addEventListener('click', async () => {
  try {
    const text = await exportJsonl();
    if (!text) { $('#log-status').textContent = 'There are no logs to export.'; return; }
    downloadText(text, `fitness-tracker-${new Date().toISOString().slice(0, 10)}.jsonl`);
    $('#log-status').textContent = 'JSONL export downloaded.';
  } catch (error) { $('#log-status').textContent = error.message; }
});

$('#import-logs').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const { logs, errors } = parseJsonl(await file.text());
    if (logs.length) await saveLogs(logs);
    await refreshLogs(`Imported ${logs.length} log${logs.length === 1 ? '' : 's'} to GitHub${errors.length ? `; ${errors.length} line${errors.length === 1 ? '' : 's'} had errors` : ''}.`);
  } catch (error) { $('#log-status').textContent = error.message; }
  finally { event.target.value = ''; }
});

$('#clear-logs').addEventListener('click', async () => {
  if (!confirm('Hide all current tracker logs? The original import events are not deleted from GitHub.')) return;
  if (!confirm('Confirm hiding all current logs.')) return;
  try {
    await clearLogs();
    await refreshLogs('Current logs hidden. Original import events remain in the repository and Git history.');
  } catch (error) { $('#log-status').textContent = error.message; }
});

await bootstrapAuth();
