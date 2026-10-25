# Governance: getting inj·pad onto Injective mainnet

Injective mainnet will not accept contract code from our key. `code_upload_access` is
a chain parameter currently set to a one-address allowlist, so uploading is a
governance vote. Background and the measured parameters are in
[MAINNET-RUNBOOK.md](./MAINNET-RUNBOOK.md) step 7.

This file holds the two things that have to be written: the on-chain proposal and the
forum post that goes up before it. Both are drafts to review, not to paste blind. Only
the numbers below marked measured have been read off a chain.

## The route

`MsgAddCodeUploadParamsAddresses`, which whitelists our deploy address once and covers
every later contract change, rather than `MsgStoreCode`, which is one proposal per
contract per version. One 100 INJ deposit instead of two, and no second four-day wait
when a contract is upgraded.

Address to whitelist, which is the key `scripts/deploy.mjs` signs with:

```
inj10lx8xhswguun9s0htmqk8wvzymjteudmt9hjhl
```

## Before submitting

- [ ] Post the forum thread below and give it a few days. The two most recent
      third-party upload proposals were both rejected, and the three whitelist
      proposals that passed drew essentially no `no` votes. The difference is whether
      anyone recognised the project before the vote opened.
- [ ] Push the local commits. The repo is public and the proposal links it, so what a
      voter reads must be what is running.
- [ ] Decide the audit position. The CosmWasm contracts have had no independent audit.
      State it in the proposal rather than letting a voter find it, because a voter who
      finds it reads it as something we hid.
- [ ] Confirm the message shape against the installed `injectived`. The JSON below
      follows proposal 697, which used `MsgUpdateParams` through the same gov
      authority, but the add-addresses message has not been exercised from this
      machine.
- [ ] 100 INJ in the proposing account. 10 INJ is enough to submit, with the remaining
      90 due inside 2 days or the proposal lapses.

## The proposal

`proposal.json`:

```json
{
  "messages": [
    {
      "@type": "/cosmwasm.wasm.v1.MsgAddCodeUploadParamsAddresses",
      "authority": "inj10d07y265gmmuvt4z0w9aw880jnsr700jstypyt",
      "addresses": ["inj10lx8xhswguun9s0htmqk8wvzymjteudmt9hjhl"]
    }
  ],
  "metadata": "",
  "deposit": "100000000000000000000inj",
  "title": "Whitelist inj·pad Developer Address for CosmWasm Uploads",
  "summary": "SUMMARY GOES HERE, see below"
}
```

Submit:

```bash
injectived tx gov submit-proposal proposal.json \
    --chain-id injective-1 --node https://sentry.tm.injective.network:443 \
    --gas 2000000 --gas-prices 160000000inj --from <your key>
```

### Summary text

> This proposal requests adding the inj·pad developer address
> `inj10lx8xhswguun9s0htmqk8wvzymjteudmt9hjhl` to the CosmWasm code upload allowlist on
> Injective mainnet.
>
> inj·pad is a bonding-curve token launchpad built natively on Injective. Every token
> has a fixed supply of 1,000,000,000, and at graduation the accumulated liquidity moves
> into a pool that nobody can withdraw from, including us.
>
> Both properties are structural rather than promised, which is the part worth checking
> rather than taking on trust. A tokenfactory denom's admin can mint without limit, so
> the launch transaction transfers that admin to the launch's own curve contract, and
> that contract has no message that mints and no wasm admin through which one could be
> added. It is enforced by failure: if the creator has not handed the admin over, the
> tokenfactory module refuses and the whole launch reverts, so a launch whose creator
> kept the mint key cannot exist. Anyone can verify it, because the denom's authority
> metadata names the curve. Separately, curves are instantiated with `admin: None`, so
> no key anywhere can migrate the code holding a locked pool.
>
> Trading fees split 70% to the token creator and 30% to the platform, paid at the
> addresses recorded when the launch was created.
>
> Two contracts need uploading: a curve contract instantiated once per token launch, and
> a factory that creates them. Whitelisting the address rather than proposing each
> contract individually means later contract revisions do not each require their own
> four-day governance cycle.
>
> Source: https://github.com/DE-LIGHTPRO/injective-launchpad
>
> The contracts run on Injective testnet now, where the fee split, the graduation
> transition and the post-graduation fee routing have each been exercised against the
> chain. The Rust suite is 153 tests.
>
> Solvency is checked against the chain rather than asserted. `scripts/verify-solvency.mjs`
> asks the bank module what each launch holds and compares it to every claim recorded in
> that launch's own state: on the quote side `inj_collected + lp_bonus + pool_quote +
> creator_owed + platform_owed`, and on the token side the pool's tokens after
> graduation or the unsold curve supply plus LP reserve before it. Across six launches
> on testnet factory `inj1u350rygnvuxyzqcwzz6wulu4q70te4ez3hjtk8`, spanning both quote
> decimal scales and both lifecycle states, the difference is zero on all twelve
> comparisons. Anyone can re-run it against any factory, and it exits non-zero on a
> shortfall, so it is also usable as a monitor.
>
> Disclosure: the CosmWasm contracts have not had an independent third-party audit. An
> external review of the application was completed and its eighteen findings addressed,
> but it did not cover the contracts. We are stating this rather than omitting it, and
> will fund a contract audit; voters who would rather see that audit land first should
> vote no, and we will return with it.
>
> **Actions:**
>
> - Voting **yes** supports adding this address to the CosmWasm code upload allowlist.
> - Voting **no** does not support this addition.
> - Voting **no with veto** indicates the proposal is spam, irrelevant or malicious to
>   governance, and contributes to burning the deposit if NoWithVeto exceeds one third
>   of the total voting power.
> - Voting **abstain** contributes to quorum while declining to vote either way.

## The forum post

Goes up on the Injective forum and in Discord before the proposal, so the vote is not
the first time anyone has heard of this.

> **inj·pad: a bonding-curve launchpad with liquidity locked at graduation**
>
> We have been building a token launchpad on Injective and are preparing a governance
> proposal to whitelist our deploy address for CosmWasm uploads. Posting first so the
> questions happen here rather than during a four-day vote.
>
> **What it does.** A creator opens a launch and the token trades against a bonding
> curve. There is no presale and no allocation to us. Once the curve reaches its
> graduation threshold, the liquidity it accumulated moves into a locked pool in the
> same transaction. Supply is fixed at 1,000,000,000.
>
> **What the contracts guarantee, and what they do not.** Two guarantees, both
> structural, and both checkable rather than promised.
>
> Curves are instantiated with `admin: None`. This was `Some(factory)` during
> development and was changed deliberately, because the factory is itself upgradeable
> by whoever holds its wasm admin, and new factory code could then migrate every curve
> it administered to code that drains the locked pool. "Liquidity locked forever" is
> only true if no key on earth can replace the code holding it.
>
> Supply is fixed by moving the mint key somewhere no code can use it. A tokenfactory
> denom's admin can mint without limit, so the launch transaction transfers that admin
> to the curve, which has no message that mints and no wasm admin through which one
> could be added. If the creator has not handed it over, the tokenfactory module
> refuses and the launch reverts, so a launch that kept its mint key cannot exist. The
> denom's authority metadata names the curve, so this is verifiable from outside.
>
> What is not guaranteed is anything about a token's price or a creator's conduct. This
> is infrastructure for launching, not an endorsement of what gets launched.
>
> **Fees.** 70% of each launch's trading fee to that token's creator, 30% to the
> platform, at the addresses fixed when the launch was created. A keeper pays them out
> and cannot redirect them: the contract pays the recorded addresses, so a compromised
> keeper key wastes its own gas and nothing else.
>
> **State of it.** Live on Injective testnet. 153 Rust tests on the contracts and 624
> on the application. The fee split, the graduation transition and the post-graduation
> fee routing have each been exercised against testnet rather than only in tests.
>
> **Solvency, checked rather than claimed.** A contract's own tests assert its counters
> move correctly relative to each other, and would pass identically if every counter
> were scaled by a constant. So `scripts/verify-solvency.mjs` asks the bank module what
> each launch actually holds and compares it against every claim in that launch's state.
> Across six testnet launches, both quote decimal scales, and one launch already
> graduated and trading against its locked pool, the difference is zero on all twelve
> comparisons, to the base unit. It is in the repo, it runs against any factory
> including a mainnet one, and it exits non-zero on a shortfall. Please run it.
>
> **Source.** https://github.com/DE-LIGHTPRO/injective-launchpad
>
> **The thing we would rather say than have found.** The contracts have not had an
> independent audit. An external review covered the application and its eighteen
> findings are addressed, but not the contracts. We would rather be asked about that
> here than have it surface mid-vote.
>
> Happy to answer anything, and to walk through any part of the contracts.
