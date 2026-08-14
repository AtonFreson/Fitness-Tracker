export const CONFIG = {
  githubOwner: 'AtonFreson',
  githubRepo: 'Fitness-Tracker-Data',
  githubBranch: 'main',
  dataRoot: 'data',
  googleVisionApiKey: 'AIzaSyBR6MkWky4-FW06ooQMDHIF_pBUzfSgYjc',
};

export function configProblems(config = CONFIG) {
  const problems = [];
  if (!config.githubOwner || /YOUR_|example/i.test(config.githubOwner)) problems.push('Set githubOwner in config.js.');
  if (!config.githubRepo) problems.push('Set githubRepo in config.js.');
  if (!config.githubBranch) problems.push('Set githubBranch in config.js.');
  if (!config.dataRoot) problems.push('Set dataRoot in config.js.');
  return problems;
}
