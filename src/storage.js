import { CONFIG, configProblems } from '../config.js';
import { githubFetch } from './github-auth.js';

const EVENT_SCHEMA_VERSION = 1;
const MAX_LOGS_PER_EVENT = 50;
const MAX_EVENT_BYTES = 750_000;

function requireConfigured() {
  const problems = configProblems();
  if (problems.length) throw new Error(problems.join(' '));
}

function repoPrefix() {
  requireConfigured();
  return `/repos/${encodeURIComponent(CONFIG.githubOwner)}/${encodeURIComponent(CONFIG.githubRepo)}`;
}

function dataRoot() {
  return String(CONFIG.dataRoot || 'data').replace(/^\/+|\/+$/g, '');
}

function cleanPath(path) {
  return String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function contentsPath(path) {
  return `${repoPrefix()}/contents/${cleanPath(path)}`;
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUtf8(value) {
  const clean = String(value || '').replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function parseJsonl(text) {
  const logs = [];
  const errors = [];
  for (const [index, line] of String(text || '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value?.id || !value?.kind) throw new Error('missing id/kind');
      logs.push(value);
    } catch (error) {
      errors.push(`Line ${index + 1}: ${error.message}`);
    }
  }
  return { logs, errors };
}

function sortLogs(logs) {
  return [...logs].sort((a, b) => {
    const aa = a.measured_at_local || a.start_at || '';
    const bb = b.measured_at_local || b.start_at || '';
    return aa.localeCompare(bb) || String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function mergeLogs(existing, incoming) {
  const map = new Map();
  for (const log of existing || []) if (log?.id) map.set(log.id, log);
  for (const log of incoming || []) if (log?.id) map.set(log.id, log);
  return sortLogs([...map.values()]);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function changedLogs(existing, incoming) {
  const existingById = new Map((existing || []).filter((log) => log?.id).map((log) => [log.id, stableJson(log)]));
  // A full Apple Health export can contain the same deterministic workout IDs
  // every time it is exported. Collapse duplicate incoming IDs and only write
  // records whose materialized content is genuinely new or changed.
  const incomingById = new Map();
  for (const log of incoming || []) if (log?.id && log?.kind) incomingById.set(log.id, log);
  return [...incomingById.values()].filter((log) => existingById.get(log.id) !== stableJson(log));
}

function removeIdsFromEvent(event, ids) {
  const wanted = ids instanceof Set ? ids : new Set(ids || []);
  if (!event || !wanted.size) return { changed: false, empty: false, event };
  if (event.event_type === 'upsert_logs') {
    const logs = (event.logs || []).filter((log) => !wanted.has(log?.id));
    return { changed: logs.length !== (event.logs || []).length, empty: logs.length === 0, event: { ...event, logs } };
  }
  if (event.event_type === 'delete_logs') {
    const remainingIds = (event.ids || []).filter((id) => !wanted.has(id));
    return { changed: remainingIds.length !== (event.ids || []).length, empty: remainingIds.length === 0, event: { ...event, ids: remainingIds } };
  }
  return { changed: false, empty: false, event };
}

// Kept for legacy-v4 compatibility and tests. New writes use immutable event files.
function logYear(log) {
  const value = log?.start_at || log?.measured_at_local || '';
  const match = String(value).match(/^(\d{4})/);
  return match ? match[1] : 'unknown';
}

function dataPathForLog(log) {
  const root = dataRoot();
  if (log?.kind === 'body_composition') return `${root}/body-composition.jsonl`;
  if (log?.kind === 'workout') return `${root}/workouts/${logYear(log)}.jsonl`;
  return `${root}/other.jsonl`;
}

function safeTimestamp(iso) {
  return String(iso).replace(/[-:]/g, '').replace('.', '');
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function eventPathForTimestamp(createdAt, id = randomId()) {
  const year = String(createdAt).match(/^(\d{4})/)?.[1] || 'unknown';
  return `${dataRoot()}/events/${year}/${safeTimestamp(createdAt)}_${id}.json`;
}

function createUpsertEvent(logs, createdAt = new Date().toISOString()) {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    event_type: 'upsert_logs',
    created_at: createdAt,
    logs: (logs || []).filter((log) => log?.id && log?.kind),
  };
}

function createDeleteEvent(ids, createdAt = new Date().toISOString()) {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    event_type: 'delete_logs',
    created_at: createdAt,
    ids: [...new Set((ids || []).filter(Boolean))],
  };
}

function validateEvent(event, path = '') {
  if (!event || event.schema_version !== EVENT_SCHEMA_VERSION || !event.event_type || !event.created_at) {
    throw new Error(`${path || 'Event file'} is not a supported tracker event.`);
  }
  if (event.event_type === 'upsert_logs' && !Array.isArray(event.logs)) {
    throw new Error(`${path || 'Event file'} is missing its logs array.`);
  }
  if (event.event_type === 'delete_logs' && !Array.isArray(event.ids)) {
    throw new Error(`${path || 'Event file'} is missing its ids array.`);
  }
  return event;
}

function applyEvents(baseLogs, events) {
  const map = new Map();
  for (const log of baseLogs || []) if (log?.id) map.set(log.id, log);
  const ordered = [...(events || [])].sort((a, b) => {
    const at = String(a.event?.created_at || '');
    const bt = String(b.event?.created_at || '');
    return at.localeCompare(bt) || String(a.path || '').localeCompare(String(b.path || ''));
  });
  for (const { event } of ordered) {
    if (event.event_type === 'upsert_logs') {
      for (const log of event.logs) if (log?.id && log?.kind) map.set(log.id, log);
    } else if (event.event_type === 'delete_logs') {
      for (const id of event.ids) map.delete(id);
    }
  }
  return sortLogs([...map.values()]);
}

async function getRepoInfo() {
  const response = await githubFetch(repoPrefix());
  if (response.status === 404) {
    const error = new Error(`Repository ${CONFIG.githubOwner}/${CONFIG.githubRepo} was not found. Make sure it exists, is private, and the access token is allowed to use it.`);
    error.code = 'REPO_NOT_ACCESSIBLE';
    throw error;
  }
  if (!response.ok) throw new Error(`Could not access the configured GitHub repository (${response.status}).`);
  return response.json();
}

async function assertPrivateRepo() {
  const repo = await getRepoInfo();
  if (!repo.private) {
    const error = new Error(`The configured data repository ${repo.full_name} is public. Make it private before saving fitness data.`);
    error.code = 'PUBLIC_DATA_REPO';
    throw error;
  }
  return repo;
}

async function readRepoFile(path) {
  const response = await githubFetch(`${contentsPath(path)}?ref=${encodeURIComponent(CONFIG.githubBranch)}`);
  if (response.status === 404) return { path, text: '', sha: null, exists: false };
  if (!response.ok) throw new Error(`Could not read ${path} from GitHub (${response.status}).`);
  const data = await response.json();
  if (Array.isArray(data)) throw new Error(`${path} is a directory, not a file.`);
  let text = '';
  if (data.encoding === 'base64' && data.content) {
    text = base64ToUtf8(data.content);
  } else if (data.sha) {
    const blobResponse = await githubFetch(`${repoPrefix()}/git/blobs/${encodeURIComponent(data.sha)}`);
    if (!blobResponse.ok) throw new Error(`Could not read Git blob for ${path} (${blobResponse.status}).`);
    const blob = await blobResponse.json();
    if (blob.encoding !== 'base64') throw new Error(`Unsupported GitHub encoding for ${path}.`);
    text = base64ToUtf8(blob.content);
  }
  return { path, text, sha: data.sha, exists: true };
}

async function listRepoDirectory(path) {
  const response = await githubFetch(`${contentsPath(path)}?ref=${encodeURIComponent(CONFIG.githubBranch)}`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Could not list ${path} on GitHub (${response.status}).`);
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

async function writeNewRepoFile(path, text, message) {
  const response = await githubFetch(contentsPath(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(text),
      branch: CONFIG.githubBranch,
    }),
  });
  if (response.status === 409 || response.status === 422) {
    const error = new Error(`GitHub could not create ${path} because the path already exists or the branch changed.`);
    error.code = 'CREATE_CONFLICT';
    throw error;
  }
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.message || ''; } catch {}
    throw new Error(`GitHub could not save ${path} (${response.status})${detail ? `: ${detail}` : ''}.`);
  }
  return response.json();
}


async function updateRepoFile(path, text, sha, message) {
  const response = await githubFetch(contentsPath(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(text),
      sha,
      branch: CONFIG.githubBranch,
    }),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.message || ''; } catch {}
    throw new Error(`GitHub could not update ${path} (${response.status})${detail ? `: ${detail}` : ''}.`);
  }
  return response.json();
}

async function deleteRepoFile(path, sha, message) {
  const response = await githubFetch(contentsPath(path), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha, branch: CONFIG.githubBranch }),
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.message || ''; } catch {}
    throw new Error(`GitHub could not delete ${path} (${response.status})${detail ? `: ${detail}` : ''}.`);
  }
  return true;
}

async function appendEvent(event, message) {
  validateEvent(event);
  const text = `${JSON.stringify(event, null, 2)}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const path = eventPathForTimestamp(event.created_at, randomId());
    try {
      await writeNewRepoFile(path, text, message);
      return path;
    } catch (error) {
      if (error.code !== 'CREATE_CONFLICT' || attempt === 2) throw error;
    }
  }
  throw new Error('Could not allocate a new event file.');
}

async function eventPaths() {
  const root = `${dataRoot()}/events`;
  const top = await listRepoDirectory(root);
  const paths = [];
  for (const item of top) {
    if (item?.type === 'file' && /\.json$/i.test(item.name || '')) paths.push(`${root}/${item.name}`);
    if (item?.type === 'dir') {
      const children = await listRepoDirectory(`${root}/${item.name}`);
      for (const child of children) {
        if (child?.type === 'file' && /\.json$/i.test(child.name || '')) paths.push(`${root}/${item.name}/${child.name}`);
      }
    }
  }
  return paths.sort();
}

async function readEvents() {
  const paths = await eventPaths();
  const events = [];
  for (const path of paths) {
    const file = await readRepoFile(path);
    if (!file.exists || !file.text.trim()) continue;
    let event;
    try { event = JSON.parse(file.text); }
    catch (error) { throw new Error(`${path} is invalid JSON: ${error.message}`); }
    events.push({ path, sha: file.sha, event: validateEvent(event, path) });
  }
  return events;
}

async function legacyDataPaths() {
  const root = dataRoot();
  const paths = [`${root}/body-composition.jsonl`, `${root}/other.jsonl`];
  const workouts = await listRepoDirectory(`${root}/workouts`);
  for (const item of workouts) {
    if (item?.type === 'file' && /\.jsonl$/i.test(item.name || '')) paths.push(`${root}/workouts/${item.name}`);
  }
  return paths;
}

async function readLegacyLogs() {
  const paths = await legacyDataPaths();
  const all = [];
  for (const path of paths) {
    const file = await readRepoFile(path);
    if (!file.exists || !file.text.trim()) continue;
    const parsed = parseJsonl(file.text);
    if (parsed.errors.length) {
      throw new Error(`${path} contains ${parsed.errors.length} invalid JSONL line${parsed.errors.length === 1 ? '' : 's'}.`);
    }
    all.push(...parsed.logs);
  }
  return mergeLogs([], all);
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function logBatches(values) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  const encoder = new TextEncoder();
  for (const value of values || []) {
    const bytes = encoder.encode(JSON.stringify(value)).length + 2;
    if (current.length && (current.length >= MAX_LOGS_PER_EVENT || currentBytes + bytes > MAX_EVENT_BYTES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(value);
    currentBytes += bytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function getAllLogs() {
  await assertPrivateRepo();
  const [legacy, events] = await Promise.all([readLegacyLogs(), readEvents()]);
  return applyEvents(legacy, events);
}

async function saveLogs(logs) {
  const valid = (logs || []).filter((log) => log?.id && log?.kind);
  if (!valid.length) return 0;
  const existing = await getAllLogs();
  const changed = changedLogs(existing, valid);
  if (!changed.length) return 0;
  for (const batch of logBatches(changed)) {
    const event = createUpsertEvent(batch);
    await appendEvent(event, `Add/update fitness progress logs (${batch.length} record${batch.length === 1 ? '' : 's'})`);
  }
  return changed.length;
}

async function saveLog(log) {
  return saveLogs([log]);
}

function filterLegacyJsonl(text, ids) {
  const wanted = ids instanceof Set ? ids : new Set(ids || []);
  let removed = 0;
  const kept = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value?.id && wanted.has(value.id)) {
        removed += 1;
        continue;
      }
    } catch {
      // Do not destroy an unrelated malformed legacy line while deleting a log.
    }
    kept.push(line);
  }
  return { removed, text: kept.length ? `${kept.join('\n')}\n` : '' };
}

async function purgeLogs(ids) {
  const wanted = new Set((ids || []).filter(Boolean));
  if (!wanted.size) return 0;
  await assertPrivateRepo();

  const events = await readEvents();
  let touched = 0;
  for (const item of events) {
    const result = removeIdsFromEvent(item.event, wanted);
    if (!result.changed) continue;
    touched += 1;
    if (result.empty) {
      await deleteRepoFile(item.path, item.sha, `Permanently delete fitness log data (${wanted.size} requested id${wanted.size === 1 ? '' : 's'})`);
    } else {
      await updateRepoFile(item.path, `${JSON.stringify(result.event, null, 2)}\n`, item.sha, `Remove fitness log data (${wanted.size} requested id${wanted.size === 1 ? '' : 's'})`);
    }
  }

  for (const path of await legacyDataPaths()) {
    const file = await readRepoFile(path);
    if (!file.exists || !file.text.trim()) continue;
    const filtered = filterLegacyJsonl(file.text, wanted);
    if (!filtered.removed) continue;
    touched += 1;
    if (!filtered.text) {
      await deleteRepoFile(path, file.sha, `Permanently delete legacy fitness log data (${wanted.size} requested id${wanted.size === 1 ? '' : 's'})`);
    } else {
      await updateRepoFile(path, filtered.text, file.sha, `Remove legacy fitness log data (${wanted.size} requested id${wanted.size === 1 ? '' : 's'})`);
    }
  }
  return touched;
}

async function deleteLog(id) {
  if (!id) return false;
  await purgeLogs([id]);
  return true;
}

async function clearLogs() {
  const logs = await getAllLogs();
  if (!logs.length) return 0;
  await purgeLogs(logs.map((log) => log.id));
  return logs.length;
}

async function exportJsonl() {
  const logs = sortLogs(await getAllLogs());
  return logs.map((log) => JSON.stringify(log)).join('\n') + (logs.length ? '\n' : '');
}

export {
  saveLog,
  saveLogs,
  getAllLogs,
  deleteLog,
  clearLogs,
  exportJsonl,
  parseJsonl,
  sortLogs,
  mergeLogs,
  changedLogs,
  removeIdsFromEvent,
  dataPathForLog,
  eventPathForTimestamp,
  createUpsertEvent,
  createDeleteEvent,
  applyEvents,
  assertPrivateRepo,
  getRepoInfo,
};
