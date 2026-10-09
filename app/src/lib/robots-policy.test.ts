/**
 * The two signals a crawler reads must come from one value.
 *
 * A sibling project served HTML carrying the comment "keep out of search indexes until
 * the mainnet launch review clears" with no robots tag under it and a 404 at
 * /robots.txt. An external reviewer read the comment and reported an intent nobody had
 * implemented. The fix there, and the rule here, is that the robots rule is DERIVED from
 * the same variable that puts the demo banner on the page, so the two cannot disagree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src/app/robots.ts'), 'utf8');

test('the robots rule is driven by the demo flag, not by a literal', () => {
  /*
   * Source-read rather than executed, because `isDemoMode` reads `process.env` at
   * module scope through Next's inlining and a unit test would be asserting against
   * whatever the runner's environment happens to be, which is not what ships.
   */
  assert.match(SRC, /isDemoMode\(\)/, 'robots.ts does not consult the demo flag');
  /*
   * The import as well as the call. The first version of this test checked only that
   * `isDemoMode()` appeared, and passed on a file importing it from the wrong module:
   * `tsc` caught that, not this. A source-reading guard cannot see a broken import, so
   * where it is cheap to pin the import too, pin it.
   */
  assert.match(SRC, /from '@\/lib\/demo'/, 'isDemoMode is imported from the wrong module');
  assert.match(SRC, /disallow: '\/'/, 'a demo build does not disallow crawling');
  assert.match(SRC, /allow: '\/'/, 'a real build never allows crawling');
});

test('the demo banner and the robots rule read the same flag', () => {
  // If these ever diverge, the site can show the banner while inviting indexing, or
  // hide from search while claiming to be live. One value, both signals.
  const banner = readFileSync(join(process.cwd(), 'src/components/DemoBanner.tsx'), 'utf8');
  assert.match(banner, /isDemoMode/, 'the banner no longer reads the demo flag');
});
