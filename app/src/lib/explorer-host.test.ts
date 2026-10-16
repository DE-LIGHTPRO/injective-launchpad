import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NETWORKS } from './config.ts';
import { maskComments } from './testing/maskComments.ts';

/**
 * The explorer link has to keep its path.
 *
 * THE DEFECT. Both networks pointed at `*.explorer.injective.network`, which 301s to
 * injscan. On TESTNET that redirect discards the path: measured 16 Oct 2026,
 *
 *   testnet.explorer.injective.network/contract/inj1u35…  ->  https://testnet.injscan.com
 *   explorer.injective.network/account/inj1x33…           ->  https://injscan.com/account/inj1x33…
 *
 * so every explorer link in the product - from a launch page, from a trade, and from
 * the line `deploy.mjs` prints after creating the factory - opened the explorer's front
 * page instead. The host resolved, answered 200, and looked entirely healthy; only the
 * Location header says what happened. And the two networks did NOT fail the same way,
 * which is the part worth guarding: checking one would have cleared both.
 *
 * WHY A SOURCE GUARD. `explorer.injective.network` is the official-looking name and
 * injscan.com is a brand, so the natural instinct on any later pass is to put the
 * official one back. There is nothing locally wrong with it to notice. This cannot
 * follow a redirect - a test that reached the network would fail offline and on a
 * CI runner - so it pins the host and keeps the broken one named.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..');

test('no network links through the redirect that drops the path', () => {
  for (const net of Object.values(NETWORKS)) {
    assert.doesNotMatch(
      net.explorer,
      /explorer\.injective\.network/,
      `${net.name} links through a 301 that discards the path, so every explorer link opens the front page`,
    );
    assert.match(net.explorer, /^https:\/\/[a-z.]*injscan\.com$/, `${net.name} explorer host`);
  }
});

test('nothing else in the repo rebuilds the old explorer URL', () => {
  /*
   * The scripts print their own links rather than importing this config, so the host
   * lives in three places. Derived by scanning rather than listed, because the next
   * script to print a link is the one that would be missed.
   */
  const files = [
    ...readdirSync(join(ROOT, 'scripts'))
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => join(ROOT, 'scripts', f)),
    join(ROOT, 'app', 'src', 'lib', 'config.ts'),
  ];

  const offenders: string[] = [];
  for (const f of files) {
    /*
     * `maskComments` rather than an inline regex, and the reason is this test: written
     * with a naive `//` mask it passed while deploy.mjs and e2e-testnet.mjs were both
     * mutated back to the broken host, because `https://` starts with `//` and the mask
     * had erased the only lines it was looking at.
     */
    if (/explorer\.injective\.network/.test(maskComments(readFileSync(f, 'utf8')))) {
      offenders.push(f.slice(ROOT.length + 1));
    }
  }
  assert.deepEqual(offenders, [], 'builds an explorer link that will lose its path');
});
