/**
 * Trigger a Git-sourced production deploy of the `injpad` Vercel project.
 *
 * Kept in the repository rather than in a scratch directory, where the first version
 * lived and did not survive a session restart. A deploy step that exists only on one
 * machine is the thing rule 62 of the sibling project is about.
 *
 * Reads the Vercel CLI's own credentials, so it needs no token of its own and nothing
 * secret is stored here.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CFG = join(homedir(), 'Library/Application Support/com.vercel.cli');
const token = JSON.parse(readFileSync(join(CFG, 'auth.json'), 'utf8')).token;
const teamId = JSON.parse(readFileSync(join(CFG, 'config.json'), 'utf8')).currentTeam;

/*
 * By repo ID, not by `{org, repo}`. The deploy API answers the name form with
 * "The provided GitHub repository can't be found" even when the project link holds
 * exactly that repository.
 */
const REPO_ID = 1403350310;

async function api(path, method = 'GET', body) {
  const url = `https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}teamId=${teamId}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return [res.status, await res.json().catch(() => ({}))];
}

const [status, dep] = await api('/v13/deployments', 'POST', {
  name: 'injpad',
  project: 'injpad',
  target: 'production',
  gitSource: { type: 'github', repoId: REPO_ID, ref: 'main' },
});
if (status >= 400) {
  console.error('deploy refused:', JSON.stringify(dep.error ?? dep));
  process.exit(1);
}
console.log(`deploy queued, commit ${(dep.meta?.githubCommitSha ?? '').slice(0, 7)}`);

for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 10_000));
  const [, list] = await api('/v6/deployments?projectId=injpad&limit=1');
  const state = list.deployments?.[0]?.state;
  if (state === 'READY') {
    console.log('READY');
    process.exit(0);
  }
  if (state === 'ERROR' || state === 'CANCELED') {
    console.error(state);
    process.exit(1);
  }
}
console.error('timed out waiting for the build');
process.exit(1);
