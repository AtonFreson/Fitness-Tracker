// One-time deployment configuration.
// This file is public. Do not put a GitHub access token in this file.
export const CONFIG = {
  // GitHub account that owns the private data repository.
  githubOwner: 'AtonFreson',
  githubRepo: 'Fitness-Tracker-Data',
  githubBranch: 'main',

  // Folder used by the tracker inside the private repository.
  dataRoot: 'data',
};

export function configProblems(config = CONFIG) {
  const problems = [];
  const placeholders = /YOUR_|example/i;
  if (!config.githubOwner || placeholders.test(config.githubOwner)) problems.push('Set githubOwner in config.js.');
  if (!config.githubRepo) problems.push('Set githubRepo in config.js.');
  if (!config.githubBranch) problems.push('Set githubBranch in config.js.');
  if (!config.dataRoot) problems.push('Set dataRoot in config.js.');
  return problems;
}
