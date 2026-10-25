# Validator outreach, before the governance proposal

The proposal in [GOVERNANCE-PROPOSAL.md](./GOVERNANCE-PROPOSAL.md) needs more yes than
no among validators who take a side. Abstain is harmless, because it counts toward
quorum and is excluded from the threshold, so the whole exposure is active opposition.
A proposal that appears cold is the one that collects it.

Everything below is measured off `injective-1` on 25 Oct 2026.

## The arithmetic of who matters

45 bonded validators, 57,174,296 INJ bonded. Quorum needs 19,096,215 INJ of votes
cast, and recent turnout has run 42% to 65%, so quorum has never been the risk.

Stake is concentrated enough that a small number of conversations covers most of the
voting power:

```
 #  stake    cum     validator
 1   8.29%    8.3%   Injective Foundation 2
 2   6.78%   15.1%   Kraken02
 3   6.32%   21.4%   Everstake
 4   5.87%   27.3%   Innovating Capital
 5   5.76%   33.0%   FalconX
 6   4.94%   38.0%   Figment
 7   4.56%   42.5%   SCV-Security
 8   3.99%   46.5%   Binance Staking
 9   3.71%   50.2%   Informal Systems
10   3.50%   53.7%   Cointelegraph Decentralization
11   2.84%   56.6%   Kiln
12   2.81%   59.4%   Core ONE
```

The top 6 alone clear the quorum threshold. The top 9 pass half the stake.

**Not every row is worth a message.** Kraken, Binance, BitGo and Hex Trust are
exchanges and custodians; they hold large delegated stakes and generally do not take
positions on application-layer governance. The validators who actually engage are the
professional operators: Everstake, Figment, SCV-Security, Informal Systems, Kiln,
Core ONE, Solva (CryptoCrew), Cointelegraph Decentralization.

## The one move that solves both problems

**SCV-Security is a CosmWasm audit firm and a top-7 Injective validator.** On the
validator set since 2023, a regulated entity, and its published audit reports cover
Cosmos and CosmWasm projects including Eris Protocol, Dojo Trading's Injera and Apollo
DAO. **Informal Systems** (#9) is also a Cosmos audit house. Both were in Injective's
own validator rebate campaign, alongside Zellic and Kiln.

So the audit gap and the vote are the same conversation. Commissioning the contract
audit from SCV or Informal:

- closes the disclosure the proposal currently has to make
- turns a top-10 validator into one that has read the contracts
- is the single most credible answer to "has anyone looked at this", because the
  answer is a named firm with published reports rather than our own test count

Approach them for the audit first, on its own merits, and submit the proposal after.
Do not frame it as buying a vote, because it is not one and would read badly: a firm
that audits and then votes is disclosing an interest, which is normal, and asking it
to vote yes because it was paid is not.

## Draft message

Short, because a validator relations inbox is not where a long pitch gets read. One
paragraph of what, one of what is verifiable, one ask.

> Subject: inj·pad, upcoming CosmWasm upload proposal on Injective
>
> Hello,
>
> We are preparing a governance proposal to whitelist our deploy address for CosmWasm
> uploads on Injective, and would rather you heard it from us than met it as a vote.
>
> inj·pad is a bonding-curve token launchpad. Fixed supply of 1,000,000,000 per token,
> and at graduation the accumulated liquidity moves into a pool with no withdraw path.
> Both are structural rather than promised: the launch transaction moves the
> tokenfactory denom admin to the launch's own curve contract, which has no message
> that mints and no wasm admin through which one could be added, and if the creator has
> not handed it over the launch reverts. Curves are instantiated with `admin: None`, so
> no key can migrate the code holding a locked pool.
>
> It is running on testnet and the source is public:
> https://github.com/DE-LIGHTPRO/injective-launchpad. The thing we would rather you
> asked us than found: the contracts have not had an independent audit. There are 153
> Rust tests, and `scripts/verify-solvency.mjs` checks against the chain that every
> launch can pay what its state says it owes, which is currently exact to the base unit
> across six testnet launches. That is not an audit and we are not presenting it as one.
>
> If you have questions about the contracts, or a view on what you would want to see
> before a code upload proposal, we would value hearing it before we submit rather than
> after.

## Before sending

- [ ] Decide the audit question first, because the message changes depending on the
      answer. Engaged and in progress is a far stronger paragraph than disclosed.
- [ ] Find the actual contact route per validator. Most publish one on the website in
      the table above; several are reachable in the Injective Discord validator
      channels. Do not cold-DM; use the published route.
- [ ] Post the forum thread before or alongside, so a validator who looks finds a
      public discussion rather than only a private message.
- [ ] Nothing in the message should claim an audit, a partnership or an endorsement
      that does not exist. `trust-claims.test.ts` enforces that in the app; this file
      is outside its reach, so it is on whoever sends it.
