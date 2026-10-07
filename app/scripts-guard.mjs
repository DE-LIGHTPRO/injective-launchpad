/**
 * Refuse `next build` while a dev server is serving from `.next`.
 *
 * `next build` overwrites `.next`, which `next dev` is serving out of, so running
 * the two together leaves the dev server throwing on its own build output. The
 * page 500s and the stack points at `.next/server/app/<route>/page.js`, which
 * reads like a code defect and is not one.
 *
 * It cost me two debugging detours on this project. The first time I spent
 * several steps concluding a working toggle was broken; the second time a page
 * went 500 right after a green test run. Both looked like regressions in whatever
 * I had just edited.
 *
 * So the build refuses instead, and says what to do. Checked by asking the OS who
 * is listening rather than by looking for a pid file, because the dev server may
 * have been started by anything.
 */
import { execSync } from 'node:child_process';

const PORTS = [3000, 3100];

function listening(port) {
  try {
    // -t gives pids only; empty output means nothing is listening.
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    // lsof exits non-zero when nothing matches, which is the common case.
    return false;
  }
}

const busy = PORTS.filter(listening);
if (busy.length > 0) {
  console.error(
    `\nA dev server is listening on ${busy.join(', ')}.\n\n` +
      `\`next build\` overwrites .next, which \`next dev\` serves from, so building now\n` +
      `leaves that server throwing on its own output: the page 500s and the stack\n` +
      `points at .next/server/app/<route>/page.js, which looks like a code defect.\n\n` +
      `Stop the dev server first, or run \`npm run build:force\` if you know it is idle.\n`,
  );
  process.exit(1);
}
