import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Do the public write endpoints still have their protections?
 *
 * THE REGRESSION THIS EXISTS FOR. `/api/upload` had a shared rate limit and a
 * content-length pre-check. Rewriting it from IPFS pinning to Vercel Blob dropped
 * both: the feature kept working, every test stayed green, and an unauthenticated
 * endpoint that writes to paid storage lost its only defence.
 *
 * Nothing catches that at runtime. The route behaves correctly for every honest
 * caller, which is exactly the set of callers a test suite contains, and the limiter
 * only matters for the one caller a test suite does not have.
 *
 * So this reads the source for the call. A source read is the weaker kind of test
 * and the only kind available here.
 */

const API = join(import.meta.dirname, '..', 'app', 'api');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (e === 'route.ts') out.push(full);
  }
  return out;
}

test('every route that writes is rate limited', () => {
  const offenders: string[] = [];
  for (const f of routeFiles(API)) {
    const src = readFileSync(f, 'utf8');
    // Only routes that accept a write. A GET-only route needs no limiter.
    if (!/export async function (POST|PUT|PATCH|DELETE)/.test(src)) continue;
    if (!/allowUpload(Shared)?\s*\(/.test(src)) {
      offenders.push(f.replace(API, 'api'));
    }
  }
  assert.deepEqual(offenders, [], 'a write endpoint has no rate limit');
});

test('the upload route refuses an oversized body before reading it', () => {
  /*
   * `formData()` pulls the whole request into memory, so checking `file.size`
   * afterwards rejects an oversized upload only after paying for it. The declared
   * length is the cheap check and it has to come first.
   */
  const src = readFileSync(join(API, 'upload', 'route.ts'), 'utf8');
  /*
   * Matches the header being READ, not the words "content-length" appearing. The
   * first version searched for the bare string and a mutation that replaced the
   * check with `const declared = 0; // content-length` sailed past it: the guard was
   * reading a comment.
   */
  const limitAt = src.search(/req\.headers\.get\(\s*['"]content-length['"]/);
  const parseAt = src.indexOf('req.formData()');
  assert.ok(limitAt > 0, 'the content-length pre-check is gone');
  assert.ok(parseAt > 0, 'the body parse is gone; this guard needs re-pointing');
  assert.ok(
    limitAt < parseAt,
    'the size pre-check runs AFTER the body is read, which defeats it',
  );
});

test('the rate limit runs before the body is read', () => {
  // Same reasoning: a limiter that runs after parsing still pays to parse.
  const src = readFileSync(join(API, 'upload', 'route.ts'), 'utf8');
  assert.ok(
    src.indexOf('allowUploadShared') < src.indexOf('req.formData()'),
    'the rate limit runs after the body is read',
  );
});
