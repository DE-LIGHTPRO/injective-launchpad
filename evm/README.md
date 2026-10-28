# inj·pad on Injective EVM

A Solidity port of the CosmWasm contracts, for the EVM side of Injective
(chain id **1776**, `https://sentry.evm-rpc.injective.network`), where contract
deployment is permissionless and needs no governance vote.

See [../docs/EVM-MIGRATION.md](../docs/EVM-MIGRATION.md) for why this exists and when
it is the right thing to deploy.

```bash
cd evm
forge test
forge test --match-test Parity -vv
```

## The Rust is the spec

`packages/launchpad-math` has 153 tests and has been exercised on chain. This port is
checked against vectors **it** produces, not against expectations written here:

```bash
cargo run -p launchpad-math --example vectors   # emits the raw vectors
# then flatten to parallel arrays (see docs/EVM-MIGRATION.md) -> evm/test/vectors.json
```

168 quotes and 192 refusals across three fee rates, four supply positions, three
collected balances and six trade sizes, including 48 partial fills and 48 graduating
buys. A port verified only against its own author's arithmetic restates the author's
misunderstanding, which is the failure this corpus exists to prevent.

Beyond the vectors, three fuzz properties at 512 runs each assert what the curve
actually rests on: that no buy and no sell can leave `injReserve * tokenReserve` below
`k`, and that `ceilDiv` rounds up and no further.

## Rounding is the whole risk of this port

Rust's `ceil_div` is explicit. Solidity's `/` truncates toward zero. Every place the
spec rounds up is an explicit `ceilDiv` here, and reversing one leaks value from the
pool on every trade without ever reverting.

Mutation-verified. Flipping `ceilDiv` to truncate fails **6 of 9 tests**; rounding the
fee down instead of up fails 3.

## Two guards that can never fire

Mutation testing surfaced two survivors, and both turned out to be dead code in the
original Rust rather than holes in the corpus. Deleting either leaves everything
green:

- **The sell payout cap.** `gross > injCollected` requires `tokensIn > tokensSold`,
  which `quoteSell` rejects several lines earlier.
- **`|| tokensOut == remaining` in the graduation test.** Exhausting the curve
  collects exactly `maxCollectable` regardless of what was collected before (the
  `injCollected` terms cancel), and `validate` guarantees
  `graduationTarget <= maxCollectable`. It is reachable only in the non-partial path
  on exact equality, which is why it stays.

Both are kept, and both now have a test proving the precondition rather than a comment
claiming it. `testFuzz_sellPayoutNeverExceedsCollected` and
`test_exhaustingTheCurveCollectsExactlyMaxCollectable`.

## Not done yet

The math library only. Still to port: the curve contract, the factory, the ERC-20
(which replaces the tokenfactory denom and gets simpler: no mint function and no
owner, structurally fixed rather than fixed by an admin transfer), and the deployment
scripts.
