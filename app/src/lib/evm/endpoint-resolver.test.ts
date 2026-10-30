/**
 * Every endpoint read goes through the one resolver, on both backends.
 *
 * THE DEFECT, FOUND BY POINTING A DEV SERVER AT A LOCAL FORK AND PRESSING BUY.
 * `config.ts` calls `getLcdUrl()` "the single resolver for the LCD endpoint" and it
 * honours `NEXT_PUBLIC_LCD_URL`. `evm/read.ts` read `NETWORK.lcd` instead - the
 * hardcoded default underneath that resolver - so on the EVM backend the documented
 * override did nothing at all. The build was configured for `http://127.0.0.1:8545`
 * and the pre-flight simulation failed with
 *
 *     URL: https://sentry.evm-rpc.injective.network
 *
 * in its detail. Every read, every simulation, and the `rpcUrls` handed to
 * `wallet_addEthereumChain` went to the public sentry whatever the operator chose.
 *
 * IT MATTERS BEYOND A TEST. That public endpoint prunes per node, measured and
 * non-monotonically: `-500` and `-5000` blocks were refused while `-50000` and
 * `-500000` answered, which is a load balancer across nodes with different pruning
 * configs. An operator pointing at a private archive node was silently still on the
 * flaky shared one.
 *
 * It is rule 17's two-variables-one-decision defect: the variable the runbook names
 * and the variable the signing path reads, each locally correct, disagreeing with
 * nothing to say so. And the guard that exists for exactly this - the chain mismatch
 * banner - was blind here, because it probed a Cosmos route against a JSON-RPC host.
 */
process.env.NEXT_PUBLIC_NETWORK = 'evm';
process.env.NEXT_PUBLIC_LCD_URL = 'http://127.0.0.1:8545';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { getLcdUrl, NETWORK } = await import('../config.ts');
const { evmChain } = await import('./read.ts');

const SRC = join(import.meta.dirname, '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

/** Comment ranges blanked, so a note ABOUT the defect is not read as the defect. */
function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

test('the fixture really overrides the endpoint, or nothing below measures anything', () => {
  assert.equal(getLcdUrl(), 'http://127.0.0.1:8545');
  assert.notEqual(
    NETWORK.lcd,
    'http://127.0.0.1:8545',
    'the default and the override are the same, so this test cannot tell them apart',
  );
});

test('the chain definition the reads and the wallet share honours the override', () => {
  const chain = evmChain();
  assert.deepEqual(
    chain.rpcUrls.default.http,
    ['http://127.0.0.1:8545'],
    'the chain handed to viem and to wallet_addEthereumChain ignores the configured endpoint',
  );
  // And it is still the right chain, so this is an endpoint fix and not a chain swap.
  assert.equal(chain.id, 1776);
});

test('nothing outside config.ts reads NETWORK.lcd', () => {
  /*
   * THE WHOLE CLASS, not the four call sites that were wrong. `config.ts` is the one
   * file allowed to name the default, because that is where the resolver falls back to
   * it. Anywhere else, reading it is reading past an override somebody set.
   *
   * There were four: the public client's transport and the chain's `rpcUrls` in
   * `evm/read.ts`, the `rpcUrls` sent to `wallet_addEthereumChain`, and the sentence
   * telling a user which RPC to add by hand - which would have named an endpoint the
   * page was not using.
   */
  const offenders: string[] = [];
  for (const p of walk(join(SRC, 'lib')).concat(walk(join(SRC, 'components')), walk(join(SRC, 'app')))) {
    if (p.endsWith(join('lib', 'config.ts'))) continue;
    const src = code(p);
    for (const m of src.matchAll(/NETWORK\.lcd/g)) {
      void m;
      offenders.push(p.slice(SRC.length + 1));
    }
  }
  assert.deepEqual(
    [...new Set(offenders)],
    [],
    'NETWORK.lcd is read outside config.ts, which reads past NEXT_PUBLIC_LCD_URL; use getLcdUrl()',
  );
});

test('the mismatch probe speaks JSON-RPC on this backend, not Cosmos', async () => {
  /*
   * `ChainMismatchBanner` exists to say when the endpoint being read is not the chain
   * being signed for - which is precisely what was wrong. It asked a JSON-RPC host for
   * `/cosmos/base/tendermint/v1beta1/node_info`, got a CORS failure on every page load,
   * returned null, and rendered nothing. The guard for the defect was blind to it.
   *
   * Stubbed rather than networked: what is under test is which request goes out and
   * how the answer is read, not whether a node is up.
   */
  const { probeServedChainId } = await import('../chainMatch.ts');
  const realFetch = globalThis.fetch;
  const seen: Array<{ url: string; method?: string; body?: string }> = [];
  try {
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return {
        ok: true,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x6f0' }),
      } as unknown as Response;
    }) as typeof fetch;

    const served = await probeServedChainId();

    assert.equal(seen.length, 1, 'the probe made an unexpected number of requests');
    assert.ok(
      !seen[0].url.includes('/cosmos/'),
      `the probe asked a JSON-RPC host for a Cosmos route: ${seen[0].url}`,
    );
    assert.equal(seen[0].method, 'POST');
    assert.match(seen[0].body ?? '', /eth_chainId/);

    /*
     * DECIMAL, because `NETWORK.chainId` is "1776" and `assessChainMatch` compares
     * strings. Returning the hex would make every comparison a mismatch - a guard that
     * cries wolf gets ignored as fast as one that says nothing.
     */
    assert.equal(served, '1776');
    assert.equal(served, NETWORK.chainId, 'the probe and the expected chain id cannot be compared');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a JSON-RPC answer that is not a chain id reads as unknown, never as a mismatch', async () => {
  const { probeServedChainId, assessChainMatch } = await import('../chainMatch.ts');
  const realFetch = globalThis.fetch;
  try {
    for (const result of [undefined, null, 'not-hex', 42, {}]) {
      globalThis.fetch = (async () =>
        ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }) as unknown as Response) as typeof fetch;
      const served = await probeServedChainId();
      assert.equal(served, null, `a result of ${JSON.stringify(result)} was read as a chain id`);
      /*
       * And unknown renders nothing. A banner that says "wrong network" because a node
       * answered oddly is worse than no banner: the page below it is fine.
       */
      assert.equal(assessChainMatch(served).verdict, 'unknown');
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
