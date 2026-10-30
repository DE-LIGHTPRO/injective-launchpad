# Live on Injective EVM

Deployed and exercised on mainnet. Every figure below was read back off the chain, not
taken from a deployment log.

```
chain id   1776                                          (eth_chainId -> 0x6f0)
rpc        https://sentry.evm-rpc.injective.network
factory    0xe24adc45439a787e38b10bFD4AD4f51B636a1B50     18,563 bytes of code
admin      0x7fCc735e0e473932C1F75ec163B98226E4Bcf1Bb
platform   0xd35EAA1b1161F47e5dBf607DE8E306501c1e3BD6
launch fee 0.2 INJ                                        (`launchFee()`)
```

No governance proposal, no deposit, no vote, unlike the CosmWasm side. A deployment
costs gas and nothing else.

## Four factories, and this is the fourth

**This one carries the audit fixes and the earlier three do not**, which is the whole
reason it exists. V-01 (an opening fee over 10% made every trade revert), V-03 (one
fee recipient could block the other's payout) and V-04 (plain INJ sent to a curve was
unrecoverable) are fixed here and are permanent on the others, because these contracts
are immutable.

Verified against the DEPLOYED bytecode rather than against `src/`:
`evm/test/DeployedFactory.t.sol`, forked onto mainnet, creates a launch with a 15%
opening fee and trades it, refuses a 20% standing fee, pays the platform while the
creator cannot receive, and has a bare transfer rejected. A compile proves what the
source says; only a fork proves what was deployed.

**Run it at `--evm-version cancun`, and that is not the same answer as for anvil.**
Injective's block headers are pre-Shanghai, so `anvil --fork-url` must be pinned to
`--hardfork shanghai` or every `eth_call` fails with "Excess blob gas not set". Its EVM
nevertheless EXECUTES Cancun opcodes - solc 0.8.28 defaults to cancun and emits MCOPY,
which is how these contracts run at all. Forked at shanghai the tests failed consuming
the whole block's gas, which is an invalid opcode and not a contract bug. Header
support and opcode support are two different questions about a chain.

Fork from `https://injectiveevm-rpc.polkachu.com`, not the sentry: that hostname is a
load balancer whose nodes prune differently, measured and non-monotonically (500 and
5,000 blocks back refused, 50,000 and 500,000 served), so a fork from it dies part way
through on state it answered for a moment earlier.

## The earlier three

**This file named `0xD31966ef…` for two days after it stopped being the deployed one,
and that is the failure worth recording here rather than quietly correcting.** Defects
were found and fixed while the EVM port was being wired up - a missing independent sell
fee, a per-wallet cap, a `token: address(0)` the factory never replaced - and each fix
meant a new factory, because these contracts are immutable by design. The document that
tells the next person which address is live was not part of that loop.

The superseded ones, written out in full so an old note can be recognised:

```
superseded 0xD31966ef9d26C589996935359A567eeF9Ef1a59D     launch fee 0.2 INJ
superseded 0x87f2991e84d9d98c8db5fd54019e6b302b765458     launch fee 0.2 INJ
superseded 0x3D811414b3c578380B1D7D1a89D72907C22914c8     launch fee 0    (carried PAD)
```

All three still hold code and still accept launches, and the first two still charge
0.2 INJ. They carry V-01, V-03 and V-04 for good.

It still holds code and still answers every call, which is what makes a stale address
in a document dangerous rather than merely wrong: it is not a dead link, it is a
working launchpad running an older contract. Verified 30 Oct 2026 that both addresses
are deployed.

**The live address is established by reading the production bundle, not this file.**
`injpad.vercel.app`'s chunks carry exactly one `0x…40` address and it is
`0x3D811414b3c578380B1D7D1a89D72907C22914c8` - the deployment's own answer to "what is
configured", which no document can drift from.

## Factory constants

```
CURVE_SUPPLY     800,000,000 x 1e18     on the curve
LP_RESERVE       200,000,000 x 1e18     held back to pair at graduation
VIRTUAL_TOKENS   1,073,000,000 x 1e18   the virtual reserve the curve prices against
```

These match `FIXED_CURVE` in `app/src/lib/launchLimits.ts` exactly. They have to: the
create form draws the curve and quotes the opening price from its own copy, so a
divergence would quote one curve and create another with nothing on the page saying so.

## The launch on it, end to end

```
launch 0   PAD
curve      0x1EA823E09dB42Ca472182D8898bfaA40A64020F9
token      0x97bc455e526D77E58fE78D22f49E20e96ed3deEA
creator    0x7fCc735e0e473932C1F75ec163B98226E4Bcf1Bb
created    1793184889   2026-10-28T10:54:49Z
```

**Supply.** 1,000,000,000 x 1e18 minted, and the curve holds
999,858,382.693484460051273232 of it - the whole supply less what has been bought.

**No mint, no owner, no burn, no pause.** The token's deployed bytecode is 1,813 bytes
and contains none of the selectors `mint(address,uint256)` `40c10f19`, `owner()`
`8da5cb5b`, `transferOwnership(address)` `f2fde38b`, `burn(uint256)` `42966c68`, or
`pause()` `8456cb59`. Checked against the bytecode rather than against the source,
because the source is not what is running.

**The curve points at the right token.** `curve.TOKEN()` returns
`0x97bc455e…`, the deployed token. That is checked specifically because the first
version of the factory passed `address(0)` there under a comment claiming it was
replaced below, and nothing replaced it: `TOKEN` is immutable and it compiled without a
warning.

**One trade, and it reconciles.** `eth_getLogs` over the page after creation returns one
`Bought`, decoded as 0.004 INJ in for 141,617.306515539948726768 PAD with a
0.00004 INJ fee, in block 189,281,250 at 2026-10-28T10:54:56Z. Against the curve's own
state: `tokensSold` 141,617.306515539948726768 and `injCollected` 0.00396 INJ, which is
the 0.004 paid less the 0.00004 fee. The event and the state agree to the unit.

**The fee split is exact.** `creatorOwed` 0.000028 INJ and `platformOwed` 0.000012 INJ
against a 0.00004 INJ fee: 70/30 with nothing lost to rounding.

**The wallet cap is live.** `MAX_PER_WALLET` is 5,000,000 x 1e18, enforced on every
curve buy and freed again by a sell.

**Gas, measured 30 Oct 2026.** `eth_estimateGas` on `createLaunch` returns 2,588,418 at
a 0.16 gwei gas price: **0.000414 INJ** for a launch. A buy is 82,756 gas, 0.0000132
INJ. The app's pre-flight reserve is sized against these; see `launchGasReserveFor`.

## What this endpoint will and will not serve

**`eth_getLogs` is capped at 10,000 blocks per request**, measured:

```
span 1       0 logs           span 100,000    ERROR -32000
span 1,000   0 logs           span 1,000,000  ERROR -32000
span 10,000  0 logs           from genesis    ERROR -32000

-32000 maximum [from, to] blocks distance: 10000
```

Blocks are sub-second, so one page is under two hours of chain time. PAD sits 256,818
blocks behind the head - twenty-six requests - which is why `app/src/lib/evm/trades.ts`
reads a window at the head and a window at the launch's creation rather than scanning,
and why the trade card states which blocks it read.

## Verify it yourself

```bash
cd evm && ./script/verify-deployment.sh 0xe24adc45439a787e38b10bFD4AD4f51B636a1B50
```

## What is still true

**No audit, and live.** The arithmetic is checked against the CosmWasm implementation
that has run on chain, and the contracts are checked against a fork, but neither is an
audit. The factory existing endangers nobody; people using it is where the risk starts.

The CosmWasm deployment remains the other path and is not abandoned: see
[../docs/GOVERNANCE-PROPOSAL.md](../docs/GOVERNANCE-PROPOSAL.md).
