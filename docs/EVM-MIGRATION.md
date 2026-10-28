# Migrating inj·pad to Injective's EVM

**Recommendation: not now.** The EVM route removes the governance blocker completely,
and it is still the more expensive option. Keep it as the documented fallback if the
whitelist proposal fails.

Everything below was measured on 28 Oct 2026, not read from documentation.

## What is true about Injective EVM

```
chain id                 1776
JSON-RPC                 https://sentry.evm-rpc.injective.network
head block               189,272,708
block time               ~0.59s
x/evm enable_create      true
x/evm permissioned       FALSE
```

**Contract deployment is permissionless.** The module carries an `authorized_deployers`
list, but it is dormant while `permissioned` is false. Confirmed by probe rather than
by reading the flag: `eth_estimateGas` on a contract creation from a random,
non-authorized address returns 53,064 gas. If deployment were gated against that
address the estimate would be rejected.

So the whole mainnet blocker on the CosmWasm side (100 INJ deposit, four-day vote,
forum post, validator outreach, documented in
[GOVERNANCE-PROPOSAL.md](./GOVERNANCE-PROPOSAL.md)) **does not exist on EVM**. You
could deploy today.

## Why it is still the wrong move today

### The arithmetic is not close

| | cost | what it risks |
|---|---|---|
| Governance route | 100 INJ refundable, **4 days** | the vote failing |
| EVM migration | **weeks of rewriting**, new audit surface | the work being wrong |

The contracts are finished. 4,581 lines of Rust across the curve, the factory and the
math package. 153 contract tests. Verified on testnet end to end: fee split exact at
70/30, graduation atomic, post-graduation fee routing correct, and solvency measured
against the chain at **zero drift on twelve comparisons**.

Migrating throws that away to avoid a four-day wait. The design carries over; the
proven implementation does not.

### The EVM side is quiet

Sampled 600 consecutive blocks, spanning 5.9 minutes:

```
total EVM transactions      11
                            ~111/hour, ~2,670/day
blocks with any EVM tx      11 of 600 (1.8%)
```

A launchpad needs people, and Injective's users are currently on the native side,
where Helix and the existing DeFi live. Deploying somewhere nothing is happening
solves the deployment problem and creates a distribution one, which is the harder of
the two.

### The upgrade argument does not survive contact

The obvious case for EVM is permissionless upgrades forever, against one governance
vote per contract change. But `MsgAddCodeUploadParamsAddresses` whitelists the deploy
address **once**, after which CosmWasm uploads are permissionless too. That is the
route GOVERNANCE-PROPOSAL.md already recommends, and it closes this gap.

## What would change the answer

- **The proposal fails.** Then EVM is the fallback and this document is the plan. Two
  of the last three third-party upload proposals were rejected, so this is a real
  branch, not a hypothetical.
- **Multi-chain becomes the strategy.** Solidity ports to every other EVM chain;
  CosmWasm does not. If inj·pad is ever meant to run on more than Injective, the
  rewrite pays for itself once rather than per chain.
- **Injective's EVM activity grows.** Worth re-measuring before deciding, with the
  same probe as above rather than from an announcement.

## What the migration would actually involve

Recorded now while the measurement is fresh, so the decision does not have to be
re-researched.

**Carries over unchanged:** the curve math, the 70/30 fee split, the graduation
threshold and transition, the reward-route choice, the dust floor, the solvency
invariants, and every lesson in [AUDIT.md](./AUDIT.md). The design is the expensive
part and it is done.

**Has to be rebuilt:**

- `contracts/curve` and `contracts/factory` in Solidity, plus `packages/launchpad-math`
- 153 Rust tests as Foundry tests
- The app's Injective SDK calls as viem/wagmi, which is familiar from the Sealed work
- `scripts/*.mjs` against JSON-RPC rather than LCD

**Changes shape:**

- **Tokens.** The tokenfactory denom model does not exist on EVM. The current design
  moves the denom admin to the curve, where no code can mint, enforced by the launch
  reverting if the creator did not hand it over. The EVM equivalent is simpler, not
  harder: an ERC-20 with no mint function and no owner, which is structurally fixed
  rather than fixed by an admin transfer. The guarantee survives and the mechanism
  improves.
- **Gas.** Native INJ is the EVM gas token at 18 decimals. The 160000000inj floor and
  the `gas_wanted x price` rule recorded in `injective-chain-params-measured` are
  Cosmos-side facts and do not apply to EVM transactions.
- **The audit.** Solidity auditors are far more numerous and cheaper than CosmWasm
  ones, which is a genuine point in EVM's favour given the audit is currently an open
  item.
