import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * No screen may claim this has been audited, because it has not been.
 *
 * THE DEFECT THIS EXISTS FOR. The launch page carried "Audited contract (code 39974)"
 * as a quiet grey line and "Audited code 39974" as a green trust badge, directly above
 * the buy button. `docs/AUDIT.md` opens with the words "Not a third-party audit", and
 * `docs/AUDIT_SCOPE.md` is a document written FOR an auditor nobody has engaged.
 *
 * What the check behind the badge actually does is compare the deployed code id
 * against `NEXT_PUBLIC_CURVE_CODE_IDS`, read the wasm admin, and read the denom's mint
 * authority. Three real facts, read off the chain, worth stating. "Audited" is a
 * fourth claim read off nothing, and to a trader it means a named third party reviewed
 * the code and signed for it. On a page where someone decides to spend money that is
 * the most consequential sentence on the screen.
 *
 * This is a source guard rather than a copy review for the usual reason: the word
 * reads perfectly naturally next to a code id. It only looks wrong once you go and
 * check whether an audit exists.
 *
 * WHEN AN AUDIT DOES EXIST, this test is the right place to notice. Delete the
 * assertion deliberately, name the firm and the commit in the copy, and link the
 * report. Do not simply widen it.
 */

const SRC = join(import.meta.dirname, '..');

/**
 * The one page allowed to use the word, because it uses it to DENY an audit.
 *
 * "The contracts have not been audited by a third party" is the honest sentence
 * this whole guard exists to protect, and a rule that forbade it would push the
 * product towards saying nothing rather than saying the true thing. The exemption
 * cannot become a loophole: the test below asserts the page still contains the
 * denial, so changing it into a claim fails just as loudly.
 */
const DENIES_AN_AUDIT = 'app/risks/page.tsx';

/** Comment ranges blanked, so line numbers survive and prose can discuss the word. */
function userFacingText(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

test('nothing a user reads says this code has been audited', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (relative(SRC, file) === DENIES_AN_AUDIT) continue;
    const text = userFacingText(readFileSync(file, 'utf8'));
    const re = /\baudit(ed|s|ing)?\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const line = text.slice(0, m.index).split('\n').length;
      offenders.push(`${relative(SRC, file)}:${line} "${m[0]}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'No third party has audited these contracts. Say what is actually checked: the ' +
      'code id matches the published one, there is no upgrade key, and the launch ' +
      `contract holds the mint key.\n  ${offenders.join('\n  ')}`,
  );
});

test('nothing a user reads promises that fees are paid automatically', () => {
  /*
   * FeeEarnings read "These are paid out automatically. Connect a wallet to send them
   * now instead of waiting", on every launch page, to everybody. Automatic payouts are
   * an operator's cron plus a funded wallet, and this component can check neither, so
   * the sentence was a status reported without a probe.
   *
   * It was also false. `payout.yml` had failed on all 20 of its scheduled runs since
   * 12 Oct 2026 because KEEPER_MNEMONIC was never set, so nothing had ever been paid
   * automatically and "instead of waiting" named a wait with no end. A scheduled job
   * that has never once succeeded looks exactly like one with nothing to do.
   *
   * And an interval must not be promised even once the keeper runs: measured on this
   * repository, a fifteen-minute cron produced 19 runs in 84.1 hours, median 278
   * minutes apart, because GitHub drops high-frequency schedules under load.
   *
   * What may be said is the contract property, which is true in every configuration
   * and is the reassuring part anyway: anyone can trigger the payout, it always pays
   * the addresses fixed at launch, and the sender only pays gas.
   */
  const banned = [
    /paid out automatically/i,
    /\bautomatic(ally)?\b[^.]{0,40}\bpaid\b/i,
    /every fifteen minutes/i,
    /every 15 minutes/i,
  ];
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = userFacingText(readFileSync(file, 'utf8'));
    for (const re of banned) {
      const m = re.exec(text);
      if (m) {
        offenders.push(`${relative(SRC, file)}:${text.slice(0, m.index).split('\n').length} "${m[0]}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the app cannot see whether the keeper runs, so it must not promise it or name an ' +
      `interval. Say what the contract guarantees instead.\n  ${offenders.join('\n  ')}`,
  );
});

test('the honest replacement is still there', () => {
  /*
   * The other half, and the one that matters: a guard that only forbids a sentence is
   * satisfied by saying nothing, which would drop the fact that a creator does not
   * have to wait for anybody.
   */
  const fees = userFacingText(readFileSync(join(SRC, 'components/FeeEarnings.tsx'), 'utf8'));
  assert.match(
    fees,
    /Anyone can send these to the creator and the launchpad/,
    'the contract property is no longer stated, so the panel now says less than it can prove',
  );
  assert.match(fees, /costs the sender gas/, 'the cost of triggering a payout is no longer named');
});

test('the internal review still says it is not an audit', () => {
  /*
   * The other half. The guard above is only honest while the document it rests on
   * still disclaims an audit: if `AUDIT.md` were ever to describe a real engagement,
   * the rule above would be enforcing the wrong thing and should be revisited rather
   * than silently kept.
   */
  const review = readFileSync(join(SRC, '..', '..', 'docs', 'AUDIT.md'), 'utf8');
  assert.match(
    review.slice(0, 400),
    /Not a third-party audit/i,
    'AUDIT.md no longer disclaims being an audit; revisit the copy guard above.',
  );
});

test('the verified badge names verification, not an audit', () => {
  const badges = userFacingText(
    readFileSync(join(SRC, 'components/TrustBadges.tsx'), 'utf8'),
  );
  assert.match(
    badges,
    /Verified code \$\{status\.codeId\}/,
    'the badge for a matching code id must say what it checked',
  );
});

test('the risks page denies an audit rather than claiming one', () => {
  /*
   * The other half of its exemption. It is the only file allowed to use the word,
   * so it is the only file that could quietly turn a denial into a claim, on the
   * page a reader goes to precisely because they want the unvarnished version.
   */
  const page = readFileSync(join(SRC, DENIES_AN_AUDIT), 'utf8');
  assert.match(
    page,
    /have not been audited by a third party/,
    'the risks page no longer states that the contracts are unaudited',
  );
  assert.doesNotMatch(
    page.replace(/have not been audited by a third party/g, ''),
    /\baudited\b/,
    'the risks page uses "audited" somewhere other than the denial',
  );
});
