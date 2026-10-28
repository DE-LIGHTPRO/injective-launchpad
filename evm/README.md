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

## The contracts

| | |
|---|---|
| `LaunchToken.sol` | ERC-20. Fixed supply, no mint, no owner, no pause, no upgrade. |
| `Curve.sol` | One launch: bonding curve, graduation, locked pool, fee claims. |
| `Factory.sol` | Creates launches. Sets terms for FUTURE launches only. |

**No owner, no upgrade path, no withdraw, on the curve.** "Liquidity locked at
graduation" is true because there is no function that could move it, not because a key
was handed somewhere safe.

**The ERC-20 is the piece that got simpler.** On the native side a tokenfactory denom
has an admin who can mint, so the CosmWasm design has to move that admin to the curve
where no code can use it, and revert the launch if the creator did not hand it over.
Here the capability does not exist: the supply is minted once in the constructor and
there is no other path to `_mint` anywhere. Ownable, AccessControl, Burnable, Pausable
and Permit are all deliberately absent.

**The circular dependency, honestly.** The curve needs the token's address and the
token needs the curve's. The token is minted to the factory and transferred in the
same call, so the factory does hold the supply, for three statements inside one atomic
transaction. The first version passed `address(0)` to the curve under a comment saying
it was replaced below, and nothing replaced it: `TOKEN` is immutable, so every launch
would have been born pointing at the zero address, and it compiled without a warning.

## Tests

28, and they run against a fork of live Injective EVM as well as the default EVM:

```bash
forge test
forge test --fork-url https://sentry.evm-rpc.injective.network
```

Three suites. Parity against Rust-generated vectors, the pool and fee decay against
their own vectors, and a full lifecycle: create, buy, sell, graduate, trade the pool,
claim. The lifecycle suite asserts solvency after every step, which is the EVM
equivalent of `scripts/verify-solvency.mjs`.

## Deploying

```bash
INJ_ADMIN=0x... INJ_PLATFORM=0x... \
  forge script script/Deploy.s.sol --rpc-url injective --broadcast --private-key $KEY

./script/verify-deployment.sh 0xFACTORY
```

Simulated against the live chain: **4,858,725 gas, about 0.00155 INJ**. No governance
proposal, no deposit, no vote, no whitelisting.

**These contracts have never executed on a chain and have had no audit.** The
arithmetic is checked against an implementation that has, and the lifecycle is checked
against a fork, which is not the same thing as having run.
