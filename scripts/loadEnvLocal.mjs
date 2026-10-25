import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Loads `scripts/.env.local` into the environment, if it exists.
 *
 * ONE LOADER, BECAUSE THERE WERE TWO READERS AND ONLY ONE OF THEM READ THE FILE.
 * `deploy.mjs` had this function; `mainnet-readiness.mjs` read `process.env` and
 * nothing else. So an operator who put the addresses where `deploy.mjs` documents them
 * - and the runbook, and this file's own name - then ran the readiness check and was
 * told "No platform fee recipient address set" about a value sitting in the file three
 * lines above `INJ_MNEMONIC`. The check that exists to answer "is this configured"
 * could not see the configuration.
 *
 * That is the same defect this project keeps recording one variable over: two places
 * resolving one piece of configuration, each locally correct, disagreeing only where
 * nobody looks. The readiness script is the worse half to have wrong, because being
 * told something is missing when it is present teaches an operator to stop believing
 * it - and the next thing it reports missing will be real.
 *
 * Written out rather than taking a dependency: these scripts sign transactions, and a
 * package added for the convenience of reading a text file is one more thing with
 * access to a process that holds a seed phrase.
 *
 * Anything already in the environment wins, so a CI secret is not overwritten by a
 * file someone left behind locally.
 *
 * `onError` rather than a thrown error or a hardcoded exit, because the two callers
 * must behave differently: `deploy.mjs` dies on a loose file mode before it can touch a
 * key, and the readiness script wants to report it alongside everything else rather
 * than stop at the first problem.
 */
export function loadEnvLocal(onError = (msg, fix) => {
  console.error(`${msg}\n${fix}`);
  process.exit(1);
}) {
  const envPath = join(HERE, '.env.local');
  if (!existsSync(envPath)) return;

  /*
   * Refused if the file is group or world readable. A seed phrase sitting at 0644 is
   * readable by every process and every other account on the machine, and the usual
   * way that happens is a text editor or a copy that did not preserve the mode. The
   * fix is one chmod, so it is worth stopping for.
   */
  const mode = statSync(envPath).mode & 0o777;
  if (mode & 0o077) {
    onError(
      `scripts/.env.local is readable by others (mode ${mode.toString(8)}).`,
      'Run: chmod 600 scripts/.env.local',
    );
    return;
  }

  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    // Surrounding quotes are stripped, because a mnemonic has spaces in it and
    // everyone quotes it. Left in, the first word would carry a leading quote and
    // the derived address would simply be a different, empty account.
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * The app's `NEXT_PUBLIC_*` configuration, which is where the factory address lives.
 *
 * Separate from `loadEnvLocal` and never mode-checked, because nothing in this file
 * is a secret: `NEXT_PUBLIC_*` is inlined into the browser bundle at build time, so
 * every value in it is already published. Refusing to read it at 0644 would be
 * theatre.
 *
 * Read-only scripts need it. `verify-solvency.mjs` asks the chain what every launch
 * holds, and it cannot find a single launch without the factory address, which no
 * operator has any reason to duplicate into `scripts/.env.local`.
 *
 * `payout-keeper.mjs` still carries its own copy of both loaders. It is on a
 * fifteen-minute schedule and a break there looks exactly like an idle run, so
 * folding it in is worth doing on its own rather than as a side effect of adding a
 * read-only script.
 */
export function loadAppEnv() {
  const appPath = join(HERE, '..', 'app', '.env.local');
  if (!existsSync(appPath)) return;
  for (const line of readFileSync(appPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
