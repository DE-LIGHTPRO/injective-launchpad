import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND_NAME } from './brand.ts';

/**
 * Does any page repeat the brand the layout already appends?
 *
 * THE DEFECT THIS EXISTS FOR. `layout.tsx` sets
 * `title: { template: '%s · Vetta' }`, so a page supplies only its own name and Next
 * adds the brand. Two pages I added set `'Analytics · Vetta'` and
 * `'Claim fees · Vetta'`, which rendered as "Analytics · Vetta · Vetta" in the tab
 * and, more visibly, in every shared link preview and search result.
 *
 * It is invisible in development, because the page looks right and only the tab
 * title is wrong, and the convention is only discoverable by reading a sibling page.
 */

const APP = join(import.meta.dirname, '..', 'app');

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (e === 'page.tsx') out.push(full);
  }
  return out;
}

test('no page repeats the brand its layout already appends', () => {
  const layout = readFileSync(join(APP, 'layout.tsx'), 'utf8');
  assert.match(layout, /template:\s*`%s/, 'the title template is gone; this guard needs re-pointing');

  const offenders = pageFiles(APP)
    .filter((f) => {
      const src = readFileSync(f, 'utf8');
      // Only titles written as literals; a computed one is out of scope here.
      return [...src.matchAll(/title:\s*['"`]([^'"`]+)['"`]/g)].some(([, t]) =>
        t.includes(BRAND_NAME),
      );
    })
    .map((f) => f.replace(APP, 'app'));

  assert.deepEqual(
    offenders,
    [],
    'a page title includes the brand, which the layout template adds again',
  );
});
