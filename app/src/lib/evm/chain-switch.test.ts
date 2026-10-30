/**
 * The wallet gets asked to ADD the chain when it says it does not know it.
 *
 * THE DEFECT, REPORTED FROM THE LIVE SITE AND REPRODUCED HERE EXACTLY.
 * `ensureEvmChain` tested `(e as {code?: number}).code !== 4902` and rethrew anything
 * else. MetaMask answered `wallet_switchEthereumChain` with
 *
 *     Unrecognized chain ID "0x6f0". Try adding the chain using
 *     wallet_switchEthereumChain first.
 *
 * and the code was not readable at `e.code`, so the check failed, the error was
 * rethrown, and `wallet_addEthereumChain` was never called. The user then read "This
 * wallet could not add Injective EVM (chain 1776)" above the switch's own error - a
 * sentence about an add that never happened, evidenced by a different call's failure.
 *
 * One missed property produced a dead connect flow and two false claims about it.
 *
 * WHY A UNIT TEST CATCHES IT NOW AND DID NOT BEFORE. There was no test of this path at
 * all: it needs an EIP-1193 provider, and the only one I had was a stub I wrote, which
 * reported its code exactly where my code looked for it. A stub that agrees with the
 * implementation about the thing in dispute cannot discriminate. These fixtures carry
 * the shapes real providers use, including the one measured on the live site.
 */
process.env.NEXT_PUBLIC_NETWORK = 'evm';

import test from 'node:test';
import assert from 'node:assert/strict';

const { ensureEvmChain } = await import('./wallet.ts');
const { providerErrorCode, isUnrecognisedChain, isUserRejection } = await import('./provider.ts');

const TARGET = '0x6f0';

/** The error MetaMask actually returned, pasted from the running site. */
function measuredSwitchError() {
  return new Error(
    'Unrecognized chain ID "0x6f0". Try adding the chain using wallet_switchEthereumChain first.',
  );
}

/**
 * A provider that records what it was asked and answers the way a real one does.
 *
 * `switchError` is thrown by `wallet_switchEthereumChain`; after a successful add it
 * starts reporting the target chain, as MetaMask does.
 */
function stubProvider(opts: {
  startChain?: string;
  switchError?: unknown;
  addError?: unknown;
  addSwitches?: boolean;
}) {
  const calls: string[] = [];
  let chain = opts.startChain ?? '0x1';
  let added = false;
  return {
    calls,
    get chain() {
      return chain;
    },
    p: {
      async request({ method }: { method: string }) {
        calls.push(method);
        switch (method) {
          case 'eth_chainId':
            return chain;
          case 'wallet_switchEthereumChain':
            if (!added && opts.switchError) throw opts.switchError;
            chain = TARGET;
            return null;
          case 'wallet_addEthereumChain':
            if (opts.addError) throw opts.addError;
            added = true;
            // Most wallets switch as part of adding; `addSwitches: false` is the one
            // that does not, which is why `ensureEvmChain` re-reads afterwards.
            if (opts.addSwitches !== false) chain = TARGET;
            return null;
          default:
            throw new Error(`unexpected ${method}`);
        }
      },
    },
  };
}

test("MetaMask's measured 4902 wording is recognised, even with no readable code", async () => {
  const e = measuredSwitchError();
  assert.equal(providerErrorCode(e), null, 'the fixture must have no findable code, or it proves nothing');
  assert.equal(isUnrecognisedChain(e), true);

  const s = stubProvider({ switchError: e });
  await ensureEvmChain(s.p as never);

  /*
   * THE ASSERTION THAT WOULD HAVE CAUGHT IT. Before the fix this list ended at the
   * switch and the add was never reached.
   */
  assert.ok(
    s.calls.includes('wallet_addEthereumChain'),
    `the wallet was never asked to add the chain; it was asked: ${s.calls.join(', ')}`,
  );
  assert.equal(s.chain, TARGET);
});

test('the code is found wherever a provider nests it', () => {
  const nested = [
    { label: 'e.code', e: Object.assign(new Error('x'), { code: 4902 }) },
    { label: 'e.data.code', e: Object.assign(new Error('x'), { data: { code: 4902 } }) },
    {
      label: 'e.data.originalError.code',
      e: Object.assign(new Error('x'), { data: { originalError: { code: 4902 } } }),
    },
    {
      label: 'e.cause.code',
      e: Object.assign(new Error('x'), { cause: Object.assign(new Error('y'), { code: 4902 }) }),
    },
  ];
  for (const { label, e } of nested) {
    assert.equal(providerErrorCode(e), 4902, `the code at ${label} was not found`);
    assert.equal(isUnrecognisedChain(e), true, `${label} was not read as an unknown chain`);
  }
});

test('an error that is NOT about an unknown chain is rethrown, not treated as one', async () => {
  /*
   * The half that must not get looser. A wallet that refuses the switch for its own
   * reason must not have a network added behind the user's back: the add prompt would
   * appear for something they never asked about.
   */
  const other = Object.assign(new Error('Request already pending. Please wait.'), { code: -32002 });
  assert.equal(isUnrecognisedChain(other), false);

  const s = stubProvider({ switchError: other });
  await assert.rejects(() => ensureEvmChain(s.p as never), /already pending/);
  assert.ok(!s.calls.includes('wallet_addEthereumChain'), 'a chain was added for an unrelated failure');
});

test('a wallet that adds without switching is switched afterwards', async () => {
  /*
   * Adding is not switching, and some wallets do only the first. Treating the add as
   * success is how a transaction gets signed on the chain the user was already on.
   */
  const s = stubProvider({ switchError: measuredSwitchError(), addSwitches: false });
  await ensureEvmChain(s.p as never);
  assert.equal(s.chain, TARGET);
  assert.equal(
    s.calls.filter((c) => c === 'wallet_switchEthereumChain').length,
    2,
    'the add was treated as a switch',
  );
});

test('already on the chain asks the wallet for nothing', async () => {
  const s = stubProvider({ startChain: TARGET });
  await ensureEvmChain(s.p as never);
  assert.deepEqual(s.calls, ['eth_chainId'], 'a prompt was raised for a wallet already on the chain');
});

test('cancelling the prompt is a rejection, not a wallet that could not add', () => {
  /*
   * `connectEvm` turns a rejection into the marker `wallet.ts` reads. Before this,
   * `ensureEvmChain` sat outside the try that classifies errors, so pressing Cancel on
   * MetaMask's add-network prompt was reported as the wallet refusing - blaming the
   * wallet for the user's decision.
   */
  assert.equal(isUserRejection(Object.assign(new Error('nope'), { code: 4001 })), true);
  assert.equal(isUserRejection(new Error('MetaMask Tx Signature: User rejected the request.')), true);
  assert.equal(
    isUserRejection(Object.assign(new Error('x'), { data: { originalError: { code: 4001 } } })),
    true,
  );
  assert.equal(isUserRejection(measuredSwitchError()), false);
});

test('connectEvm turns a cancelled network prompt into a rejection', async () => {
  /*
   * THE GAP A SURVIVING MUTATION FOUND. The test above checks `isUserRejection` in
   * isolation, and deleting the line in `connectEvm` that USES it changed nothing -
   * a guard for a helper is not a guard for the call site. `ensureEvmChain` sat
   * outside the try that classifies errors, so pressing Cancel on MetaMask's
   * add-network prompt reached `wallet.ts` as a raw provider error and was reported
   * as the wallet refusing: the user's own decision, blamed on their wallet.
   *
   * `connectEvm` throws the marker `rejected`, which `wallet.ts` turns into "You
   * closed the wallet prompt, so nothing was connected."
   */
  const { connectEvm } = await import('./wallet.ts');
  const g = globalThis as unknown as Record<string, unknown>;
  const had = 'ethereum' in g;
  try {
    g.ethereum = {
      async request({ method }: { method: string }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          return ['0x7fCc735e0e473932C1F75ec163B98226E4Bcf1Bb'];
        }
        if (method === 'eth_chainId') return '0x1';
        if (method === 'wallet_switchEthereumChain') throw measuredSwitchError();
        if (method === 'wallet_addEthereumChain') {
          throw Object.assign(new Error('MetaMask: User rejected the request.'), { code: 4001 });
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    await assert.rejects(
      () => connectEvm(),
      (e: Error) => {
        assert.equal(e.message, 'rejected', `a cancelled prompt surfaced as: ${e.message}`);
        return true;
      },
    );
  } finally {
    if (!had) delete g.ethereum;
  }
});

test('a wallet that genuinely refuses the add is reported as that, with its words kept', async () => {
  const { connectEvm } = await import('./wallet.ts');
  const g = globalThis as unknown as Record<string, unknown>;
  const had = 'ethereum' in g;
  try {
    g.ethereum = {
      async request({ method }: { method: string }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          return ['0x7fCc735e0e473932C1F75ec163B98226E4Bcf1Bb'];
        }
        if (method === 'eth_chainId') return '0x1';
        if (method === 'wallet_switchEthereumChain') throw measuredSwitchError();
        if (method === 'wallet_addEthereumChain') {
          throw new Error('May not specify different chain ID for connected network');
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    await assert.rejects(
      () => connectEvm(),
      (e: Error) => {
        assert.notEqual(e.message, 'rejected', 'a real refusal was reported as the user cancelling');
        assert.match(e.message, /could not switch to chain 1776/);
        // The wallet's own words are kept, which is the only thing that identifies an
        // unexpected failure - the lesson `WalletError.detail` exists for.
        assert.match(e.message, /different chain ID/);
        return true;
      },
    );
  } finally {
    if (!had) delete g.ethereum;
  }
});

test('the chain handed to the wallet is the registry entry, not our own labels', async () => {
  /*
   * chainid.network lists 1776 as `Injective` with
   * `https://blockscout.injective.network`. This site calls it "Injective EVM" and
   * links transactions to injscan - our choices about our own interface, not about an
   * entry in somebody's wallet. MetaMask ships 1776 in its network list and can refuse
   * an add whose name or explorer conflicts with its canonical one, which would be a
   * refusal we caused ourselves.
   */
  let params: Record<string, unknown> | null = null;
  const p = {
    async request({ method, params: args }: { method: string; params?: unknown[] }) {
      if (method === 'eth_chainId') return params ? TARGET : '0x1';
      if (method === 'wallet_switchEthereumChain') {
        if (!params) throw measuredSwitchError();
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        params = (args as Record<string, unknown>[])[0];
        return null;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  await ensureEvmChain(p as never);

  /*
   * Copied to a local before reading. `params` is assigned inside a closure, so
   * TypeScript's control-flow analysis cannot see it change and narrows it to `never`
   * after the assertion - which `node --test` runs straight past, because it strips
   * types rather than checking them. `tsc` caught it, as it did the stub's bigint.
   */
  const sent = params as Record<string, unknown> | null;
  assert.ok(sent, 'the wallet was never asked to add the chain');
  assert.equal(sent.chainId, TARGET);
  assert.equal(sent.chainName, 'Injective');
  assert.deepEqual(sent.rpcUrls, ['https://sentry.evm-rpc.injective.network']);
  assert.deepEqual(sent.blockExplorerUrls, ['https://blockscout.injective.network']);
  assert.deepEqual(sent.nativeCurrency, { name: 'Injective', symbol: 'INJ', decimals: 18 });
});
