/**
 * A hook body must not read a value declared below it.
 *
 * `CreateLaunch` computed `plan` above `builtRules` and `devBuy`, which it reads. Once a
 * wallet was connected the body ran, hit the temporal dead zone, and the try/catch
 * turned "Cannot access 'builtRules' before initialization" into a form error, so the
 * create flow could never reach signing. `tsc` does not flag a read inside a closure
 * that runs during render, and these tests cannot render React, so the ordering is
 * checked on the source: for every `const x = useMemo/useCallback(...)`, no identifier
 * declared by a LATER top-level `const` of the component may appear in its body or deps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', 'components');

/** Comments blanked to spaces, so prose naming a variable is not a read of it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** The source of a call from its opening parenthesis to the matching close. */
function callExtent(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

function hookBlocks(src: string) {
  // Top-level component consts are indented two spaces.
  const decl = /^ {2}const (?:\[([A-Za-z0-9_]+)[^\]]*\]|([A-Za-z0-9_]+))(?::[^=]+)? = (useMemo|useCallback)?/gm;
  const out: Array<{ name: string; kind: string; body: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src))) {
    const name = m[1] ?? m[2];
    const kind = m[3] ?? '';
    const body = kind ? callExtent(src, src.indexOf('(', m.index + m[0].length - 1)) : '';
    out.push({ name, kind, body });
  }
  return out;
}

test('no useMemo or useCallback reads a hook value declared below it', () => {
  const offenders: string[] = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.tsx'))) {
    const src = stripComments(readFileSync(join(DIR, f), 'utf8'));
    const blocks = hookBlocks(src);
    blocks.forEach((b, i) => {
      if (!b.kind) return;
      for (const later of blocks.slice(i + 1)) {
        // Not after a dot: `arr.sort(` is a method, not the `sort` state.
        if (new RegExp(`(?<![.\\w])${later.name}\\b`).test(b.body)) {
          offenders.push(`${f}: ${b.name} reads ${later.name}, declared later`);
        }
      }
    });
  }
  assert.deepEqual(offenders, []);
});
