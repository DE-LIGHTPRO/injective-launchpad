# Live on Injective EVM

Deployed and exercised on mainnet, **28 Oct 2026**. Every figure below was read back
off the chain, not taken from a deployment log.

```
chain id   1776
rpc        https://sentry.evm-rpc.injective.network

factory    0xD31966ef9d26C589996935359A567eeF9Ef1a59D
admin      0x7fCc735e0e473932C1F75ec163B98226E4Bcf1Bb
platform   0xd35EAA1b1161F47e5dBf607DE8E306501c1e3BD6
launch fee 0.2 INJ
```

No governance proposal, no deposit, no vote. Deployment cost **0.001555 INJ**.

## First launch, end to end

```
curve      0xDe726DbA03730efCdc7529396A56E48d746965b7
token      0xB0EF95c2C1929f778EdE88815E65C67A02858533   "injpad genesis" / GENESIS
create tx  0x6a57a7a11640bb7fa103761f2618733b0929b15cd11984558e716658cb5b1110
buy tx     0xb375e573640df92baac8f6f8d031c1a394b8f347577712b1f6817c217c5e4e84
```

**Supply.** 1,000,000,000 minted, and the curve holds all of it. `owner()` reverts and
`mint()` reverts, because neither function exists.

**The curve points at the right token.** `curve.TOKEN()` returns the deployed token.
That is checked specifically because the first version of the factory passed
`address(0)` there under a comment claiming it was replaced below, and nothing
replaced it: `TOKEN` is immutable and it compiled without a warning.

**The quote is what arrives.** A 0.1 INJ buy quoted 3,529,253,463,570,218,279,677,065
tokens and transferred exactly that. `injCollected` is 9.9e16, exactly the quoted net.

**The fee split is exact.** `creatorOwed` 7e14 and `platformOwed` 3e14 against a 1e15
fee: 70/30 with nothing lost to rounding.

**Solvency, zero drift.** The contract holds 0.100000000 INJ against 0.099 collected
plus 0.001 owed in fees. Balance equals obligations exactly, which is the same
invariant `scripts/verify-solvency.mjs` measures on the CosmWasm side.

## Verify it yourself

```bash
cd evm && ./script/verify-deployment.sh 0xD31966ef9d26C589996935359A567eeF9Ef1a59D
```

## What is still true

**No audit, and now live.** The arithmetic is checked against the CosmWasm
implementation that has run on chain, and the contracts are checked against a fork,
but neither is an audit. The factory existing endangers nobody; people using it is
where the risk starts.

The CosmWasm deployment remains the other path and is not abandoned: see
[../docs/GOVERNANCE-PROPOSAL.md](../docs/GOVERNANCE-PROPOSAL.md).
