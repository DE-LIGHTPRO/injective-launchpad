/**
 * `.env.example` documents every variable the code reads, and nothing else.
 *
 * Both halves matter and I got both wrong by hand an hour before writing this.
 * The file documented `NEXT_PUBLIC_CHAIN_ID` and `NEXT_PUBLIC_RPC_URL`, which
 * nothing reads, and omitted `NEXT_PUBLIC_NETWORK` and `NEXT_PUBLIC_LCD_URL`,
 * which it does:
 *
 *   - a variable nothing reads advertises a switch that silently does nothing,
 *     and someone will set it and believe they changed something;
 *   - a variable the code reads and nobody wrote down is a step missing from
 *     whatever gets worked through on deployment day, which is the worst day to
 *     discover it.
 *
 * Derived from the source rather than restated, so the list cannot be wrong in
 * the way I was wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isRead, mergeReads, scanEnvReads, type EnvReads } from './testing/envScan.ts';

const APP_SRC = join(import.meta.dirname, '..');
const ROOT = join(APP_SRC, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

/*
 * THIS SCANNER USED TO MATCH DOT ACCESS ONLY, and `deploy.mjs` reads two variables as
 * `process.env[`INJ_${label.toUpperCase()}_CODE_ID`]`. So INJ_CURVE_CODE_ID and
 * INJ_FACTORY_CODE_ID were read by the code, absent from scripts/.env.example, and
 * this test - the one written to catch precisely that - passed. See testing/envScan.ts.
 */
/*
 * Shipped app code only. `lib/testing/` is scaffolding for these guards and names
 * variables in its own prose as examples, which the scanner then reports as read by
 * the app. A scan that measures its own instrument reports a defect in neither the
 * code nor the documentation.
 */
function appSource(f: string): boolean {
  return !f.endsWith('.test.ts') && !f.includes(`${sep}testing${sep}`);
}

function reads(files: string[]): EnvReads {
  return mergeReads(files.map((f) => scanEnvReads(readFileSync(f, 'utf8'))));
}

function varsRead(files: string[]): Set<string> {
  return reads(files).names;
}

function varsDocumented(file: string): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

test('the app documents exactly the variables it reads', () => {
  // This test file reads process.env nowhere, but it does contain the names in
  // prose above, so only the app's own sources are scanned.
  const files = walk(APP_SRC).filter(appSource);
  const read = varsRead(files);
  const documented = varsDocumented(join(APP_SRC, '..', '.env.example'));

  assert.ok(read.size > 0, 'no variables found; the scan is looking in the wrong place');
  assert.deepEqual(
    [...read].filter((v) => !documented.has(v)).sort(),
    [],
    'read by the code and absent from app/.env.example',
  );
  assert.deepEqual(
    [...documented].filter((v) => !read.has(v)).sort(),
    [],
    'documented in app/.env.example and read by nothing',
  );
});

test('the deploy script documents exactly the variables it reads', () => {
  // A separate surface on purpose: these carry a signing key and must never be
  // NEXT_PUBLIC_*, which would inline them into the browser bundle.
  const r = reads([join(ROOT, 'scripts', 'deploy.mjs')]);
  const documented = varsDocumented(join(ROOT, 'scripts', '.env.example'));

  assert.ok(r.names.size > 0, 'no variables found in deploy.mjs');
  assert.deepEqual([...r.names].filter((v) => !documented.has(v)).sort(), [], 'undocumented');
  assert.deepEqual(
    [...documented].filter((v) => !isRead(v, r)).sort(),
    [],
    'documented but unread',
  );
  /*
   * And the interpolated pair is documented by name, which `isRead` above cannot
   * assert on its own: it only answers whether a documented name is read, so a
   * variable that is read and written down nowhere would leave both lists empty.
   */
  for (const v of ['INJ_CURVE_CODE_ID', 'INJ_FACTORY_CODE_ID']) {
    assert.ok(isRead(v, r), `${v} is no longer read; drop it from scripts/.env.example`);
    assert.ok(documented.has(v), `${v} is read by deploy.mjs and absent from scripts/.env.example`);
  }
});

test('no secret-shaped variable is exposed to the browser', () => {
  /*
   * NEXT_PUBLIC_* is inlined into the client bundle at build time, exactly like
   * Vite's VITE_*. A key placed in one is published and cannot be rotated
   * without a rebuild. The deploy script's credentials live in their own
   * unprefixed surface for that reason, and this asserts the boundary rather
   * than trusting it.
   */
  /*
   * The boundary is the PREFIX, so that is what is asserted. Next inlines only
   * `NEXT_PUBLIC_*`; an unprefixed variable is undefined in the browser and readable
   * only by server code (route handlers, server components). This used to fail any
   * secret-shaped name read anywhere under src/, which blocked server-only credentials
   * like an Upstash token while letting `PINATA_JWT` through on its spelling alone.
   *
   * Two rules instead, each closing a real leak:
   *   1. nothing secret-shaped carries the public prefix, read or documented;
   *   2. no unprefixed variable is read from a `'use client'` file, where it would be
   *      undefined at best and a sign someone expected a secret in the browser at worst.
   */
  const secretish = /(MNEMONIC|PRIVATE_KEY|SECRET|SEED|PASSWORD|TOKEN|API_KEY|JWT)/;
  const files = walk(APP_SRC).filter(appSource);
  const documented = varsDocumented(join(APP_SRC, '..', '.env.example'));
  for (const v of [...varsRead(files), ...documented]) {
    if (v.startsWith('NEXT_PUBLIC_')) {
      assert.ok(!secretish.test(v), `${v} is inlined into the client bundle and looks like a secret`);
    }
  }
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    if (!/^\s*['"]use client['"]/.test(src)) continue;
    for (const v of varsRead([f])) {
      assert.ok(
        v.startsWith('NEXT_PUBLIC_'),
        `${v} is read in a client component (${f}); only NEXT_PUBLIC_ variables exist there`,
      );
    }
  }
  // And the credentials that do exist must not have been given the public prefix.
  for (const v of varsRead([join(ROOT, 'scripts', 'deploy.mjs')])) {
    if (secretish.test(v)) {
      assert.ok(!v.startsWith('NEXT_PUBLIC_'), `${v} would be inlined into the bundle`);
    }
  }
});
