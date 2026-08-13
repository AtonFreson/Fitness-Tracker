import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeToken,
  setAccessToken,
  loadAccessToken,
  clearAuth,
  hasStoredAuth,
} from '../src/github-auth.js';

test('GitHub token input is trimmed', () => {
  assert.equal(normalizeToken('  github_pat_example  '), 'github_pat_example');
});

test('access token can be kept in memory without persistent browser storage', () => {
  clearAuth();
  setAccessToken('github_pat_memory', { remember: false });
  assert.equal(loadAccessToken(), 'github_pat_memory');
  assert.equal(hasStoredAuth(), true);
  clearAuth();
  assert.equal(hasStoredAuth(), false);
});

test('fine-grained token link pre-fills only the safe GitHub fields', async () => {
  const { fineGrainedTokenUrl } = await import('../src/github-auth.js');
  const url = new URL(fineGrainedTokenUrl({
    githubOwner: 'example-user',
    githubRepo: 'Fitness-Tracker-Data',
    githubBranch: 'main',
    dataRoot: 'data',
  }));
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/settings/personal-access-tokens/new');
  assert.equal(url.searchParams.get('target_name'), 'example-user');
  assert.equal(url.searchParams.get('contents'), 'write');
  assert.equal(url.searchParams.get('expires_in'), 'none');
  assert.equal(url.searchParams.has('token'), false);
});
