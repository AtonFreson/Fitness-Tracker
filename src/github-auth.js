import { CONFIG, configProblems } from '../config.js';

const AUTH_KEY = 'fitness-tracker-github-token-v3';
const API_VERSION = '2026-03-10';
let memoryToken = '';



function savedTokenFileUrl(config = CONFIG) {
  const owner = encodeURIComponent(config.githubOwner || '');
  const repo = encodeURIComponent(config.githubRepo || '');
  const branch = encodeURIComponent(config.githubBranch || 'main');
  return `https://github.com/${owner}/${repo}/blob/${branch}/TRACKER_TOKEN.txt`;
}

function fineGrainedTokenUrl(config = CONFIG) {
  const params = new URLSearchParams({
    name: 'Fitness Tracker',
    description: `Private data access for ${config.githubRepo}`,
    target_name: config.githubOwner,
    expires_in: 'none',
    contents: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

function requireConfigured() {
  const problems = configProblems();
  if (problems.length) throw new Error(problems.join(' '));
}

function storageAvailable() {
  try { return Boolean(globalThis.localStorage); } catch { return false; }
}

function normalizeToken(value) {
  return String(value || '').trim();
}

function loadAccessToken() {
  if (memoryToken) return memoryToken;
  if (!storageAvailable()) return '';
  try { return normalizeToken(localStorage.getItem(AUTH_KEY)); }
  catch { return ''; }
}

function setAccessToken(token, { remember = true } = {}) {
  const clean = normalizeToken(token);
  if (!clean) throw new Error('Paste a GitHub access token first.');
  memoryToken = clean;
  if (storageAvailable()) {
    if (remember) localStorage.setItem(AUTH_KEY, clean);
    else localStorage.removeItem(AUTH_KEY);
  }
  return clean;
}

function clearAuth() {
  memoryToken = '';
  if (!storageAvailable()) return;
  try { localStorage.removeItem(AUTH_KEY); } catch { /* ignore */ }
}

function hasStoredAuth() {
  return Boolean(loadAccessToken());
}

async function ensureAccessToken() {
  const token = loadAccessToken();
  if (!token) {
    const error = new Error('Connect GitHub first.');
    error.code = 'AUTH_REQUIRED';
    throw error;
  }
  return token;
}

async function githubFetch(path, options = {}) {
  requireConfigured();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Browser fetch is unavailable.');
  const cleanOptions = { ...options };
  delete cleanOptions.fetchImpl;
  const token = await ensureAccessToken();

  const response = await fetchImpl(`https://api.github.com${path}`, {
    ...cleanOptions,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      ...(cleanOptions.headers || {}),
    },
  });

  if (response.status === 401) {
    clearAuth();
    const error = new Error('GitHub rejected the saved access token. Paste a valid token and connect again.');
    error.code = 'AUTH_EXPIRED';
    error.response = response;
    throw error;
  }
  return response;
}

async function getAuthenticatedUser() {
  if (!hasStoredAuth()) return null;
  const response = await githubFetch('/user');
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.message ? ` ${body.message}` : '';
    } catch { /* ignore */ }
    throw new Error(`GitHub connection check failed (${response.status}).${detail}`);
  }
  return response.json();
}

export {
  setAccessToken,
  loadAccessToken,
  clearAuth,
  hasStoredAuth,
  ensureAccessToken,
  getAuthenticatedUser,
  githubFetch,
  normalizeToken,
  fineGrainedTokenUrl,
  savedTokenFileUrl,
};
