/**
 * Source guard: a connected wallet is read from the shared store, never tracked locally.
 *
 * `ConnectWallet` is the one source of truth. It owns the connection and publishes it to
 * `walletStore` (`setConnectedAccount`). Every other component that needs the connected
 * account must read it with `useConnectedAccount()`, so that connecting at ANY connect
 * point (the header is the usual one) is seen everywhere.
 *
 * This caught two real bugs: `CreateLaunch` and `FeeEarnings` each kept their own
 * `useState<WalletAccount>` set only by their own in-panel `<ConnectWallet onAccount=…>`,
 * so a wallet connected in the header left the Sign section and the claim panel still
 * saying "Connect a wallet" while the header plainly showed the account. Run against that
 * code, this test fails on both files.
 *
 * The rule: outside `ConnectWallet`, no component may keep local `useState<WalletAccount>`
 * or pass `onAccount` to `<ConnectWallet>`. Read the store instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', 'components');
const SOURCE = new Set(['ConnectWallet.tsx']); // the one place the connection is owned

test('only ConnectWallet holds the connection; others read the shared store', () => {
  const offenders: string[] = [];

  for (const name of readdirSync(DIR)) {
    if (!name.endsWith('.tsx') || SOURCE.has(name)) continue;
    const src = readFileSync(join(DIR, name), 'utf8');

    // Local wallet-account state is the anti-pattern: it cannot see a connection made
    // anywhere but this component's own button.
    if (/useState<\s*WalletAccount/.test(src)) {
      offenders.push(`${name}: keeps local useState<WalletAccount> (use useConnectedAccount)`);
    }
    // Feeding a local setter into ConnectWallet is the same bug by another route.
    if (/<ConnectWallet[^>]*\bonAccount=/.test(src)) {
      offenders.push(`${name}: passes onAccount to <ConnectWallet> (read the shared store)`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Components must read the connected account from walletStore:\n  ${offenders.join('\n  ')}`,
  );
});
