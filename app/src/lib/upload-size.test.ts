import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { maskComments } from './testing/maskComments.ts';
import {
  describeFileSize,
  HOST_BODY_LIMIT_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  oversizeMessage,
} from './uploadSize.ts';

/**
 * Is the upload limit the page advertises one the host will actually accept?
 *
 * AUDIT F-16, AND IT IS A DEFECT BETWEEN TWO CORRECT HALVES. The route enforced 5 MB
 * and enforced it properly; the drop zone advertised 5 MB and advertised it honestly.
 * Neither was wrong about itself. The host refuses a request body over 4,500,000 bytes
 * before the function is invoked, so everything from 4.5 to 5 MB was accepted by the
 * page, refused by the platform, and explained by nobody: the 413 is `text/plain`, so
 * `res.json()` fails, there is no `error` field to read, and the creator got the
 * generic "That upload did not go through." about a file the label had approved.
 *
 * No unit test could have caught it. Both sides agreed with each other, and the
 * constant that disagreed with them belongs to Vercel and is written down nowhere in
 * this repository. So the measurement is recorded as a constant and the relationship
 * between the two is what gets asserted.
 */

const SRC = join(import.meta.dirname, '..');
const ROUTE = join(SRC, 'app', 'api', 'upload', 'route.ts');
const WIDGET = join(SRC, 'components', 'LogoUpload.tsx');

const code = (p: string) => maskComments(readFileSync(p, 'utf8'));

test('the limit the page advertises is one the host will accept', () => {
  /*
   * THE ASSERTION THIS FILE EXISTS FOR. A multipart body is the file plus an envelope:
   * the boundary, the part headers, and the creator's own filename, which has no bound
   * we control. The envelope allowance is deliberately far larger than any real one -
   * the point is not to predict it, it is that there is visibly room for it.
   */
  const ENVELOPE_ALLOWANCE = 64 * 1024;
  assert.ok(
    MAX_UPLOAD_BYTES + ENVELOPE_ALLOWANCE < HOST_BODY_LIMIT_BYTES,
    `the page offers ${MAX_UPLOAD_LABEL} (${MAX_UPLOAD_BYTES} bytes) and the host refuses a ` +
      `body over ${HOST_BODY_LIMIT_BYTES}, so an upload the page accepts is refused before ` +
      `the route runs and no message this product writes can reach the creator`,
  );
});

test('the words and the number are one decision', () => {
  /*
   * The number was typed out four times: the route's constant, two route messages, and
   * the drop zone's label. The one a creator reads was the furthest from the check, so
   * raising the cap in the route left the page advertising the old figure - or, as
   * shipped, lowering the real ceiling left the page advertising a figure that had
   * never been reachable.
   *
   * Discovery over the upload surface rather than an assertion about two known strings,
   * and anti-vacuous: find no megabyte-shaped literal anywhere and the scan is not
   * measuring the files it thinks it is.
   */
  const files = [
    ['app/api/upload/route.ts', code(ROUTE)],
    ['components/LogoUpload.tsx', code(WIDGET)],
    ['lib/uploadSize.ts', code(join(SRC, 'lib', 'uploadSize.ts'))],
  ] as const;

  const offenders: string[] = [];
  for (const [rel, src] of files) {
    // A digit immediately before the unit. `${...} MB` is the derived label and fine.
    for (const m of src.matchAll(/\d+(?:\.\d+)?\s*MB\b/g)) {
      offenders.push(`${rel}: ${m[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'the upload limit is written out by hand here instead of coming from MAX_UPLOAD_LABEL, ' +
      'so the page can advertise a figure the route does not enforce',
  );

  /*
   * ANTI-VACUOUS, AND THE FIRST VERSION OF THIS GOT IT BACKWARDS. It asserted the unit
   * appeared in at least two of the three files, which is the opposite of the policy
   * the rest of this test enforces: after the fix "MB" is written in exactly ONE place,
   * `MAX_UPLOAD_LABEL`, and the other two interpolate it. The check failed on correct
   * code and would have passed on the defect.
   *
   * What makes the scan non-vacuous is that it is reading live files and that both
   * consumers surface the limit from the one place - not that a literal survives.
   */
  assert.equal(
    files.filter(([, src]) => /\bMB\b/.test(src)).length,
    1,
    'the size unit should be written in exactly one place, the derived label',
  );
  for (const [rel, src] of files) {
    assert.ok(src.trim().length > 200, `${rel} read as near-empty: the scan is not measuring`);
  }
  for (const rel of ['app/api/upload/route.ts', 'components/LogoUpload.tsx'] as const) {
    const src = files.find(([r]) => r === rel)![1];
    assert.match(src, /MAX_UPLOAD_LABEL/, `${rel} does not surface the shared label`);
  }
});

test('the route enforces the shared constant rather than one of its own', () => {
  const src = code(ROUTE);
  assert.match(
    src,
    /MAX_UPLOAD_BYTES/,
    'the route no longer reads the shared cap, so the page and the route can disagree',
  );
  /*
   * And it must not have grown a second opinion beside it. `5 * 1024 * 1024` was the
   * original; any self-computed byte cap here is the defect returning.
   */
  const own = src.match(/(?<!MAX_UPLOAD_BYTES\s*=\s*)\b\d+\s*\*\s*1024\s*\*\s*1024/g) ?? [];
  assert.deepEqual(own, [], 'the route computes its own byte cap again');
});

test('the browser refuses an oversized file before spending the upload', () => {
  /*
   * The ONLY place a correct sentence exists for a file over the host's cap, since the
   * route is never invoked for one. Asserted as an ordering, the way the route's own
   * pre-parse checks are: a size check that runs after the fetch has been sent is a
   * check that has already paid for what it refuses.
   */
  const src = code(WIDGET);
  const checkAt = src.search(/file\.size\s*>\s*MAX_UPLOAD_BYTES/);
  const fetchAt = src.indexOf("fetch('/api/upload', { method: 'POST'");
  assert.ok(checkAt > 0, 'the browser-side size check is gone');
  assert.ok(fetchAt > 0, 'the upload POST is gone; this guard needs re-pointing');
  assert.ok(
    checkAt < fetchAt,
    'the size check runs after the file has been sent, which is the bandwidth it exists to save',
  );
});

test('a 413 carrying no JSON is named as a size failure, not as a mystery', () => {
  /*
   * The host's 413 is `text/plain`, so `data` is null and the `data?.error` fallback
   * reads "That upload did not go through." - true, and silent about the one thing the
   * creator can act on. Measured: the body is `Request Entity Too Large` followed by
   * `FUNCTION_PAYLOAD_TOO_LARGE`, which is also why none of it can be shown to a user.
   */
  const src = code(WIDGET);
  assert.match(
    src,
    /res\.status\s*===\s*413\s*&&\s*!data/,
    'a 413 with no JSON body falls through to the generic message, which says nothing about size',
  );
});

test('a size reads as a size, and a small file is never reported as zero', () => {
  assert.equal(MAX_UPLOAD_LABEL, '4 MB');
  assert.equal(describeFileSize(4 * 1024 * 1024), '4.0 MB');
  assert.equal(describeFileSize(4_823_449), '4.6 MB');
  /*
   * A 4 KB file told it is "0.0 MB" has been told it is empty, which is a different
   * refusal with a different remedy. Under a tenth of a megabyte reports in KB, and
   * never below 1.
   */
  assert.equal(describeFileSize(4096), '4 KB');
  assert.equal(describeFileSize(1), '1 KB');
  assert.match(oversizeMessage(4_823_449), /4\.6 MB.*limit is 4 MB/);
});

test('the refusal never reads as a contradiction at the boundary', () => {
  /*
   * FOUND BY DROPPING THE FILE, NOT BY READING THE FUNCTION. A file of exactly
   * `MAX_UPLOAD_BYTES + 1` was refused with "That image is 4.0 MB. The limit is 4 MB.",
   * which states that a file at the limit is over it. The figure was honest and the
   * sentence was not, because one decimal place cannot hold the difference.
   *
   * Asserted over the whole band where that collapse happens rather than at the single
   * byte that exposed it: anything that rounds to the cap's own figure has the same
   * problem, and the band is ~51 KB wide, not one byte.
   */
  const atLimit = describeFileSize(MAX_UPLOAD_BYTES);
  for (const over of [MAX_UPLOAD_BYTES + 1, MAX_UPLOAD_BYTES + 1024, MAX_UPLOAD_BYTES + 50_000]) {
    const msg = oversizeMessage(over);
    assert.doesNotMatch(
      msg,
      new RegExp(`is ${atLimit.replace('.', '\\.')}\\. The limit is`),
      `at ${over} bytes the refusal reads "${msg}", which says a file at the limit is over it`,
    );
    assert.match(msg, /just over/, `${over} bytes should refuse in words, not in a figure`);
  }
  // And outside the band the figure is still given, because there it is actionable.
  assert.match(oversizeMessage(6 * 1024 * 1024), /is 6\.0 MB\. The limit is 4 MB\./);
});

test('the control no longer claims to pin to IPFS, because it does not', () => {
  /*
   * The route was rewritten from Pinata to Vercel Blob and returns an `https://` URL;
   * the label still said "Pinning to IPFS" and the docblock still promised an `ipfs://`
   * address. The field beside it genuinely accepts a hand-typed `ipfs://`, so a creator
   * who wanted IPFS had every reason to believe this control delivered it.
   *
   * Masked, so the docblock explaining this history does not fail the guard that exists
   * because of it.
   */
  const src = code(WIDGET);
  assert.doesNotMatch(
    src,
    /Pinning to IPFS|ipfs:\/\//,
    'LogoUpload tells the creator their file goes to IPFS, and it goes to Vercel Blob',
  );
});
