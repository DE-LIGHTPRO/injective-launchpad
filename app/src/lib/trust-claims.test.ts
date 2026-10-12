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
