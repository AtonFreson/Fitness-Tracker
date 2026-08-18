import {
  readableFieldLabel,
  recordEditorPathVisible,
  sortLogViewItems,
  logViewItemVisible,
} from './record-view.js?v=1';
import { recoverTextFields, shouldUseRecoveredText } from './text-field-repair.js?v=1';

const $ = (selector) => document.querySelector(selector);
const VIEW_KEY = 'fitness-tracker-log-view-v1';
const defaultView = {
  sort: 'date-desc',
  search: '',
  showBody: true,
  showWorkout: true,
  showTanita: true,
  showAccuniq: true,
  showAppleHealth: true,
};

function loadView() {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
    return { ...defaultView, ...saved };
  } catch {
    return { ...defaultView };
  }
}

function saveView(view) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {}
}

let viewState = loadView();
let logObserver = null;
let logViewApplying = false;
let bodyReviewRepairing = false;

function numberFromSummary(summary, pattern) {
  const match = String(summary || '').match(pattern);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) ? value : null;
}

function rowViewItem(row) {
  const cells = [...row.cells];
  const date = cells[0]?.textContent?.trim() || '';
  const source = cells[1]?.textContent?.trim() || '';
  const type = cells[2]?.textContent?.trim() || '';
  const summary = cells[3]?.textContent?.trim() || '';
  return {
    row,
    date,
    source,
    type,
    summary,
    durationMinutes: numberFromSummary(summary, /([\d.]+)\s*min\b/i),
    activeEnergyKcal: numberFromSummary(summary, /([\d.]+)\s*kcal\b/i),
    weightKg: type === 'Body composition' ? numberFromSummary(summary, /([\d.]+)\s*kg\b/i) : null,
    fatPercent: numberFromSummary(summary, /([\d.]+)%\s*fat\b/i),
    averageBpm: numberFromSummary(summary, /([\d.]+)\s*bpm\s*avg\b/i),
    searchText: `${date} ${source} ${type} ${summary}`,
  };
}

function applyLogView() {
  if (logViewApplying) return;
  const body = $('#logs-body');
  if (!body) return;

  logViewApplying = true;
  logObserver?.disconnect();
  try {
    const items = [...body.querySelectorAll(':scope > tr')].map(rowViewItem);
    const ordered = sortLogViewItems(items, viewState.sort);
    let visible = 0;

    for (const item of ordered) {
      body.append(item.row);
      const show = logViewItemVisible(item, viewState);
      item.row.hidden = !show;
      if (show) visible += 1;
    }

    const count = $('#log-count');
    if (count) count.textContent = visible === items.length ? String(items.length) : `${visible} / ${items.length}`;
  } finally {
    logObserver?.observe(body, { childList: true });
    logViewApplying = false;
  }
}

function createLogControls() {
  if ($('#log-view-controls')) return;
  const logsCard = $('#logs-card');
  const actions = logsCard?.querySelector('.actions.wrap');
  if (!logsCard || !actions) return;

  const controls = document.createElement('div');
  controls.id = 'log-view-controls';
  controls.className = 'log-view-controls';
  controls.innerHTML = `
    <label class="log-control"><span>Sort</span>
      <select id="log-sort">
        <option value="date-desc">Newest first</option><option value="date-asc">Oldest first</option>
        <option value="type-asc">Type</option><option value="source-asc">Source</option>
        <option value="duration-desc">Workout length · longest</option><option value="duration-asc">Workout length · shortest</option>
        <option value="energy-desc">Active energy · highest</option><option value="energy-asc">Active energy · lowest</option>
        <option value="weight-desc">Weight · highest</option><option value="weight-asc">Weight · lowest</option>
        <option value="fat-desc">Body fat · highest</option><option value="fat-asc">Body fat · lowest</option>
        <option value="hr-desc">Average heart rate · highest</option><option value="hr-asc">Average heart rate · lowest</option>
      </select>
    </label>
    <label class="log-control log-search"><span>Find</span><input id="log-search" type="search" placeholder="Date, source, summary…"></label>
    <details class="log-visibility"><summary>Show / hide</summary>
      <div class="log-filter-grid">
        <label><input type="checkbox" data-view-key="showBody"> Body composition</label>
        <label><input type="checkbox" data-view-key="showWorkout"> Workouts</label>
        <label><input type="checkbox" data-view-key="showTanita"> TANITA</label>
        <label><input type="checkbox" data-view-key="showAccuniq"> ACCUNIQ</label>
        <label><input type="checkbox" data-view-key="showAppleHealth"> Apple Health</label>
      </div>
    </details>
    <button id="log-view-reset" type="button" class="secondary compact-button">Reset view</button>`;

  actions.insertAdjacentElement('afterend', controls);

  const sort = $('#log-sort');
  const search = $('#log-search');
  sort.value = viewState.sort;
  search.value = viewState.search;
  for (const checkbox of controls.querySelectorAll('input[data-view-key]')) {
    checkbox.checked = viewState[checkbox.dataset.viewKey] !== false;
  }

  sort.addEventListener('change', () => {
    viewState.sort = sort.value;
    saveView(viewState);
    applyLogView();
  });
  search.addEventListener('input', () => {
    viewState.search = search.value;
    saveView(viewState);
    applyLogView();
  });
  for (const checkbox of controls.querySelectorAll('input[data-view-key]')) {
    checkbox.addEventListener('change', () => {
      viewState[checkbox.dataset.viewKey] = checkbox.checked;
      saveView(viewState);
      applyLogView();
    });
  }
  $('#log-view-reset').addEventListener('click', () => {
    viewState = { ...defaultView };
    sort.value = viewState.sort;
    search.value = '';
    for (const checkbox of controls.querySelectorAll('input[data-view-key]')) checkbox.checked = true;
    saveView(viewState);
    applyLogView();
  });
}

function enhanceRecordEditor() {
  const form = $('#record-form');
  if (!form) return;
  for (const field of form.querySelectorAll('.record-field')) {
    const input = field.querySelector('[data-record-path]');
    if (!input) continue;
    const path = input.dataset.recordPath;
    const label = field.querySelector('label');
    if (label) label.textContent = readableFieldLabel(path);
    field.hidden = !recordEditorPathVisible(path);
    field.classList.toggle('record-graph-reading', /^indicators\..+\.reading$/.test(path));
  }
}

function fieldForPath(form, path) {
  return [...form.querySelectorAll('.field')].find((field) => field.querySelector('[data-path]')?.dataset.path === path) || null;
}

function inputForPath(form, path) {
  return [...form.querySelectorAll('input[data-path]')].find((input) => input.dataset.path === path) || null;
}

function markBodyFieldLayout(form) {
  for (const field of form.querySelectorAll('.field')) {
    const path = field.querySelector('[data-path]')?.dataset.path || '';
    field.classList.toggle('physique-field', path === 'qualitative.physique_rating');
    field.classList.toggle('bioelectrical-field', path.startsWith('bioelectrical.'));
  }
}

function insertRecoveredField(form, spec) {
  const field = document.createElement('div');
  field.className = 'field recovered-text-field';
  const label = document.createElement('label');
  label.textContent = spec.label;
  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.path = spec.path;
  input.dataset.valueType = 'text';
  input.value = spec.value;
  input.dataset.recoveredText = 'true';
  field.append(label, input);

  if (spec.path === 'qualitative.physique_rating') {
    field.classList.add('physique-field');
    const bioField = [...form.querySelectorAll('.field')].find((item) => item.querySelector('[data-path^="bioelectrical."]'));
    form.insertBefore(field, bioField || null);
  } else if (spec.path === 'input.body_type') {
    const next = fieldForPath(form, 'input.gender') || fieldForPath(form, 'input.age') || form.firstElementChild;
    form.insertBefore(field, next || null);
  } else if (spec.path === 'input.gender') {
    const next = fieldForPath(form, 'input.age') || form.firstElementChild;
    form.insertBefore(field, next || null);
  } else {
    form.append(field);
  }
}

function enhanceBodyReviewText() {
  if (bodyReviewRepairing) return;
  const form = $('#body-form');
  const raw = $('#body-raw')?.textContent || '';
  const sourceHint = $('#body-source-summary')?.textContent || '';
  if (!form || !raw || !sourceHint) return;

  bodyReviewRepairing = true;
  try {
    markBodyFieldLayout(form);
    for (const spec of recoverTextFields(raw, sourceHint)) {
      const input = inputForPath(form, spec.path);
      if (!input) {
        insertRecoveredField(form, spec);
        continue;
      }
      if (input.dataset.recoveredText === 'true') continue;
      if (shouldUseRecoveredText(input.value, spec.value)) input.value = spec.value;
      input.dataset.recoveredText = 'true';
    }
    markBodyFieldLayout(form);
  } finally {
    bodyReviewRepairing = false;
  }
}

function boot() {
  createLogControls();

  const logsBody = $('#logs-body');
  if (logsBody) {
    logObserver = new MutationObserver(() => queueMicrotask(applyLogView));
    logObserver.observe(logsBody, { childList: true });
    applyLogView();
  }

  const recordForm = $('#record-form');
  if (recordForm) {
    new MutationObserver(() => queueMicrotask(enhanceRecordEditor)).observe(recordForm, { childList: true, subtree: true });
    enhanceRecordEditor();
  }

  const bodyForm = $('#body-form');
  if (bodyForm) {
    new MutationObserver(() => queueMicrotask(enhanceBodyReviewText)).observe(bodyForm, { childList: true, subtree: true });
    enhanceBodyReviewText();
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
