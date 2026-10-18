/**
 * THE HEADER PRINTED WHATEVER THE USER HAD TYPED INTO THEIR WALLET.
 *
 * `getKey` returns the account's bech32 address and the name the extension shows for
 * it. `finishConnect` kept both, as `WalletAccount.label`, and two surfaces rendered
 * it: the header, above the address, and the portfolio's loading line. Seen in a
 * screenshot of the deployed header as a six-letter word over `inj10lx8xh…t9hjhl`.
 *
 * That name is not ours. The user chose it inside their own wallet, for themselves,
 * and it is free text: a real name, an employer, "cold storage", a client's name. It
 * went onto a public page without being asked for, and into every screenshot and
 * screen-share taken of that page.
 *
 * It bought nothing. The address beside it is what identifies which account will
 * sign, and the stylesheet had already reached that conclusion: the name was the
 * first thing shed at 860px, under the comment "the address is what identifies which
 * account will sign". Everyone else on this site is labelled by `addressName()`,
 * which exists precisely because a display label must not read as an identity, and is
 * derived from the address rather than supplied by anyone.
 *
 * WHY A SOURCE GUARD. There is nothing to compute and nothing to assert
 * behaviourally: the field was read correctly from the extension and rendered
 * correctly on screen. Every test passed and the screen was wrong, which is the
 * failure mode only a source read reaches. The remedy is that the field is absent
 * from the type, so a later component cannot reach for it - this file is what keeps
 * it absent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { maskComments } from './testing/maskComments.ts';

const SRC = join(import.meta.dirname, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

test('a connected account carries the address and nothing the extension named it', () => {
  const src = maskComments(readFileSync(join(SRC, 'lib', 'wallet.ts'), 'utf8'));

  const iface = src.match(/export interface WalletAccount \{[\s\S]*?\n\}/)?.[0];
  assert.ok(iface, 'WalletAccount is no longer declared as an interface here');
  assert.doesNotMatch(iface, /\blabel\b/, 'WalletAccount carries the extension label again');

  /*
   * And the construction site. Pinned by its whole shape rather than by the absence
   * of a word, because this is the one line that decides what is kept: anything added
   * to it from `key` fails here.
   */
  assert.match(
    src,
    /return \{ name, address: key\.bech32Address, provider: ext \};/,
    'the account is built from something other than the address, the wallet and the provider',
  );
  assert.doesNotMatch(src, /key\.name/, 'the extension account name is read again');

  /*
   * ANTI-VACUITY for the two above: the extension really is asked for a key, so the
   * name is genuinely available and genuinely declined, rather than the whole call
   * having been removed and these assertions passing on an empty file.
   */
  assert.match(src, /await ext\.getKey\(NETWORK\.chainId\)/, 'the wallet is no longer asked for a key');
  assert.match(
    src,
    /let key: \{ bech32Address: string \};/,
    'the key is destructured as something wider than the address',
  );
});

test('no surface renders the extension name, and the classes that framed it are gone', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const src = maskComments(readFileSync(file, 'utf8'));
    const where = relative(SRC, file);
    // `.label` on a quote or a nav item is a different thing entirely, so this is
    // narrowed to the connected account by name.
    if (/\baccount\.label\b|\bacct\.label\b/.test(src)) offenders.push(`${where}: renders the account's extension name`);
    if (/wallet-name|wallet-acct/.test(src)) offenders.push(`${where}: still wears the name's wrapper classes`);
  }

  const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');
  if (/\.wallet-name|\.wallet-acct/.test(css)) {
    offenders.push('globals.css: styles a class no element wears');
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));

  // The address did not go with it. It is the half that identifies the signer.
  const header = maskComments(readFileSync(join(SRC, 'components', 'ConnectWallet.tsx'), 'utf8'));
  assert.match(
    header,
    /className="mono wallet-addr">\{shortAddress\(account\.address\)\}/,
    'the header no longer shows which account will sign',
  );
});
