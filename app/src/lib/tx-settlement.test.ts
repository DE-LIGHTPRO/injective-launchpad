import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readTxOutcome } from './txStatus.ts';

/**
 * A transaction has THREE endings, and a surface may only act on the first.
 *
 * THE DEFECT THIS EXISTS FOR. `/api/broadcast` declared no `maxDuration` while the SDK
 * underneath it was willing to block for 42 seconds waiting for a block. A slow block
 * therefore killed the function, the browser got a dead socket, and the client said
 * "The transaction was signed but could not be sent. Nothing was created." Every clause
 * of that is false about a transaction already sitting in the mempool, and the sentence
 * is an instruction to sign the same trade twice.
 *
 * THE SECOND HALF, found while fixing the first. Four surfaces acted on a HASH rather
 * than on a landing: the trade panel cleared the amount and refreshed the page, the
 * claim panel zeroed every owed row. A trade refused inside the block - slippage, which
 * is the entire reason `min_tokens_out` is on the message - looked absorbed, and a
 * second claim against an already paid balance zeroed the figures that would have shown
 * it had not paid again.
 *
 * SO THE THIRD ENDING IS THE POINT. `confirmed`, `failed`, and `unseen`: accepted by a
 * node and not yet visible in a block. It is not a failure and must never be worded as
 * one, because the user holds a hash for a transaction that has very probably landed.
 *
 * These are source guards because nothing observable goes wrong. Every path returns a
 * real hash, the explorer link works, and the figures reappear correctly on the next
 * manual reload - so the defect only shows on a slow block, to somebody who then signs
 * again.
 */

const SRC = join(import.meta.dirname, '..');

/** Comment ranges blanked, line numbers preserved, so the prose can quote the defect. */
function stripComments(src: string): string {
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

/** Every file that drives a transaction through the dialog, with comments blanked. */
function signingSurfaces(): Array<{ rel: string; src: string }> {
  const out: Array<{ rel: string; src: string }> = [];
  for (const file of sourceFiles(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    if (/\btx\.run\s*\(/.test(src)) out.push({ rel: relative(SRC, file), src });
  }
  return out;
}

/** The body of the first `if (<name>)` block in `src`, brace matched. */
function ifBlock(src: string, name: string): string | null {
  const at = src.search(new RegExp(`\\bif\\s*\\(\\s*${name}\\s*\\)`));
  if (at === -1) return null;
  const open = src.indexOf('{', at);
  // A single-statement body with no braces: `if (landed) router.refresh();`
  const semi = src.indexOf(';', at);
  if (open === -1 || (semi !== -1 && semi < open)) return src.slice(at, semi + 1);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i);
    }
  }
  return null;
}

test('a page is only re-read once the chain has actually been changed', () => {
  const surfaces = signingSurfaces();
  /*
   * Anti-vacuity. Four surfaces sign today; a regex that stopped matching would make
   * every assertion below pass by finding nothing to assert about.
   */
  assert.ok(
    surfaces.length >= 4,
    `only ${surfaces.length} signing surfaces found: this guard is not reading the components`,
  );

  const offenders: string[] = [];
  for (const { rel, src } of surfaces) {
    const assigned = src.match(/const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tx\.run\s*\(/);
    if (!assigned) {
      offenders.push(`${rel} discards the result of tx.run, so it cannot know whether the transaction landed`);
      continue;
    }
    const gated = ifBlock(src, assigned[1]);
    if (gated === null) {
      offenders.push(`${rel} assigns \`${assigned[1]}\` and never branches on it`);
      continue;
    }
    /*
     * Every refresh has to sit INSIDE that branch. Outside it, the page is re-read
     * after a refusal too, which repaints the same figures underneath a dialog
     * explaining why nothing changed, and reads as the refusal having been absorbed.
     * Counted rather than located, so a second ungated refresh added later is caught.
     */
    const refreshes = (src.match(/router\.refresh\(\)/g) ?? []).length;
    const gatedRefreshes = (gated.match(/router\.refresh\(\)/g) ?? []).length;
    if (refreshes !== gatedRefreshes) {
      offenders.push(`${rel} re-reads the chain outside its \`${assigned[1]}\` branch, so a refusal repaints as though it were absorbed`);
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}`);
});

test('a transaction nobody has seen in a block is never reported as a failure', () => {
  /*
   * The hand-off is the whole design: the server stops waiting at six seconds and the
   * browser carries on, where waiting is free. What it must never do is convert
   * "running out of patience" into a verdict. `pollTxOutcome` returns `pending` on a
   * ceiling, and the dialog renders that as its own phase with the hash attached.
   */
  const dialog = stripComments(readFileSync(join(SRC, 'components/TxDialog.tsx'), 'utf8'));
  const poll = stripComments(readFileSync(join(SRC, 'lib/txStatus.ts'), 'utf8'));

  assert.match(dialog, /'unseen'/, 'the dialog has no phase for a transaction it has not seen land');

  // The loop itself, rather than the module: `readTxOutcome` above it returns `failed`
  // legitimately, for a transaction that reached a block and was refused by it.
  const loop = poll.slice(poll.indexOf('export async function pollTxOutcome'));
  assert.match(
    loop,
    /POLL_CEILING_MS\)\s*return\s*\{\s*kind:\s*'pending'/,
    'running out of patience does not return `pending`, and a ceiling is not evidence of anything',
  );
  assert.doesNotMatch(loop, /'failed'/, 'the poll loop invents a refusal the chain never stated');

  /*
   * The copy itself, because this is the one sentence a user acts on. It must not call
   * it a failure and it must tell them not to sign again - a duplicate trade is the
   * expensive outcome and it is what a worried user reaches for.
   */
  const copy = dialog.slice(dialog.indexOf("'unseen' ?"));
  assert.doesNotMatch(copy.slice(0, 600), /\bfailed\b|\brefused\b|went wrong/i);
  assert.match(copy.slice(0, 600), /Do not sign it again/i);
});

test('the poll cannot turn a 404 into a verdict in either direction', async () => {
  /*
   * MEASURED, 19 Oct 2026: a pending transaction and one that never existed answer
   * identically on this endpoint - `404 {"code":5,"message":"tx not found"}` - with no
   * field between them. So a 404 is `pending`, and reading one as confirmation or as
   * refusal would each be an invented answer.
   */
  const calls: string[] = [];
  const real = globalThis.fetch;
  const reply = (status: number, body: unknown) =>
    (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

  try {
    globalThis.fetch = reply(404, { code: 5, message: 'tx not found: ABC' });
    assert.deepEqual(await readTxOutcome('ABC'), { kind: 'pending' });

    // A 200 whose body is not a tx response. A proxy, a captive portal or a framework
    // fallback all answer like this, and `code` read off one is `undefined`, which
    // coerces to zero, which is a confirmation.
    globalThis.fetch = reply(200, { page: '<html>' });
    assert.deepEqual(await readTxOutcome('ABC'), { kind: 'pending' });

    globalThis.fetch = reply(200, { tx_response: { txhash: 'ABC', code: 0, height: '12345' } });
    assert.deepEqual(await readTxOutcome('ABC'), { kind: 'confirmed', height: 12345 });

    // In a block and refused by it. Settled: nothing about this will change, so it is
    // the one ending that may be stated as a failure.
    globalThis.fetch = reply(200, {
      tx_response: { txhash: 'ABC', code: 5, height: '12345', raw_log: 'out of gas' },
    });
    assert.equal((await readTxOutcome('ABC')).kind, 'failed');
  } finally {
    globalThis.fetch = real;
  }

  // It asks for one transaction by hash, which is a bare GET and so a CORS simple
  // request: no preflight, which is the reason this half can run in the browser at all.
  assert.ok(calls.every((u) => /\/cosmos\/tx\/v1beta1\/txs\/ABC$/.test(u)), calls.join(', '));
});

test('the progress bar measures work done, never time elapsed', () => {
  /*
   * A bar that creeps toward full while the chain has said nothing is a reassurance
   * dressed as a measurement, and it is the exact shape of defect this codebase keeps
   * finding in its own money figures. The width is a count of steps REACHED; the
   * seconds shown while settling are counted from the clock and labelled as waited,
   * never as remaining.
   */
  const dialog = stripComments(readFileSync(join(SRC, 'components/TxDialog.tsx'), 'utf8'));
  const bar = dialog.slice(dialog.indexOf('className="tx-bar"'), dialog.indexOf('tx-steps'));
  assert.match(bar, /reached\)?\s*\/\s*STEPS\.length/, 'the bar is not derived from the steps reached');
  assert.doesNotMatch(bar, /waitedSeconds|Date\.now|setInterval/, 'the bar is driven by a clock');
  assert.doesNotMatch(dialog, /remaining|almost|nearly there/i, 'the dialog estimates a wait it cannot measure');
});

test('the dialog is portalled, so no blurred ancestor can clip it', () => {
  /*
   * `backdrop-filter` makes an element a containing block for `position: fixed`, so a
   * dialog rendered inside a panel has its full-screen scrim clipped to that panel. On
   * a sibling project this shipped: in the DOM, announced to a screen reader, and a
   * thousand pixels below the fold. Nothing blurs here today, which is exactly why the
   * next person to add a blur must not also have to remember this.
   */
  const dialog = readFileSync(join(SRC, 'components/TxDialog.tsx'), 'utf8');
  assert.match(dialog, /createPortal\(/);
  assert.match(dialog, /document\.body/);
});

test('the dialog cannot be dismissed while the transaction is still in flight', () => {
  /*
   * Closing cancels nothing: the wallet prompt and the chain do not know this dialog
   * exists. So an early close hides a transaction in progress and takes the hash with
   * it, which is the one thing the user needs if they want to go and look.
   */
  const dialog = stripComments(readFileSync(join(SRC, 'components/TxDialog.tsx'), 'utf8'));
  assert.match(dialog, /const settled =[\s\S]{0,160}'unseen'/, 'settled is not derived from the three endings');
  assert.match(dialog, /Escape'\s*&&\s*settled/, 'Escape closes a dialog whose transaction is still in flight');
  assert.match(dialog, /className="tx-close"[\s\S]{0,200}disabled=\{!settled\}/);
  assert.match(dialog, /className="go"[\s\S]{0,120}disabled=\{!settled\}/);
});
