/**
 * No em dashes in anything a user reads.
 *
 * A standing instruction across these projects, and this is the fourth one it
 * has drifted into: two here, one of them the label on the only button in the
 * trade panel. In the sibling repos it had reached 82 instances, and not one was
 * pinned by a test, because every single one was written to read well. That is
 * exactly why it needs a source guard rather than attention: nothing about it
 * looks wrong on the next pass.
 *
 * Comments keep theirs. The prose above the code is where reasoning lives and an
 * em dash belongs there; what a user reads is the string literals, the JSX text,
 * and whatever the deploy script prints at an operator.
 *
 * `scripts/` is scanned too. Scoping a sweep to the app is how the widest-reach
 * copy gets missed: in the sibling project it was the browser tab title, which
 * was also the og:title and so the headline on every shared link.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SCANNED = ['app/src', 'scripts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|css)$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * Blank comments while preserving offsets, so a reported line number still
 * points at the real line. Stripping them instead shifts every number below.
 */
function maskComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    // `(?<!:)` keeps the `//` in an https URL from eating the rest of the line.
    .replace(/(?<!:)\/\/[^\n]*/g, blank);
}

test('no em dash reaches a user', () => {
  const files = SCANNED.flatMap((d) => walk(join(ROOT, d)));
  assert.ok(files.length > 5, `only ${files.length} files scanned; the walk is wrong`);
  assert.ok(files.some((f) => f.includes('/scripts/')), 'scripts/ was not scanned');

  const offenders: string[] = [];
  for (const f of files) {
    if (f.endsWith('no-em-dashes.test.ts')) continue;
    maskComments(readFileSync(f, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        if (/[—–]/.test(line)) offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}  ${line.trim().slice(0, 80)}`);
      });
  }
  assert.deepEqual(offenders, [], 'em dashes in user-facing copy:\n  ' + offenders.join('\n  '));
});

test('it would still see one added beside an exempt one', () => {
  /*
   * Mutation-proofing the exemption. Too greedy a mask and this suite passes on a
   * file made entirely of em dashes, and nobody learns that for months.
   */
  const sample = [
    'const a = 1; /* an em dash — fine in prose about code */',
    'const b = 2; // and — here too',
    'const bad = "Not fine — this reaches a user";',
    'const url = "https://x.test/a—b";',
  ].join('\n');
  const masked = maskComments(sample);
  assert.ok(!/fine in prose/.test(masked), 'the block comment survived');
  assert.ok(!/here too/.test(masked), 'the line comment survived');
  assert.match(masked, /Not fine — this reaches a user/, 'a real offender was masked away');
  assert.match(masked, /x\.test\/a—b/, 'a URL was mistaken for a comment');
});
