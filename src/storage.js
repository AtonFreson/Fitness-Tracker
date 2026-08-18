import { CONFIG, configProblems } from '../config.js';
import { githubFetch } from './github-auth.js';

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
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToUtf8(value) {
  const binary = atob(String(value || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function logDate(log) {
  return log?.measured_at_local || log?.start_at || '';
}

function periodForLog(log) {
  return String(logDate(log)).match(/^(\d{4}-\d{2})/)?.[1] || 'unknown';
}

function dataPathForLog(log) {
  return `${dataRoot()}/events/${periodForLog(log)}.json`;
}

function sortLogs(logs) {
  return [...logs].sort((a, b) => {
    const dateCompare = String(logDate(a)).localeCompare(String(logDate(b)));
    return dateCompare || String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function normalizedFilename(log) {
  return String(log?.source?.filename || '').trim().toLowerCase();
}

function sameUploadRecord(a, b) {
  if (!a?.id || !b?.id || !a?.kind || !b?.kind) return false;
  if (a.id === b.id) return true;
  if (a.kind !== b.kind || a.kind !== 'body_composition') return false;
  const aType = String(a?.source?.type || '');
  const bType = String(b?.source?.type || '');
  const aFile = normalizedFilename(a);
  const bFile = normalizedFilename(b);
  return Boolean(aFile && bFile && aType && aType === bType && aFile === bFile);
}

function mergeLogs(existing, incoming) {
  const merged = [];
  for (const log of existing || []) if (log?.id && log?.kind) merged.push(log);
  for (const log of incoming || []) {
    if (!log?.id || !log?.kind) continue;
    for (let i = merged.length - 1; i >= 0; i -= 1) if (sameUploadRecord(merged[i], log)) merged.splice(i, 1);
    merged.push(log);
  }
  return sortLogs(merged);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function parseRecordFile(text, path = '') {
  let logs;
  try { logs = JSON.parse(text); }
  catch (error) { throw new Error(`${path || 'Data file'} is invalid JSON: ${error.message}`); }
  if (!Array.isArray(logs)) throw new Error(`${path || 'Data file'} must contain a JSON array.`);
  for (const log of logs) if (!log?.id || !log?.kind) throw new Error(`${path || 'Data file'} contains a record without id/kind.`);
  return logs;
}

async function getRepoInfo() {
  const response = await githubFetch(repoPrefix());
  if (response.status === 404) {
    const error = new Error(`Repository ${CONFIG.githubOwner}/${CONFIG.githubRepo} was not found or the token cannot access it.`);
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
  const response = await githubFetch(`${contentsPath(path)}?ref=${encodeURIComponent(CONFIG.githubBranch)}&t=${Date.now()}`, { cache: 'no-store' });
  if (response.status === 404) return { path, text: '', sha: null, exists: false };
  if (!response.ok) throw new Error(`Could not read ${path} from GitHub (${response.status}).`);
  const data = await response.json();
  if (Array.isArray(data)) throw new Error(`${path} is a directory, not a file.`);
  let text = '';
  if (data.encoding === 'base64' && data.content) text = base64ToUtf8(data.content);
  else if (data.sha) {
    const blobResponse = await githubFetch(`${repoPrefix()}/git/blobs/${encodeURIComponent(data.sha)}`, { cache: 'no-store' });
    if (!blobResponse.ok) throw new Error(`Could not read ${path} from GitHub (${blobResponse.status}).`);
    const blob = await blobResponse.json();
    if (blob.encoding !== 'base64') throw new Error(`Unsupported GitHub encoding for ${path}.`);
    text = base64ToUtf8(blob.content);
  }
  return { path, text, sha: data.sha, exists: true };
}

async function listEventFiles() {
  const root = `${dataRoot()}/events`;
  const response = await githubFetch(`${contentsPath(root)}?ref=${encodeURIComponent(CONFIG.githubBranch)}&t=${Date.now()}`, { cache: 'no-store' });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Could not list ${root} on GitHub (${response.status}).`);
  const data = await response.json();
  if (!Array.isArray(data)) return [];
  return data.filter((item) => item?.type === 'file' && /^(?:\d{4}-\d{2}|unknown)\.json$/i.test(item.name || ''))
    .map((item) => ({ path: `${root}/${item.name}`, sha: item.sha })).sort((a, b) => b.path.localeCompare(a.path));
}

async function writeRepoFile(path, text, { sha = null, message }) {
  const body = { message, content: utf8ToBase64(text), branch: CONFIG.githubBranch };
  if (sha) body.sha = sha;
  const response = await githubFetch(contentsPath(path), { method: 'PUT', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.message || ''; } catch {}
    const error = new Error(`GitHub could not save ${path} (${response.status})${detail ? `: ${detail}` : ''}.`);
    error.status = response.status;
    error.code = response.status === 409 || response.status === 422 ? 'GITHUB_WRITE_CONFLICT' : 'GITHUB_WRITE_FAILED';
    throw error;
  }
  return response.json();
}

async function deleteRepoFile(path, sha, message) {
  const response = await githubFetch(contentsPath(path), { method: 'DELETE', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, sha, branch: CONFIG.githubBranch }) });
  if (response.status === 404) return false;
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.message || ''; } catch {}
    throw new Error(`GitHub could not delete ${path} (${response.status})${detail ? `: ${detail}` : ''}.`);
  }
  return true;
}

async function readPeriod(path) {
  const file = await readRepoFile(path);
  if (!file.exists || !file.text.trim()) return { ...file, logs: [] };
  return { ...file, logs: parseRecordFile(file.text, path) };
}

async function getAllLogs({ onLatest } = {}) {
  await assertPrivateRepo();
  const files = await listEventFiles();
  if (!files.length) { onLatest?.([]); return []; }
  const latest = await readPeriod(files[0].path);
  const latestLogs = mergeLogs([], latest.logs);
  onLatest?.(latestLogs);
  if (files.length === 1) return latestLogs;
  const rest = await Promise.all(files.slice(1).map(({ path }) => readPeriod(path)));
  return mergeLogs(latestLogs, rest.flatMap((file) => file.logs));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function savePeriod(path, newLogs) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const file = await readPeriod(path);
    const merged = mergeLogs(file.logs, newLogs);
    const changed = newLogs.filter((incoming) => {
      const previous = file.logs.find((old) => sameUploadRecord(old, incoming));
      return !previous || stableJson(previous) !== stableJson(incoming);
    }).length;
    if (!changed) return 0;
    try {
      await writeRepoFile(path, `${JSON.stringify(merged, null, 2)}\n`, { sha: file.sha, message: `Update fitness logs for ${path.match(/([^/]+)\.json$/)?.[1] || 'period'}` });
      return changed;
    } catch (error) {
      lastError = error;
      if (error.code !== 'GITHUB_WRITE_CONFLICT' || attempt === 2) throw error;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastError;
}

async function saveLogs(logs) {
  const incoming = mergeLogs([], logs);
  if (!incoming.length) return 0;
  await assertPrivateRepo();
  const groups = new Map();
  for (const log of incoming) {
    const path = dataPathForLog(log);
    if (!groups.has(path)) groups.set(path, []);
    groups.get(path).push(log);
  }
  let written = 0;
  for (const [path, newLogs] of groups) written += await savePeriod(path, newLogs);
  return written;
}

async function saveLog(log) { return saveLogs([log]); }

async function deleteLog(id) {
  if (!id) return false;
  await assertPrivateRepo();
  const period = String(id).match(/(\d{4}-\d{2})/)?.[1] || null;
  const candidates = period ? [{ path: `${dataRoot()}/events/${period}.json` }] : await listEventFiles();
  let deleted = false;
  for (const { path } of candidates) {
    const file = await readPeriod(path);
    if (!file.exists) continue;
    const remaining = file.logs.filter((log) => log.id !== id);
    if (remaining.length === file.logs.length) continue;
    deleted = true;
    if (remaining.length) await writeRepoFile(path, `${JSON.stringify(sortLogs(remaining), null, 2)}\n`, { sha: file.sha, message: 'Delete fitness log' });
    else await deleteRepoFile(path, file.sha, 'Delete empty fitness log file');
  }
  return deleted;
}

async function clearLogs() {
  await assertPrivateRepo();
  const files = await listEventFiles();
  let count = 0;
  for (const { path } of files) {
    const file = await readPeriod(path);
    count += file.logs.length;
    if (file.exists) await deleteRepoFile(path, file.sha, 'Delete all fitness logs');
  }
  return count;
}

async function exportJsonl() {
  const logs = await getAllLogs();
  return logs.map((log) => JSON.stringify(log)).join('\n') + (logs.length ? '\n' : '');
}

export { saveLog, saveLogs, getAllLogs, deleteLog, clearLogs, exportJsonl, sortLogs, mergeLogs, sameUploadRecord, periodForLog, dataPathForLog, assertPrivateRepo, getRepoInfo };
