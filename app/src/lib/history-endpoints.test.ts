import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { maskComments } from './testing/maskComments.ts';
import { getHistoryEndpoints, NETWORKS } from './config.ts';
import { txSearch, worthAnotherEndpoint, TxSearchError, resetProvedChains } from './txSearch.ts';

/**
 * Can a history read reach further back than one pruned endpoint?
 *
 * AUDIT F-04. The chart, the trade feed, the trade count and 24h volume are all built
 * on `/cosmos/tx/v1beta1/txs`, so they reach back exactly as far as an endpoint's
 * transaction index does, and the configured one does not reach far. Measured 25 Oct
 * 2026: the public sentry kept 100,004 blocks, about 16.4 hours, where 24h volume needs
 * 132,923. Not stale: unobtainable, from the product's first hour.
 *
 * The two dangers here pull in opposite directions, which is why this file is mostly
 * about refusals rather than about reading. Too little failover and history is hours
 * deep. Too much, and a host that answers for the WRONG CHAIN renders somebody else's
 * trades as this launch's history - well-formed, plausible, and caught by no shape
 * check. Only a chain id catches that.
 */

const LIB = import.meta.dirname;
const code = (p: string) => maskComments(readFileSync(p, 'utf8'));

function replies(...rs: Array<{ status: number; body?: unknown }>) {
  const seen: string[] = [];
  const impl = (async (url: string) => {
    const r = rs[Math.min(seen.length, rs.length - 1)];
    seen.push(String(url));
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const yes = async () => true;
const no = async () => false;

test('only a refusal another host might not repeat is worth a second request', () => {
  /*
   * A pruned window, a rate limit and a dead node are properties of the HOST. A 400 or
   * a 404 is a property of the QUERY, and every endpoint on the chain answers it the
   * same, so retrying is latency spent to be told the same thing three times - on a
   * page that renders while it waits.
   */
  assert.equal(worthAnotherEndpoint(500), true, 'a pruned window is not worth asking elsewhere');
  assert.equal(worthAnotherEndpoint(503), true);
  assert.equal(worthAnotherEndpoint(429), true, 'a rate limit is not worth asking elsewhere');
  assert.equal(worthAnotherEndpoint(404), false, 'a missing contract is retried on every host');
  assert.equal(worthAnotherEndpoint(400), false, 'a malformed query is retried on every host');
  assert.equal(worthAnotherEndpoint(200), false);
});

test('a pruned primary falls through to a deeper endpoint', async () => {
  resetProvedChains();
  const f = replies({ status: 500, body: { message: 'height 1 is not available' } }, { status: 200, body: { total: '14' } });
  const r = await txSearch('/p', { fetchImpl: f.impl, endpoints: ['https://a.test', 'https://b.test'], verify: yes });
  assert.equal(r.fellBack, true, 'the fallback was not recorded as one');
  assert.equal(r.endpoint, 'https://b.test');
  assert.deepEqual((r.json as { total: string }).total, '14');
});

test('a fallback is not read until it has proved the chain', async () => {
  /*
   * THE CATASTROPHIC CASE, and the only one here that is worse than no data. A host
   * answering for another chain returns well-formed transactions with plausible prices
   * and volumes. Nothing downstream can tell. So an unproved host is skipped, and the
   * primary's own refusal is what the reader gets.
   */
  resetProvedChains();
  const f = replies({ status: 500, body: { message: 'height 1 is not available' } }, { status: 200, body: { total: '99999' } });
  await assert.rejects(
    () => txSearch('/p', { fetchImpl: f.impl, endpoints: ['https://a.test', 'https://wrong.test'], verify: no }),
    (e: TxSearchError) => e.status === 500,
    'an unproved fallback was read, so another chain\'s history could render as this launch\'s',
  );
  assert.equal(f.seen.length, 1, 'the unproved host was still requested');
});

test('the primary is never asked to prove itself', async () => {
  /*
   * It is the operator's own configured endpoint and `chainMatch` already surfaces a
   * mismatch on it to the user. Gating it here too would mean a probe failure took the
   * history down on a correctly configured deployment.
   */
  resetProvedChains();
  const f = replies({ status: 200, body: { total: '1' } });
  const r = await txSearch('/p', { fetchImpl: f.impl, endpoints: ['https://a.test'], verify: no });
  assert.equal(r.fellBack, false);
  assert.equal(f.seen.length, 1, 'the primary was skipped for failing a check it should not face');
});

test('a deterministic refusal stops at the first endpoint', async () => {
  resetProvedChains();
  const f = replies({ status: 404, body: { message: 'not found' } }, { status: 200, body: { total: '1' } });
  await assert.rejects(
    () => txSearch('/p', { fetchImpl: f.impl, endpoints: ['https://a.test', 'https://b.test'], verify: yes }),
    (e: TxSearchError) => e.status === 404,
  );
  assert.equal(f.seen.length, 1, 'a 404 was retried on another host, which can only be slower');
});

test('when nothing answers, the primary\'s words are the ones reported', async () => {
  /*
   * The first refusal, not the last. The primary is the endpoint the operator chose, so
   * "the window is 16 hours" describes their deployment and is actionable. A free
   * fallback's 429 is a fact about a host the reader never picked.
   */
  resetProvedChains();
  const f = replies(
    { status: 500, body: { message: 'height 1 is not available, lowest height is 2' } },
    { status: 429, body: { message: 'slow down' } },
  );
  await assert.rejects(
    () => txSearch('/p', { fetchImpl: f.impl, endpoints: ['https://a.test', 'https://b.test'], verify: yes }),
    (e: TxSearchError) => e.status === 500 && /lowest height/.test(e.body),
    'the last host\'s refusal was reported instead of the configured one\'s',
  );
});

test('the endpoint list puts the configured one first and never repeats a host', () => {
  const eps = getHistoryEndpoints();
  assert.ok(eps.length >= 2, 'there is no fallback at all, so history is one endpoint deep');
  assert.equal(eps.length, new Set(eps).size, 'a host appears twice, which is a slower way to be refused');
  assert.equal(eps[0].replace(/\/$/, ''), eps[0], 'the primary carries a trailing slash, so it will not dedupe');
});

test('no network can fall back to another network\'s host', () => {
  /*
   * PER NETWORK BY CONSTRUCTION, and asserted because this is the one mistake with no
   * symptom. A mainnet build reading a testnet host does not error and does not render
   * empty: it renders testnet trades as mainnet history. The chain probe is the runtime
   * guard; this is the one that stops the wrong host being compiled in at all.
   */
  for (const [name, net] of Object.entries(NETWORKS)) {
    /*
     * COSMWASM NETWORKS ONLY. History fallbacks exist because an LCD sentry prunes,
     * so a deeper archival host is needed behind it. The EVM side is one JSON-RPC
     * endpoint with no equivalent, and giving it a fallback to satisfy this would
     * mean inventing a host, which is the opposite of what the rule is protecting.
     *
     * Scoped rather than excepted by name, so a second EVM deployment is covered
     * without anyone remembering to add it here.
     */
    if ((net.backend ?? 'cosmwasm') !== 'cosmwasm') continue;
    const others = Object.values(NETWORKS).filter(
      (n) => n.name !== net.name && (n.backend ?? 'cosmwasm') === 'cosmwasm',
    );
    for (const host of net.historyFallbacks) {
      assert.ok(/^https:\/\//.test(host), `${name} fallback ${host} is not https`);
      const looksTestnet = /testnet|-888/.test(host);
      assert.equal(
        looksTestnet,
        name === 'testnet',
        `${name} lists ${host}, which reads as the other network's host`,
      );
      for (const o of others) {
        assert.ok(!o.historyFallbacks.includes(host), `${host} is listed for both ${name} and ${o.name}`);
      }
    }
    assert.ok(net.historyFallbacks.length >= 1, `${name} has no deeper endpoint than its primary`);
    assert.ok(
      !net.historyFallbacks.includes(net.lcd),
      `${name} lists its own primary as a fallback`,
    );
  }
});

test('both history call sites go through the one resolver', () => {
  /*
   * They each built their own URL from `getLcdUrl()`, which is why this is asserted
   * rather than assumed: a failover added to one of them leaves the other on a 16-hour
   * window, and the two sit side by side on a launch page - a chart showing days next
   * to a trade count showing nothing. `listTrades` feeds the chart and the feed,
   * `countTxs` the trade count and 24h volume.
   */
  for (const rel of ['chain.ts', 'launchActivity.ts']) {
    const src = code(join(LIB, rel));
    assert.match(src, /txSearch\(/, `${rel} does not use the shared history resolver`);
    assert.doesNotMatch(
      src,
      /getLcdUrl\(\)\}?\/cosmos\/tx\/v1beta1\/txs/,
      `${rel} still builds a transaction search against one fixed host`,
    );
  }
});
