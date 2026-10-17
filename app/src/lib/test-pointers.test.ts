/**
 * A docblock that names its guard must name one that exists.
 *
 * THE DEFECT THIS EXISTS FOR. `launchLimits.ts` opened by explaining that a mirror is a
 * second copy of a fact, "so `launch-limits.test.ts` reads the Rust source and fails if
 * either value drifts". There is no such file and there never was. Six of the ten
 * mirrored figures were pinned nowhere at all.
 *
 * A pointer at nothing reads exactly like a pointer at a guard, and it reads that way to
 * the person who wrote it. Every later pass over that file saw a cited test and moved on.
 * The same docblock also cited `curve.test.mjs` for `curve.ts`; the file is
 * `curve.test.ts`. And `launchRules.ts` cited `test/launch-rules.test.ts` - the right
 * name under a directory this project does not have, a path shape borrowed from a
 * sibling repo.
 *
 * So there are two failure modes and this checks both: a name no file carries, and a real
 * name under a path that does not resolve. The second is the quieter one, because the
 * basename is right and a reader looking for the file will find it anyway.
 *
 * WHY A SOURCE GUARD. Nothing executes a comment, so no unit test can reach this. The
 * cost of the check is one directory walk; the cost of not having it was a file that
 * advertised a guard over six unguarded constants for as long as it took someone to
 * `ls` the name.
 *
 * This file is excluded from its own scan, because its prose has to be able to name the
 * dead pointers above. `the matcher sees both failure modes` covers it instead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SELF = 'test-pointers.test.ts';

/** Where prose that cites a test lives: source comments, the docs, and the top-level notes. */
const SCANNED_DIRS = ['app/src', 'scripts', 'docs'];
const SCANNED_FILES = ['README.md', 'CLAUDE.md'];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|md)$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * Every reference to a test file, with whatever path was written in front of it. The
 * leading `[\w./-]*` is deliberately greedy about separators so a wrong directory is
 * captured rather than silently trimmed down to a correct basename.
 */
const POINTER = /([\w./-]*\b[\w-]+\.test\.(?:ts|tsx|mjs|js))/g;

/** The basenames that actually exist, read once. */
const existing = new Set(
  readdirSync(join(ROOT, 'app', 'src', 'lib')).filter((f) => /\.test\.ts$/.test(f)),
);

/**
 * Names a comment is allowed to write BECAUSE they are dead. Recording a pointer that
 * went nowhere is how the next person learns not to trust one, so the prose explaining
 * the defect has to be able to say the name - which is the one case where a citation
 * should resolve to nothing.
 *
 * Two assertions below stop this becoming the place a real bad pointer gets filed away:
 * each entry must still be absent, so creating the file fails until the prose is
 * rewritten, and each must still be cited, so an entry nothing mentions is pruned
 * rather than left standing as a permanent hole in the check.
 */
const KNOWN_DEAD = ['launch-limits.test.ts'];

interface BadPointer {
  ref: string;
  why: string;
}

/** The whole check, as a function, so the mutation test below can drive it on a string. */
function badPointers(src: string, existingNames: Set<string>, resolves: (rel: string) => boolean): BadPointer[] {
  const bad: BadPointer[] = [];
  for (const [, ref] of src.matchAll(POINTER)) {
    const base = ref.slice(ref.lastIndexOf('/') + 1);
    if (!existingNames.has(base)) {
      bad.push({ ref, why: 'no file of that name exists' });
      continue;
    }
    // A bare basename is how this project cites a test; a path has to be a real one.
    if (ref.includes('/') && !resolves(ref)) {
      bad.push({ ref, why: `the basename is right but \`${ref}\` does not resolve from the repo root` });
    }
  }
  return bad;
}

test('every test file named in prose exists, at the path it is named at', () => {
  const files = [
    ...SCANNED_DIRS.flatMap((d) => walk(join(ROOT, d))),
    ...SCANNED_FILES.map((f) => join(ROOT, f)),
  ];
  assert.ok(files.length > 50, `only ${files.length} files scanned; the walk is wrong`);
  assert.ok(files.some((f) => f.endsWith('CLAUDE.md')), 'the top-level notes were not scanned');
  assert.ok(files.some((f) => f.includes('/scripts/')), 'scripts/ was not scanned');
  // The runbook is prose an operator follows on the day, so a pointer in it is the one
  // most likely to be acted on. Dropping docs/ from the walk otherwise changes nothing
  // visible, which is exactly how a narrowed sweep survives.
  assert.ok(files.some((f) => f.includes('/docs/')), 'docs/ was not scanned');
  assert.ok(existing.size > 40, `only ${existing.size} test files found; the listing is wrong`);

  const offenders: string[] = [];
  const citedDead = new Set<string>();
  for (const f of files) {
    if (f.endsWith(SELF)) continue;
    const rel = f.slice(ROOT.length + 1);
    for (const b of badPointers(readFileSync(f, 'utf8'), existing, (r) => existsSync(join(ROOT, r)))) {
      if (KNOWN_DEAD.includes(b.ref)) {
        citedDead.add(b.ref);
        continue;
      }
      offenders.push(`${rel}  cites \`${b.ref}\`: ${b.why}`);
    }
  }
  assert.deepEqual(offenders, [], 'prose citing a test that is not there:\n  ' + offenders.join('\n  '));

  for (const dead of KNOWN_DEAD) {
    assert.ok(
      !existing.has(dead),
      `\`${dead}\` is exempted as a pointer at nothing, and now exists. Rewrite the prose ` +
        'that explains it was never there, then drop it from KNOWN_DEAD.',
    );
    assert.ok(
      citedDead.has(dead),
      `nothing cites \`${dead}\` any more, so exempting it leaves a hole in this check ` +
        'for a name that could later be a real bad pointer. Drop it from KNOWN_DEAD.',
    );
  }
});

test('the matcher sees both failure modes, and does not invent a third', () => {
  const names = new Set(['curve.test.ts', 'launch-rules.test.ts']);
  const resolves = (rel: string) => rel === 'app/src/lib/launch-rules.test.ts';

  // A name nothing carries.
  assert.deepEqual(
    badPointers('see `launch-limits.test.ts` for the pin', names, resolves).map((b) => b.ref),
    ['launch-limits.test.ts'],
  );
  // The right name, wrong extension, which is a different name.
  assert.deepEqual(
    badPointers('see `curve.test.mjs`', names, resolves).map((b) => b.ref),
    ['curve.test.mjs'],
  );
  // The right name under a directory that does not exist.
  const path = badPointers('see `test/launch-rules.test.ts`', names, resolves);
  assert.equal(path.length, 1);
  assert.match(path[0].why, /does not resolve/);
  // A bare citation and a correct path both pass.
  assert.deepEqual(badPointers('`curve.test.ts` and `launch-rules.test.ts`', names, resolves), []);
  assert.deepEqual(badPointers('`app/src/lib/launch-rules.test.ts`', names, resolves), []);
  // And a URL or a glob is not a citation.
  assert.deepEqual(badPointers('https://x.test/a-b and src/lib/*.test.ts runs them', names, resolves), []);
});
