# Audit scope: Vetta contracts

For the third-party auditor. Send it with a pinned commit hash and the wasm checksums
that `scripts/build-wasm.sh` produces at that commit.

## In scope

| Path | Lines (incl. tests and comments) | What it is |
|---|---|---|
| `packages/launchpad-math/src/lib.rs` | ~1,080 | Bonding-curve maths over virtual reserves, fees, price impact |
| `packages/launchpad-math/src/pool.rs` | ~280 | Post-graduation constant-product pool maths |
| `contracts/curve/src/*.rs` | ~1,500 | One launch: curve phase, atomic graduation, locked pool, fees |
| `contracts/factory/src/lib.rs` | ~1,080 | Launch creation, fixed policy, quote allowlist, admin, mint-key handover |

Not in scope: `app/` (Next.js), `scripts/`. They hold no funds, though `app/src/lib/curve.ts`
must agree with the Rust (that is enforced by the parity tests).

Target: CosmWasm 2.2 on Injective (`injective-888` testnet, `injective-1` mainnet), built
with Rust 1.81 to MVP wasm (see `scripts/build-wasm.sh` for why).

## How it works, in one paragraph

A creator mints a fixed 1B-token tokenfactory denom and sends all of it to the factory,
which instantiates a curve with **no wasm admin** and forwards the tokens. 800M are sold on
a constant-product curve over virtual reserves (676 INJ / 1.073B tokens). The buy that takes
collected quote to 1915 INJ (scaled to the quote's decimals) partially fills, refunds the
excess, and in the same transaction seeds an in-contract `x*y=k` pool with the collected
reserve plus any opening-fee premium against the 200M held back plus unsold tokens. From
then on `Buy` / `Sell` trade against that pool. No message can withdraw it. Fees are taken
in the quote asset on every trade, split 70/30 creator/platform, held separately from
reserves, and paid out by a permissionless `ClaimFees`. The creator's 70 is the only part
a launch can redirect: a `reward_route` of `Pool`, chosen at creation and immutable, sends
it into the liquidity instead, which means `creator_owed` on such a launch is permanently
zero. The platform's 30 is never redirected.

## Invariants we believe hold (please try to break them)

1. **Solvency, exact, and `lp_bonus` is a curve-phase term only.** At every point the
   curve's quote balance equals `inj_collected + lp_bonus + pool_quote + creator_owed +
   platform_owed`, and its token balance equals `curve_supply - tokens_sold + lp_reserve`
   before graduation and `pool_tokens` after. **After graduation `lp_bonus` is zero**, and
   the assertion that matters there is the one without it: the balance equals
   `pool_quote + creator_owed + platform_owed` exactly.
   - That second half is stated separately because the sum above cannot see a violation of
     it. `seed_pool` is `lp_bonus`'s only consumer and refuses to run twice, so anything
     added to `lp_bonus` after graduation is owed to nobody and unreachable forever, while
     still being a term in the total. `apply_route(Pool)` did exactly that on every
     post-graduation trade until 2d12c4d. If a term can only be honestly non-zero in one
     phase, say which.
2. **No value extraction by rounding.** Every division rounds toward the pool, so buy then
   sell never returns more than was spent, and the pool's `k` never decreases.
3. **Liquidity is locked.** No execute path sends pool or reserve funds anywhere except to a
   trader in exchange for the other asset. Curves have no wasm admin.
4. **Graduation happens exactly once.** It is atomic with the target-reaching buy, and
   `Graduate {}` only seeds an unseeded graduated curve.
5. **Quote equals execution.** `SimulateBuy` / `SimulateSell` return what executing returns,
   in both phases and **including during an opening-fee window**. The window is the part
   that was wrong until c4071e8: `query` took `_env`, so the simulation could not see the
   clock and quoted the curve as though no premium applied.
6. **Fees cannot touch reserves.** A fee claim can only pay `*_owed`, never reserve or pool.
7. **Launch rules bind only the curve phase.** The wallet cap counts per recipient and the
   start time and opening fee are enforced before any quote. All three expire at graduation.
8. **Factory policy cannot be bypassed.** Supply, curve shape and fee split are fixed in the
   factory, and the creator controls only `fee_bps <= 1000`, profile, rules and a dev buy.

Each has tests. The randomized ones are
`random_trading_across_graduation_keeps_exact_books`,
`random_trading_with_an_opening_fee_keeps_exact_books` and
`random_trading_on_a_pool_routed_launch_keeps_exact_books`, in
`contracts/curve/tests/integration.rs`. The third exists because the first two take the
default reward route, so eighty random trades across graduation, twenty-four times over,
never reached `RewardRoute::Pool` at all: a campaign covers only the branches its fixture
can reach, and that fixture could reach one of two.

## Areas we would like the most attention on

- `exec_buy`: the two-quote opening-premium path and its refund arithmetic
  (`carried_refund`), and the wallet-cap accounting keyed on recipient.
- `seed_pool` and the branch in `exec_buy` / `exec_sell` that seeds an unseeded graduated curve.
- `apply_route`: it is the one place a fee leaves the creator's ledger, and both of its
  destinations mean something different either side of graduation.
- `pool.rs`: rounding direction, and behaviour at extreme reserves.
- Factory `reply`: the `PENDING` handoff across the submessage, address extraction from
  events, and the dev buy sent from the reply.
- Quote decimals scaling in `fixed_curve` (6, 8 and 18 decimals).
- Anything that lets a third party grief a launch: dust, stuck states, or unbounded storage.

## Trust assumptions

- The factory admin (multisig on mainnet) can allowlist quotes and repoint **future**
  launches at a new curve code id. The app refuses to trade curves whose code id is not in
  `NEXT_PUBLIC_CURVE_CODE_IDS` or that have an admin.
- The factory's own wasm admin can upgrade the factory, but not the curves.
- Tokenfactory denom admin: the launch tx hands it from the creator to the factory, and
  the factory's reply hands it to the curve, which has no mint code and no wasm admin.
  A launch where the handover did not happen reverts. Please check that no path leaves the
  key anywhere else, and that a curve holding it cannot be made to use it.

## Reproduce

```bash
cargo test                       # 153 tests on 18 Oct 2026, incl. randomized runs
bash scripts/build-wasm.sh       # wasm + export and opcode checks
sha256sum target/wasm32-unknown-unknown/release/*.wasm
```
