/**
 * The mainnet runbook names every variable the mainnet path reads.
 *
 * `env-surface.test.ts` already asserts that `.env.example` documents what the code
 * reads. This is the other half, and it is the half that costs money: the runbook is
 * what somebody actually works through on launch morning, and a variable missing from
 * it is a step missing from the procedure. Sealed shipped exactly this defect twice,
 * once with seven `VITE_MAINNET_*` variables absent from its runbook and once with a
 * hostname that resolved nowhere, and both times every unit test was green because
 * every side was individually correct.
 *
 * THE SCRIPT LIST IS DERIVED FROM THE RUNBOOK, not written here. A hardcoded list
 * inside a guard only ever covers the cases already known about - that is how
 * `broadcastLaunch` escaped the refresh-after-write rule. So the rule is instead:
 * any script the runbook tells you to RUN must have all of its variables NAMED
 * somewhere in the runbook. Add a step, and the guard covers it by default.
 *
 * What this found when it was written (16 Oct 2026):
 *
 *   INJ_FACTORY_WASM_ADMIN   the deploy block omitted it while section 2 argued at
 *                            length that it should be a multisig. `deploy.mjs` dies
 *                            on mainnet without it, so following the runbook exactly
 *                            stops the deploy with a signing key already loaded.
 *   INJ_MAINNET_LCD          the readiness check's own archival override, documented
 *                            nowhere at all.
 *   BLOB_READ_WRITE_TOKEN    without it the logo drop zone silently disappears.
 *   UPSTASH_REDIS_REST_*     without them the upload limit is per instance.
 *   NEXT_PUBLIC_SITE_URL     the step about buying a domain did not mention the
 *                            variable that makes the domain take effect.
 *   NEXT_PUBLIC_DEMO         must be absent, which is a thing to check, not assume.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isRead, mergeReads, scanEnvReads, type EnvReads } from './testing/envScan.ts';

const APP_SRC = join(import.meta.dirname, '..');
const ROOT = join(APP_SRC, '..', '..');
const RUNBOOK = readFileSync(join(ROOT, 'docs', 'MAINNET-RUNBOOK.md'), 'utf8');

function readsOf(files: string[]): EnvReads {
  return mergeReads(files.map((f) => scanEnvReads(readFileSync(f, 'utf8'))));
}

/** Shipped app code only; `lib/testing/` is this guard's own scaffolding. */
function appSource(f: string): boolean {
  return !f.endsWith('.test.ts') && !f.includes(`${sep}testing${sep}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * The workflows the runbook tells you to run, and the scripts they run in turn.
 *
 * Step 10 is `gh workflow run payout.yml`, not `node scripts/payout-keeper.mjs`, so a
 * scan for `scripts/*.mjs` in the runbook never sees the keeper at all. It is the one
 * script that runs unattended against real fees, which makes it the worst one to leave
 * out of the surface guards. Derived both hops rather than listed, so a second workflow
 * is covered by adding the step.
 */
function workflowsTheRunbookRuns(): Array<{ file: string; yaml: string; scripts: string[] }> {
  return [...new Set([...RUNBOOK.matchAll(/gh workflow run ([a-z0-9-]+\.yml)/g)].map((m) => m[1]))].map(
    (file) => {
      const yaml = readFileSync(join(ROOT, '.github', 'workflows', file), 'utf8');
      return {
        file,
        yaml,
        scripts: [...new Set([...yaml.matchAll(/node scripts\/([a-z0-9-]+\.mjs)/g)].map((m) => m[1]))],
      };
    },
  );
}

test('every script the runbook runs has its variables named in the runbook', () => {
  const workflows = workflowsTheRunbookRuns();
  const viaWorkflow = workflows.flatMap((w) => w.scripts);
  assert.ok(
    viaWorkflow.length > 0,
    'no script was found behind any `gh workflow run` step; the indirect half of this guard is reading nothing',
  );

  const scripts = [
    ...new Set([
      ...[...RUNBOOK.matchAll(/scripts\/([a-z0-9-]+\.mjs)/g)].map((m) => m[1]),
      ...viaWorkflow,
    ]),
  ];
  assert.ok(
    scripts.length >= 3,
    `the runbook scan found ${scripts.length} scripts; a pattern that matches nothing makes this guard vacuous`,
  );

  const missing: string[] = [];
  for (const s of scripts) {
    for (const v of readsOf([join(ROOT, 'scripts', s)]).names) {
      if (!RUNBOOK.includes(v)) missing.push(`${v} (read by scripts/${s})`);
    }
  }
  assert.deepEqual(
    [...new Set(missing)].sort(),
    [],
    'read on the mainnet path and absent from docs/MAINNET-RUNBOOK.md',
  );
});

test('every variable a scheduled script reads is passed in by the workflow that runs it', () => {
  /*
   * Named in the runbook is not the same as reaching the process, and this is the
   * deploy.mjs command-block rule in the one place nobody is watching. A GitHub Actions
   * step sees only what its `env:` block maps: an unmapped variable is not an error, it
   * is simply absent, and `payout-keeper.mjs` defaults the network to testnet when it
   * cannot read one. A fourth variable added to the keeper would be set as a repository
   * variable by an operator following step 10, named in the runbook, passing every guard
   * here, and still unset in the run - every fifteen minutes, against real fees.
   *
   * The three shell refusals in payout.yml are hand-written and cover the three that
   * exist today; this is derived from what the script reads, so the next one is covered
   * by writing it rather than by remembering.
   */
  const workflows = workflowsTheRunbookRuns();
  assert.ok(workflows.length > 0, 'no workflow found in the runbook; this guard is vacuous');

  const missing: string[] = [];
  for (const { file, yaml, scripts } of workflows) {
    assert.ok(scripts.length > 0, `${file} runs no script; this guard is pointed at the wrong workflow`);
    for (const s of scripts) {
      const read = readsOf([join(ROOT, 'scripts', s)]).names;
      assert.ok(read.size > 0, `no variables found in scripts/${s}; the scan is looking in the wrong place`);
      for (const v of read) {
        if (!new RegExp(`^\\s+${v}:\\s*\\$\\{\\{`, 'm').test(yaml)) {
          missing.push(`${v} (read by scripts/${s}, not in the env block of ${file})`);
        }
      }
    }
  }

  assert.deepEqual(
    [...new Set(missing)].sort(),
    [],
    'the workflow runs the script without this variable, so it is unset in every scheduled run',
  );
});

test('every variable the deployed app reads is named in the runbook', () => {
  /*
   * Section 8 is "point the app at it", and it is only as complete as this list. A
   * server-only credential is the easy one to miss, because its absence degrades
   * silently: the upload route reports itself unconfigured and the create form simply
   * drops the drop zone, which looks like a design decision rather than a missing
   * variable.
   */
  const files = walk(APP_SRC).filter(appSource);
  const read = readsOf(files).names;
  assert.ok(read.size > 0, 'no variables found; the scan is looking in the wrong place');

  assert.deepEqual(
    [...read].filter((v) => !RUNBOOK.includes(v)).sort(),
    [],
    'read by the app and absent from docs/MAINNET-RUNBOOK.md',
  );
});

test('every variable the deploy refuses without is in the command you paste', () => {
  /*
   * Named somewhere in the runbook is not the same as present in the command, and the
   * difference is a deploy that stops halfway. `INJ_FACTORY_WASM_ADMIN` was discussed at
   * length in section 2 and missing from the step 7 block, so the test above was
   * satisfied by the prose: an operator reads the argument for a multisig, scrolls to
   * the command, pastes it, and `deploy.mjs` dies on a variable they had just read about
   * - with a signing key loaded, on the one morning nobody wants to be reading source.
   *
   * DERIVED FROM THE REFUSALS, not listed here. Every mainnet refusal in `deploy.mjs`
   * names its own variable in its first line, so a new one is covered by writing it.
   */
  const deploy = readFileSync(join(ROOT, 'scripts', 'deploy.mjs'), 'utf8');
  const refused = [...new Set([...deploy.matchAll(/'(INJ_[A-Z_]+) is not set/g)].map((m) => m[1]))];
  assert.ok(
    refused.length >= 4,
    `only ${refused.length} refusals found in deploy.mjs; a reworded message makes this guard vacuous rather than failing`,
  );

  const block = RUNBOOK.slice(RUNBOOK.indexOf('### 7. Deploy'));
  const command = block.slice(0, block.indexOf('node scripts/deploy.mjs'));
  assert.ok(command.length > 50, 'the step 7 command block could not be found');

  assert.deepEqual(
    refused.filter((v) => !command.includes(`${v}=`)).sort(),
    [],
    'refused by deploy.mjs on mainnet and absent from the step 7 command block',
  );

  /*
   * And the credentials must stay OUT of it. An interactive shell writes its command
   * line to ~/.zsh_history in plaintext, where a seed phrase stays indefinitely and
   * cannot be rotated. The script reads them from scripts/.env.local at mode 0600; a
   * runbook that puts one on the line undoes that entirely.
   */
  for (const secret of ['INJ_MNEMONIC', 'INJ_PRIVATE_KEY']) {
    assert.ok(
      !command.includes(`${secret}=`),
      `${secret} is on the step 7 command line, which writes it to shell history in plaintext`,
    );
  }
});

test('the runbook names no variable that nothing reads', () => {
  /*
   * The mirror of the rule above, and the reason `.env.example` has it too: a
   * variable in a procedure that nothing reads is an instruction to set something
   * with no effect, and it will be followed.
   */
  const everything = [
    ...walk(APP_SRC).filter(appSource),
    ...readdirSync(join(ROOT, 'scripts'))
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => join(ROOT, 'scripts', f)),
  ];
  const scanned = readsOf(everything);
  const read = new Set(scanned.names);
  /*
   * GitHub Actions names, which are configuration too but live in the workflow rather
   * than in `process.env`: the secret is mapped onto INJ_MNEMONIC there. Derived from
   * the workflow so this cannot drift either.
   */
  for (const m of readFileSync(join(ROOT, '.github', 'workflows', 'payout.yml'), 'utf8').matchAll(
    /secrets\.([A-Z0-9_]+)|vars\.([A-Z0-9_]+)/g,
  )) {
    read.add(m[1] ?? m[2]);
  }

  const named = [...new Set([...RUNBOOK.matchAll(/\b((?:INJ|NEXT_PUBLIC|UPSTASH|BLOB|KEEPER)_[A-Z0-9_]+)/g)].map((m) => m[1]))];
  assert.ok(named.length > 5, `only ${named.length} variables found in the runbook; the pattern is wrong`);

  assert.deepEqual(
    named.filter((v) => !read.has(v) && !isRead(v, scanned)).sort(),
    [],
    'named in docs/MAINNET-RUNBOOK.md and read by nothing',
  );
});
