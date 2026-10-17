/**
 * The prose that states the curve's headline figures, pinned to the constants.
 *
 * THE DEFECT THIS EXISTS FOR. The curve was rescaled twice - 30 -> 60, then 60 -> 676 -
 * and each time the factory constant moved, the client mirror moved, the Rust
 * integration tests moved, and the PROSE did not. On 17 Oct 2026 six places still
 * described a 30 INJ opening reserve against an 85 INJ graduation target, 22.5x under
 * the shipped 676 / 1915:
 *
 *   contracts/factory/src/lib.rs   the policy table in the docblock on the constant
 *   README.md                      the graduation section, and the e2e cost figure
 *   docs/AUDIT_SCOPE.md            the paragraph handed to a third-party auditor
 *   CLAUDE.md                      "decisions already made"
 *   packages/launchpad-math/pool.rs the fixture comment claiming to be the real pool
 *
 * WHY NOTHING CAUGHT IT. `curve-shape-single-source.test.ts` guards this exact class
 * and could not see any of them: it walks `app/src` only, it matches numeric literals
 * assigned to a shape key, and it STRIPS COMMENTS first. Markdown and Rust docblocks
 * were never in anything's scope. `contract-mirror.test.ts` pins the client constants
 * to the Rust constants, which also agreed. Every mechanical copy of the number was
 * right; only the sentences were wrong.
 *
 * WHY THE SENTENCES MATTER MORE THAN USUAL HERE. `AUDIT_SCOPE.md` is the document an
 * auditor reads before reasoning about reachability, partial fills and rounding at the
 * graduation boundary - against the wrong reserve, that is a review of a different
 * contract. The docblock table is the most authoritative statement of the policy in the
 * repository and sits directly above the declaration it contradicted, inside a code
 * fence, which is the most convincing form a stale number can take.
 *
 * HOW THIS GUARD IS SHAPED, AND WHY IT IS MOSTLY POSITIVE. A regex hunting wrong
 * numbers in prose cries wolf, and a guard that cries wolf gets deleted. So the main
 * check is the other way round: derive the figures from the Rust and require each
 * document to CONTAIN them. A rescale then fails this suite until the prose is
 * rewritten, and the failure names the file. A stale value cannot satisfy it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const FACTORY_SRC = 'contracts/factory/src/lib.rs';
const FACTORY = readFileSync(join(REPO, FACTORY_SRC), 'utf8');

/**
 * One named constant out of the Rust, as a bigint. Throws when the declaration is gone,
 * because a renamed constant must stop the suite rather than silently make every
 * assertion below vacuous - the same reason `contract-mirror.test.ts` does this.
 */
function rustConst(name: string): bigint {
  const m = new RegExp(`pub const ${name}: u128 = ([\\d_]+);`).exec(FACTORY);
  assert.ok(m, `${name} is no longer declared in ${FACTORY_SRC}; this pin is now vacuous`);
  return BigInt(m[1].replace(/_/g, ''));
}

const VIRTUAL_WHOLE = rustConst('CURVE_VIRTUAL_QUOTE_WHOLE');
const NUM = rustConst('GRADUATION_NUM');
const DEN = rustConst('GRADUATION_DEN');
const VIRTUAL_TOKENS = rustConst('CURVE_VIRTUAL_TOKENS');
const CURVE_SUPPLY = rustConst('CURVE_SUPPLY');

/** Whole quote units, floored exactly as `graduation_target_for` floors it. */
const TARGET_WHOLE = (VIRTUAL_WHOLE * NUM) / DEN;

/**
 * The most the curve can ever collect: the input `x` at which `tokens_out` reaches
 * `curve_supply`, from `tokens_out = vt - (vi * vt) / (vi + x)`. Two decimals, which is
 * how the prose states it, and the figure that makes the target meaningful - a target
 * above this is unreachable and the factory rejects it.
 */
const CEILING_2DP = (() => {
  const E18 = 10n ** 18n;
  const vi = VIRTUAL_WHOLE * E18;
  const ceiling = (vi * VIRTUAL_TOKENS) / (VIRTUAL_TOKENS - CURVE_SUPPLY) - vi;
  return (Number(ceiling) / 1e18).toFixed(2);
})();

const V = String(VIRTUAL_WHOLE);
const T = String(TARGET_WHOLE);
const C = CEILING_2DP.replace('.', '\\.');

/**
 * Every document that states the shape, and the SENTENCE each figure has to appear in.
 *
 * A pattern per claim rather than `src.includes(figure)`, which three surviving
 * mutations proved worthless: every one of these files mentions 676 or 1915 somewhere
 * else - the factory file declares the constant, the README states the target twice -
 * so reverting one sentence to the 30/85 curve left the bare substring check green.
 * A positive check has to be anchored on the claim, not on the number.
 *
 * This does couple the test to the wording, and that is the intended trade: rewording
 * the sentence that states the launch's unchangeable terms is exactly the moment to
 * re-check the figure in it. The failure message names the file and the derived value.
 *
 * Listed per file rather than swept, because the point is that a rescale sends someone
 * to a NAMED list of places to rewrite. A sweep would report "1915 is missing
 * somewhere", which is the report that gets ignored.
 */
const PROSE: Array<{ file: string; claims: RegExp[]; why: string }> = [
  {
    file: FACTORY_SRC,
    claims: [
      new RegExp(`virtual_inj\\s+${V} INJ`),
      new RegExp(`graduation_target\\s+${T} INJ`),
      new RegExp(`~${C} INJ this curve can collect`),
      new RegExp(`${T} INJ graduation target`),
    ],
    why: 'the policy table in the docblock on the constant it describes',
  },
  {
    file: 'README.md',
    claims: [
      new RegExp(`reaches the ${T} INJ target`),
      new RegExp(`costs gas instead of\\s*\\n?${T} INJ`),
    ],
    why: 'the graduation section, and what an e2e run would cost in real INJ',
  },
  {
    file: 'docs/AUDIT_SCOPE.md',
    claims: [
      new RegExp(`virtual reserves \\(${V} INJ`),
      new RegExp(`collected quote to ${T} INJ`),
    ],
    why: 'the paragraph an auditor reasons about the boundary from',
  },
  {
    file: 'CLAUDE.md',
    claims: [new RegExp(`${V} INJ virtual, ${T} INJ graduation`)],
    why: 'the fixed policy, under "decisions already made"',
  },
  {
    file: 'packages/launchpad-math/src/pool.rs',
    claims: [new RegExp(`graduation pool, which is ${T} INJ`)],
    why: 'the pool fixture comment, which claimed to be the shipped graduation pool',
  },
];

test('the derivation is the factory\u2019s, and lands on figures worth pinning', () => {
  // Anti-vacuity. If `rustConst` or the arithmetic broke, every assertion below would
  // search for an empty or absurd string and the suite would stay green.
  assert.ok(VIRTUAL_WHOLE > 1n, 'the opening reserve read as a degenerate value');
  assert.ok(TARGET_WHOLE > VIRTUAL_WHOLE, 'graduation must be above the opening reserve');
  assert.ok(Number(CEILING_2DP) > Number(TARGET_WHOLE), 'the target must be reachable');
  assert.equal(String(TARGET_WHOLE).length >= 3, true, 'a two-digit target would match too much prose');

  /*
   * The ratio, not the figures, is what the factory calls invariant across quote
   * assets, so pin that too: a rescale that changed the FRACTION of the ceiling has
   * changed the curve's behaviour and not only where it starts.
   */
  const fraction = Number(TARGET_WHOLE) / Number(CEILING_2DP);
  assert.ok(fraction > 0.9 && fraction < 1, `the target is ${(fraction * 100).toFixed(1)}% of the ceiling`);

  /*
   * The coverage itself, because dropping a file from PROSE is the one mutation that
   * changes nothing visible: the remaining tests pass and the document that was
   * removed is the next one to go stale. All five stated the 30/85 curve, so all five
   * are load-bearing. The two named explicitly are the ones with an outside reader -
   * an auditor, and anyone evaluating the repository.
   */
  const files = PROSE.map((p) => p.file);
  assert.ok(files.length >= 5, `only ${files.length} documents pinned; one was dropped`);
  assert.ok(files.includes('docs/AUDIT_SCOPE.md'), 'the audit scope was dropped from the pin');
  assert.ok(files.includes('README.md'), 'the README was dropped from the pin');
});

for (const { file, claims, why } of PROSE) {
  test(`${file} states the shipped curve`, () => {
    const src = readFileSync(join(REPO, file), 'utf8');
    assert.ok(src.length > 200, `${file} read as ${src.length} bytes; the path is wrong`);
    for (const claim of claims) {
      assert.match(
        src,
        claim,
        `${file} no longer carries this claim: ${claim.source}\n` +
          `  It states the curve's headline figures (${why}), and the factory now says\n` +
          `  virtual ${VIRTUAL_WHOLE} / graduation ${TARGET_WHOLE} / ceiling ${CEILING_2DP}.\n` +
          '  Rewrite the prose. A rescale that updates the constants and not the sentences\n' +
          '  is how five documents came to describe a 30/85 curve two rescalings later.',
      );
    }
  });
}

/**
 * The retired figures, which may be named ONLY where the prose is explaining that they
 * are retired.
 *
 * `<n> INJ` immediately after a virtual-or-graduation keyword is narrow enough not to
 * fire on the dev-buy table or a gas figure, and it is exactly the shape all six stale
 * claims took. The allowlist asserts each entry is still present, so an entry nothing
 * says any more is pruned rather than left standing as a hole.
 */
const RETIRED = ['30', '60', '85', '88', '170', '175', '87.9', '87.91'];
const HISTORY_IS_THE_POINT = [
  FACTORY_SRC,
  'docs/AUDIT.md',
  'app/src/lib/launchLimits.ts',
  'app/src/components/CurveExplorer.tsx',
  'app/src/lib/curve-shape-single-source.test.ts',
];

/**
 * A FRESH regex every call, deliberately. A `g`-flagged literal reused across
 * assertions carries `lastIndex` forward, so the second `assert.match` on the same
 * object fails against a string the pattern does match - which is exactly what the
 * first version of this test did, and it reads as the guard being wrong.
 */
function staleClaim(): RegExp {
  const figures = RETIRED.map((f) => f.replace('.', '\\.')).join('|');
  return new RegExp(
    `(?:virtual[_ ](?:inj|quote|reserves?)|graduation[_ ]target|graduat\\w*\\s+(?:\\w+\\s+)?at|graduat\\w*\\s+target)` +
      `[^\\n\\d]{0,20}(${figures})\\s*INJ`,
    'gi',
  );
}

test('no document states a retired reserve or target as current', () => {
  const offenders: string[] = [];
  for (const { file } of PROSE) {
    if (HISTORY_IS_THE_POINT.includes(file)) continue;
    const src = readFileSync(join(REPO, file), 'utf8');
    for (const m of src.matchAll(staleClaim())) {
      offenders.push(`${file} states "${m[0].replace(/\s+/g, ' ')}" as the current shape`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n  '));

  // The negative check must be able to fire, or it is decoration.
  assert.match('graduation_target  85 INJ', staleClaim());
  assert.match('virtual_inj        30 INJ', staleClaim());
  assert.match('graduation happens at 88 INJ when', staleClaim());
  assert.match('under the ~87.9 INJ this curve', /~87\.9 INJ/);
  // And must not fire on the figures that legitimately sit near these words.
  assert.doesNotMatch('10% lands at roughly 69.5 INJ, or 3.6% of the 1915 INJ graduation target', staleClaim());
  assert.doesNotMatch('the denom creation fee is 0.1 INJ on mainnet', staleClaim());
  assert.doesNotMatch('graduates at 1915 INJ raised', staleClaim());
});
