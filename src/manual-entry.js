import { manualFields, fieldValue, localDateTime, buildManualMeasurement } from './manual-measurement.js';

const groups = [
  ['Body measurements', (path) => path.startsWith('metrics.')],
  ['Personal and measurement context', (path) => path.startsWith('input.')],
  ['Targets and analysis', (path) => /^(targets|analysis)\./.test(path)],
  ['Classifications and indicators', (path) => /^(qualitative|indicators)\./.test(path)],
  ['Reference ranges', (path) => path.startsWith('reference_ranges.')],
  ['Bioelectrical measurements', (path) => path.startsWith('bioelectrical.')],
];

export function createManualEntry({ onSave }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'record-dialog manual-dialog';
  dialog.id = 'manual-dialog';
  dialog.setAttribute('aria-labelledby', 'manual-title');
  dialog.innerHTML = `
    <div class="dialog-heading"><h2 id="manual-title">Manual measurement</h2><button type="button" class="secondary" id="manual-close">Cancel</button></div>
    <p id="manual-help">Enter what your system reported. All measurement fields are optional; add at least one value.</p>
    <form id="manual-form" aria-describedby="manual-help" novalidate>
      <div class="field-grid manual-context"></div>
      <div id="manual-groups"></div>
      <div class="dialog-footer"><p id="manual-status" class="status" role="status"></p><button type="submit" id="manual-save">Save measurement</button></div>
    </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form');
  const status = dialog.querySelector('#manual-status');
  const save = dialog.querySelector('#manual-save');
  const cancel = dialog.querySelector('#manual-close');
  let previous = null, draftId, saving = false;

  function field(parent, name, label, type, placeholder = '') {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';
    const caption = document.createElement('label');
    caption.textContent = label;
    const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    input.id = `manual-${name}`;
    input.name = name;
    caption.htmlFor = input.id;
    if (type !== 'textarea') input.type = type;
    else input.rows = 3;
    if (type === 'number') { input.step = 'any'; input.inputMode = 'decimal'; }
    if (type === 'datetime-local') { input.required = true; input.step = '1'; }
    if (placeholder) input.placeholder = placeholder;
    wrapper.append(caption, input);
    parent.append(wrapper);
  }
  const context = dialog.querySelector('.manual-context');
  field(context, 'measured_at_local', 'Measured at (required)', 'datetime-local');
  field(context, 'device', 'System / device', 'text', 'e.g. InBody, gym scale, clinic');
  field(context, 'manufacturer', 'Manufacturer', 'text');
  field(context, 'notes', 'Notes', 'textarea', 'Location, conditions, or other context');
  for (const [title, matches] of groups) {
    const section = document.createElement('details');
    section.open = title === 'Body measurements';
    const summary = document.createElement('summary');
    summary.textContent = title;
    const grid = document.createElement('div');
    grid.className = 'field-grid';
    for (const [path, label, type] of manualFields.filter(([path]) => matches(path))) {
      field(grid, path, label, type, path.endsWith('.reading') ? 'e.g. +: 50%' : '');
    }
    section.append(summary, grid);
    dialog.querySelector('#manual-groups').append(section);
  }
  cancel.addEventListener('click', () => { if (!saving) dialog.close(); });
  dialog.addEventListener('cancel', (event) => { if (saving) event.preventDefault(); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    try {
      const invalid = [...form.elements].find((input) => input.willValidate && !input.validity.valid);
      if (invalid) {
        const section = invalid.closest('details');
        if (section) section.open = true;
        invalid.reportValidity();
        invalid.focus();
        return;
      }
      const log = buildManualMeasurement(Object.fromEntries(new FormData(form)), { previous, draftId });
      saving = true;
      save.disabled = cancel.disabled = true;
      form.setAttribute('aria-busy', 'true');
      status.textContent = 'Saving measurement…';
      await onSave(log, previous);
      dialog.close();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      saving = false;
      save.disabled = cancel.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
  return {
    open(log = null) {
      previous = log;
      draftId = crypto.randomUUID();
      form.reset();
      status.textContent = '';
      dialog.querySelector('#manual-title').textContent = log ? 'Edit manual measurement' : 'Manual measurement';
      const values = {
        measured_at_local: log?.measured_at_local || localDateTime(),
        device: log?.source?.device || '', manufacturer: log?.source?.manufacturer || '', notes: log?.notes || '',
      };
      for (const [path] of manualFields) values[path] = fieldValue(log, path) ?? '';
      for (const [key, value] of Object.entries(values)) form.elements.namedItem(key).value = value;
      for (const section of dialog.querySelectorAll('details')) {
        section.open = section.querySelector('summary').textContent === 'Body measurements'
          || [...section.querySelectorAll('input')].some((input) => input.value !== '');
      }
      dialog.showModal();
      dialog.scrollTop = 0;
      form.elements.namedItem('measured_at_local').focus();
    },
  };
}
