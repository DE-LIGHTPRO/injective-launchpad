//! End-to-end tests against a simulated chain.
//!
//! The maths crate proves the curve cannot be drained in the abstract. These
//! prove the contract around it moves the right funds, keeps its books, and
//! stays solvent.

use cosmwasm_std::{coin, coins, Addr, Empty, Uint128};
use cw_multi_test::{App, AppBuilder, Contract, ContractWrapper, Executor};

use curve::msg::{ExecuteMsg, InstantiateMsg, QueryMsg, SimulateBuyResponse};
use curve::state::LaunchRules;
use curve::state::{CurveConfigStored, State};

const QUOTE: &str = "inj";
const TOKEN: &str = "factory/inj1launch/TEST";

fn one() -> Uint128 {
    Uint128::new(1_000_000_000_000_000_000)
}
fn amt(n: u128) -> Uint128 {
    Uint128::new(n) * one()
}

fn curve_contract() -> Box<dyn Contract<Empty>> {
    Box::new(ContractWrapper::new(
        curve::contract::execute,
        curve::contract::instantiate,
        curve::contract::query,
    ))
}

struct Fixture {
    app: App,
    addr: Addr,
    creator: Addr,
    platform: Addr,
    migration: Addr,
    alice: Addr,
    bob: Addr,
}

/// Tokens held back to pair against the collected INJ in the locked pool.
fn lp_reserve() -> Uint128 {
    amt(200_000_000)
}

fn curve_cfg() -> CurveConfigStored {
    CurveConfigStored {
        virtual_inj: amt(30),
        virtual_tokens: amt(1_073_000_000),
        curve_supply: amt(800_000_000),
        graduation_target: amt(85),
        fee_bps: 100,
    }
}

fn setup() -> Fixture {
    setup_with(Default::default())
}

/// The same fixture with trading rules, so a rule can be exercised through the real
/// execute path rather than by calling the validator directly. The distinction is not
/// academic here: on this project a validator with eight passing tests turned out never
/// to be called, and only a test that went through `execute_contract` found it.
fn setup_with(rules: LaunchRules) -> Fixture {
    let mut app = AppBuilder::new().build(|_, _, _| {});
    let api = app.api().clone();

    let creator = api.addr_make("creator");
    let platform = api.addr_make("platform");
    let migration = api.addr_make("migration");
    let alice = api.addr_make("alice");
    let bob = api.addr_make("bob");

    app.init_modules(|router, _, storage| {
        router
            .bank
            .init_balance(
                storage,
                &creator,
                vec![coin((curve_cfg().curve_supply + lp_reserve()).u128(), TOKEN)],
            )
            .unwrap();
        for who in [&alice, &bob] {
            router
                .bank
                .init_balance(storage, who, coins(amt(1_000).u128(), QUOTE))
                .unwrap();
        }
    });

    let code = app.store_code(curve_contract());
    let addr = app
        .instantiate_contract(
            code,
            creator.clone(),
            &InstantiateMsg {
                rules,
                denom: TOKEN.into(),
                quote_denom: QUOTE.into(),
                creator: creator.to_string(),
                platform: platform.to_string(),
                lp_reserve: lp_reserve(),
                creator_fee_share_bps: 5_000, // half the fee to the creator
                curve: curve_cfg(),
            },
            &coins((curve_cfg().curve_supply + lp_reserve()).u128(), TOKEN),
            "curve",
            None,
        )
        .unwrap();

    Fixture { app, addr, creator, platform, migration, alice, bob }
}

impl Fixture {
    fn balance(&self, who: &Addr, denom: &str) -> Uint128 {
        self.app.wrap().query_balance(who, denom).unwrap().amount
    }
    fn state(&self) -> State {
        self.app
            .wrap()
            .query_wasm_smart(self.addr.clone(), &QueryMsg::State {})
            .unwrap()
    }
    fn buy(&mut self, who: &Addr, inj: Uint128) -> anyhow::Result<()> {
        self.app
            .execute_contract(
                who.clone(),
                self.addr.clone(),
                &ExecuteMsg::Buy { min_tokens_out: Uint128::zero(), recipient: None },
                &coins(inj.u128(), QUOTE),
            )
            .map(|_| ())
            .map_err(|e| anyhow::anyhow!(format!("{e:#}")))
    }
    fn sell(&mut self, who: &Addr, tokens: Uint128) -> anyhow::Result<()> {
        self.app
            .execute_contract(
                who.clone(),
                self.addr.clone(),
                &ExecuteMsg::Sell { min_inj_out: Uint128::zero() },
                &coins(tokens.u128(), TOKEN),
            )
            .map(|_| ())
            .map_err(|e| anyhow::anyhow!(format!("{e:#}")))
    }
    /// The contract must always hold at least what it owes: the curve reserve
    /// that backs outstanding tokens, plus every unclaimed fee. If this ever
    /// fails, someone's sell or fee claim will bounce.
    fn assert_solvent(&self) {
        let st = self.state();
        let held = self.balance(&self.addr, QUOTE);
        /*
         * `lp_bonus` counts as owed. It is quote the contract is holding for the pool
         * at graduation, and leaving it out of this sum would let the opening-fee
         * premium be spent on a sell or a fee claim while every solvency assertion in
         * the suite still passed: the exact shape of hole this helper exists to find.
         */
        // `pool_quote` too: after graduation the reserve lives there, and a sell
        // against the pool is paid out of it.
        let owed =
            st.inj_collected + st.platform_owed + st.creator_owed + st.lp_bonus + st.pool_quote;
        assert!(
            held >= owed,
            "insolvent: holds {held} {QUOTE}, owes {owed} (reserve {} + fees {} + lp bonus {})",
            st.inj_collected,
            st.platform_owed + st.creator_owed,
            st.lp_bonus
        );
    }
}

#[test]
fn seeding_requires_the_exact_supply() {
    let mut app = AppBuilder::new().build(|_, _, _| {});
    let api = app.api().clone();
    let creator = api.addr_make("creator");

    app.init_modules(|router, _, storage| {
        router
            .bank
            .init_balance(storage, &creator, vec![coin(amt(1_200_000_000).u128(), TOKEN)])
            .unwrap();
    });
    let code = app.store_code(curve_contract());

    // Too little is rejected.
    let err = app.instantiate_contract(
        code,
        creator.clone(),
        &InstantiateMsg {
            // An open launch: no cap, no start time.
            rules: Default::default(),
            denom: TOKEN.into(),
            quote_denom: QUOTE.into(),
            creator: creator.to_string(),
            platform: creator.to_string(),
            lp_reserve: Uint128::zero(),
            creator_fee_share_bps: 0,
            curve: curve_cfg(),
        },
        &coins(amt(1).u128(), TOKEN),
        "curve",
        None,
    );
    assert!(err.is_err(), "under-funded launch should be rejected");
}

#[test]
fn buy_moves_tokens_and_books_fees() {
    let mut f = setup();
    let before = f.balance(&f.alice, QUOTE);

    f.buy(&f.alice.clone(), amt(10)).unwrap();

    let st = f.state();
    assert!(!st.tokens_sold.is_zero());
    assert_eq!(f.balance(&f.alice, TOKEN), st.tokens_sold);
    assert_eq!(f.balance(&f.alice, QUOTE), before - amt(10));

    // 1% of 10 INJ, split evenly.
    let fee = amt(10).multiply_ratio(1u128, 100u128);
    assert_eq!(st.creator_owed + st.platform_owed, fee);
    assert_eq!(st.creator_owed, st.platform_owed);
    assert_eq!(st.inj_collected, amt(10) - fee);
    f.assert_solvent();
}

#[test]
fn sell_returns_inj_and_shrinks_the_reserve() {
    let mut f = setup();
    let alice = f.alice.clone();
    f.buy(&alice, amt(10)).unwrap();

    let tokens = f.balance(&alice, TOKEN);
    let inj_before = f.balance(&alice, QUOTE);
    let reserve_before = f.state().inj_collected;

    f.sell(&alice, tokens).unwrap();

    assert_eq!(f.balance(&alice, TOKEN), Uint128::zero());
    assert!(f.balance(&alice, QUOTE) > inj_before, "seller got nothing back");
    assert!(f.state().inj_collected < reserve_before);
    assert!(f.state().tokens_sold.is_zero());
    f.assert_solvent();
}

#[test]
fn buy_then_sell_cannot_profit_through_the_contract() {
    let mut f = setup();
    let alice = f.alice.clone();
    let start = f.balance(&alice, QUOTE);

    f.buy(&alice, amt(50)).unwrap();
    let tokens = f.balance(&alice, TOKEN);
    f.sell(&alice, tokens).unwrap();

    assert!(
        f.balance(&alice, QUOTE) <= start,
        "round trip profited: {} -> {}",
        start,
        f.balance(&alice, QUOTE)
    );
    f.assert_solvent();
}

#[test]
fn slippage_guard_rejects_a_worse_fill() {
    let mut f = setup();
    let alice = f.alice.clone();

    let sim: SimulateBuyResponse = f
        .app
        .wrap()
        .query_wasm_smart(f.addr.clone(), &QueryMsg::SimulateBuy { inj_in: amt(10) })
        .unwrap();

    // Demand one more token than the curve will actually give.
    let err = f.app.execute_contract(
        alice,
        f.addr.clone(),
        &ExecuteMsg::Buy { min_tokens_out: sim.tokens_out + Uint128::one(), recipient: None },
        &coins(amt(10).u128(), QUOTE),
    );
    /*
     * The REASON, not just a failure. `is_err()` alone passes whenever anything goes
     * wrong: a buyer short of funds, a denom typo, a contract that reverts on every
     * call. This test is supposed to be evidence that the slippage bound bit, and until
     * the fixture stopped flattening errors to "Error executing WasmMsg" it could not
     * tell the difference.
     */
    // Matched against the sentence the error actually carries. The first version of
    // this looked for the word "slippage", which the message never uses: it reads
    // "would receive X but asked for at least Y". Asserting the real wording also
    // pins what a user is told, which is the half worth protecting.
    let msg = format!("{:#}", err.unwrap_err());
    assert!(msg.contains("asked for at least"), "did not fail on the slippage bound: {msg}");
}

#[test]
fn front_running_a_buy_triggers_the_victims_slippage_guard() {
    let mut f = setup();
    let alice = f.alice.clone();
    let bob = f.bob.clone();

    // Alice quotes, then Bob lands first and moves the price.
    let sim: SimulateBuyResponse = f
        .app
        .wrap()
        .query_wasm_smart(f.addr.clone(), &QueryMsg::SimulateBuy { inj_in: amt(10) })
        .unwrap();
    f.buy(&bob, amt(40)).unwrap();

    let err = f.app.execute_contract(
        alice,
        f.addr.clone(),
        &ExecuteMsg::Buy { min_tokens_out: sim.tokens_out, recipient: None },
        &coins(amt(10).u128(), QUOTE),
    );
    let msg = format!("{:#}", err.unwrap_err());
    assert!(
        msg.contains("asked for at least"),
        "the sandwiched buy failed for some other reason: {msg}"
    );
    f.assert_solvent();
}

fn graduate(f: &mut Fixture, who: &Addr) {
    for _ in 0..12 {
        if f.state().graduated {
            break;
        }
        let _ = f.buy(who, amt(10));
    }
    assert!(f.state().graduated, "curve never graduated");
}

#[test]
fn the_graduating_buy_seeds_the_locked_pool_in_the_same_transaction() {
    let mut f = setup();
    let alice = f.alice.clone();
    graduate(&mut f, &alice);

    let st = f.state();
    assert!(st.migrated, "graduated but the pool was not seeded");
    assert!(st.inj_collected.is_zero() && st.lp_bonus.is_zero());
    // Token side: the held-back reserve plus whatever the curve never sold, and the
    // contract holds exactly that many tokens. Nothing went anywhere else.
    assert!(st.pool_tokens >= lp_reserve(), "pool has no token side");
    assert_eq!(f.balance(&f.addr, TOKEN), st.pool_tokens);
    // Quote side: everything the contract holds that is not an owed fee, EXACTLY.
    // An inequality here would let a stranded or leaked unit pass.
    assert_eq!(
        f.balance(&f.addr, QUOTE),
        st.pool_quote + st.creator_owed + st.platform_owed
    );
    // And nothing was sent to anyone who is not a trader.
    assert!(f.balance(&f.migration, QUOTE).is_zero());
    assert!(f.balance(&f.migration, TOKEN).is_zero());
    f.assert_solvent();
}

#[test]
fn trading_continues_against_the_pool_after_graduation() {
    let mut f = setup();
    let (alice, bob) = (f.alice.clone(), f.bob.clone());
    graduate(&mut f, &alice);
    let before = f.state();

    // Quoted and executed agree, after graduation as before it.
    let sim: curve::msg::SimulateBuyResponse = f
        .app
        .wrap()
        .query_wasm_smart(f.addr.clone(), &QueryMsg::SimulateBuy { inj_in: amt(3) })
        .unwrap();
    let held = f.balance(&bob, TOKEN);
    f.buy(&bob, amt(3)).unwrap();
    assert_eq!(f.balance(&bob, TOKEN) - held, sim.tokens_out);
    assert!(!sim.graduates && sim.refund.is_zero());

    let mid = f.state();
    assert!(mid.pool_quote > before.pool_quote && mid.pool_tokens < before.pool_tokens);
    assert!(mid.creator_owed > before.creator_owed, "the pool fee did not accrue to the creator");
    f.assert_solvent();

    // The early holder can exit into the pool: this is the whole point of a pool.
    let alice_tokens = f.balance(&alice, TOKEN);
    let quote_before = f.balance(&alice, QUOTE);
    f.sell(&alice, alice_tokens / Uint128::new(2)).unwrap();
    assert!(f.balance(&alice, QUOTE) > quote_before);
    f.assert_solvent();

    // Rounding favours the pool: k never shrinks.
    let k = |s: &State| s.pool_quote.full_mul(s.pool_tokens);
    assert!(k(&f.state()) >= k(&before));
}

#[test]
fn pool_trades_honour_slippage_bounds() {
    let mut f = setup();
    let (alice, bob) = (f.alice.clone(), f.bob.clone());
    graduate(&mut f, &alice);
    let err = f
        .app
        .execute_contract(
            bob.clone(),
            f.addr.clone(),
            &ExecuteMsg::Buy { min_tokens_out: Uint128::MAX, recipient: None },
            &coins(amt(1).u128(), QUOTE),
        )
        .unwrap_err();
    assert!(format!("{err:#}").contains("asked for at least"), "{err:#}");
    let held = f.balance(&alice, TOKEN);
    let err = f
        .app
        .execute_contract(
            alice,
            f.addr.clone(),
            &ExecuteMsg::Sell { min_inj_out: Uint128::MAX },
            &coins(held.u128(), TOKEN),
        )
        .unwrap_err();
    assert!(format!("{err:#}").contains("asked for at least"), "{err:#}");
}

#[test]
fn the_pool_cannot_be_seeded_twice_or_early() {
    let mut f = setup();
    let bob = f.bob.clone();

    // Nowhere near the target yet.
    f.buy(&bob, amt(1)).unwrap();
    let early = f
        .app
        .execute_contract(bob.clone(), f.addr.clone(), &ExecuteMsg::Graduate {}, &[]);
    assert!(early.is_err(), "graduated before reaching the target");

    graduate(&mut f, &bob);
    // Already seeded by the buy; a second seeding would double-count the reserve.
    let twice = f
        .app
        .execute_contract(bob, f.addr.clone(), &ExecuteMsg::Graduate {}, &[]);
    assert!(twice.is_err(), "the pool was seeded twice");
    f.assert_solvent();
}

#[test]
fn fees_survive_graduation_and_pay_out_correctly() {
    let mut f = setup();
    let alice = f.alice.clone();
    for _ in 0..10 {
        if f.state().graduated {
            break;
        }
        let _ = f.buy(&alice, amt(10));
    }
    let (creator_owed, platform_owed) = {
        let s = f.state();
        (s.creator_owed, s.platform_owed)
    };
    assert!(!creator_owed.is_zero());

    // Seeding the pool must not have swept the fee pot into liquidity.
    let s = f.state();
    assert!(s.migrated);
    assert_eq!(
        f.balance(&f.addr, QUOTE),
        s.pool_quote + creator_owed + platform_owed,
        "fees were folded into the pool"
    );

    f.app
        .execute_contract(alice, f.addr.clone(), &ExecuteMsg::ClaimFees {}, &[])
        .unwrap();
    assert_eq!(f.balance(&f.creator, QUOTE), creator_owed);
    assert_eq!(f.balance(&f.platform, QUOTE), platform_owed);

    /*
     * And the lifetime counters, which are the only record of this once `*_owed` is
     * zeroed. Without them "what has this launch paid its creator" is unanswerable
     * from state after the first claim, and a board cannot add it up at all.
     */
    let after = f.state();
    assert!(after.creator_owed.is_zero(), "owed was not cleared");
    assert_eq!(after.creator_paid, creator_owed, "lifetime creator total is wrong");
    assert_eq!(after.platform_paid, platform_owed, "lifetime platform total is wrong");
}

#[test]
fn lifetime_paid_totals_accumulate_across_claims() {
    let mut f = setup();
    let alice = f.alice.clone();

    // Claim once, trade again, claim again: a counter that merely copies the last
    // claim rather than adding to it passes a single-claim test.
    f.buy(&alice, amt(5)).unwrap();
    f.app
        .execute_contract(alice.clone(), f.addr.clone(), &ExecuteMsg::ClaimFees {}, &[])
        .unwrap();
    let first = f.state().creator_paid;
    assert!(!first.is_zero(), "nothing recorded on the first claim");

    f.buy(&alice, amt(5)).unwrap();
    let owed_again = f.state().creator_owed;
    assert!(!owed_again.is_zero());
    f.app
        .execute_contract(alice, f.addr.clone(), &ExecuteMsg::ClaimFees {}, &[])
        .unwrap();

    assert_eq!(
        f.state().creator_paid,
        first + owed_again,
        "the second claim replaced the lifetime total instead of adding to it"
    );
}

/// The whole point, stated as one test: no sequence of trades leaves the
/// contract unable to pay what it owes.
#[test]
fn stays_solvent_through_mixed_trading() {
    let mut f = setup();
    let alice = f.alice.clone();
    let bob = f.bob.clone();

    for i in 0..12 {
        if f.state().graduated {
            break;
        }
        let who = if i % 2 == 0 { alice.clone() } else { bob.clone() };
        let _ = f.buy(&who, amt(3 + i));
        f.assert_solvent();

        let held = f.balance(&who, TOKEN);
        if !held.is_zero() && i % 3 == 0 {
            let _ = f.sell(&who, held / Uint128::new(2));
            f.assert_solvent();
        }
    }
    f.assert_solvent();
}

// ------------------------------------------------------------- launch rules --

/// Tokens the curve hands out for a given quote amount, read without trading.
///
/// Caps in these tests are DERIVED from this rather than written as literals. A literal
/// cap is a statement about the fixture's curve shape as well as about the rule, so it
/// silently stops testing the rule the moment the fixture changes: the first draft used
/// 1,000,000 tokens, which one INJ already exceeds on this curve, and every cap test
/// failed on its setup assertion rather than on anything it meant to assert.
fn quoted_tokens(f: &Fixture, inj: Uint128) -> Uint128 {
    let r: SimulateBuyResponse = f
        .app
        .wrap()
        .query_wasm_smart(f.addr.clone(), &QueryMsg::SimulateBuy { inj_in: inj })
        .unwrap();
    r.tokens_out
}

#[test]
fn a_wallet_cap_refuses_the_buy_that_would_cross_it() {
    /*
     * Through `execute_contract`, not by calling the validator.
     *
     * The rule being correct is not the question: the question is whether a buy ever
     * reaches it. An hour before this was written, mutation testing on the sibling
     * profile validation showed that deleting its one call site left all eight of its
     * tests green, because every one of them called the validator directly.
     */
    // One INJ buys this much, so a cap of one and a half times it admits exactly one
    // such buy and refuses the second.
    let one_buy = quoted_tokens(&setup(), amt(1));
    let cap = one_buy + one_buy / Uint128::new(2);
    let mut f = setup_with(LaunchRules { max_per_wallet: Some(cap), trade_start: None, early_fee: None });
    let alice = f.alice.clone();

    f.buy(&alice, amt(1)).expect("a buy under the cap was refused");

    let err = f.buy(&alice, amt(1)).unwrap_err().to_string();
    assert!(err.contains("caps a wallet"), "wrong refusal: {err}");
    // The numbers are in the message, because "too much" alone leaves the buyer
    // guessing how much smaller to go.
    assert!(err.contains(&cap.to_string()), "the cap is not named: {err}");

    f.assert_solvent();
}

#[test]
fn the_cap_is_per_address_and_does_not_bleed_between_buyers() {
    // One buyer reaching the cap must not reduce what anyone else may buy. A cap
    // tracked in a single total rather than per address does exactly that, and it
    // looks correct until a second buyer shows up.
    let one_buy = quoted_tokens(&setup(), amt(1));
    let cap = one_buy + one_buy / Uint128::new(2);
    let mut f = setup_with(LaunchRules { max_per_wallet: Some(cap), trade_start: None, early_fee: None });
    let alice = f.alice.clone();
    let bob = f.bob.clone();

    f.buy(&alice, amt(1)).unwrap();
    f.buy(&bob, amt(1)).expect("bob was refused because alice had bought");
    assert!(f.balance(&bob, TOKEN) > Uint128::zero());
}

#[test]
fn selling_frees_cap_allowance_so_an_exit_is_not_a_permanent_lockout() {
    /*
     * The semantics the cap actually has, asserted so it cannot drift.
     *
     * Counted as buys minus sells, the cap limits what one address holds through the
     * curve at once. Not decrementing on a sell would turn it into a lifetime quota, so
     * anyone who sold a single token could never buy back in: a rule that punishes
     * exiting, which is not what "max per wallet" means to anybody.
     */
    let one_buy = quoted_tokens(&setup(), amt(1));
    let cap = one_buy + one_buy / Uint128::new(2);
    let mut f = setup_with(LaunchRules { max_per_wallet: Some(cap), trade_start: None, early_fee: None });
    let alice = f.alice.clone();

    f.buy(&alice, amt(1)).unwrap();
    // A second buy is over the cap right now, which is what makes the re-buy below
    // evidence that selling freed the allowance rather than evidence of nothing.
    assert!(f.buy(&alice, amt(1)).is_err(), "the cap was not binding before the sell");

    let held = f.balance(&alice, TOKEN);
    f.sell(&alice, held).unwrap();
    // Allowance is back, so the same buy is possible again.
    f.buy(&alice, amt(1)).expect("a seller was locked out of buying again");
    f.assert_solvent();
}

#[test]
fn selling_more_than_the_curve_sold_you_does_not_abort_the_trade() {
    /*
     * Why the decrement saturates instead of being checked.
     *
     * A holder can own tokens this curve never sold them: bought from someone else, or
     * received as a transfer, both of which are ordinary and neither of which the
     * contract can see. A checked subtraction would make their sell revert with an
     * overflow, which reads as a broken contract rather than as a rule.
     */
    let one_buy = quoted_tokens(&setup(), amt(1));
    let cap = one_buy + one_buy / Uint128::new(2);
    let mut f = setup_with(LaunchRules { max_per_wallet: Some(cap), trade_start: None, early_fee: None });
    let alice = f.alice.clone();
    let bob = f.bob.clone();

    f.buy(&alice, amt(1)).unwrap();
    let held = f.balance(&alice, TOKEN);
    // Bob never bought, so his recorded figure is zero. Give him tokens the way a
    // transfer would, and let him sell them.
    f.app
        .send_tokens(alice.clone(), bob.clone(), &coins(held.u128(), TOKEN))
        .unwrap();
    f.sell(&bob, held).expect("a holder who never bought here could not sell");
    f.assert_solvent();
}

#[test]
fn no_cap_means_no_cap() {
    // The default path. A launch with no rule must not pay for one, and must not be
    // capped by some accidental zero default.
    let mut f = setup();
    let alice = f.alice.clone();
    f.buy(&alice, amt(50)).expect("an open launch refused a large buy");
    assert!(f.balance(&alice, TOKEN) > amt(1_000_000));
}

#[test]
fn a_launch_with_a_start_time_refuses_buys_before_it() {
    // The start is taken from the chain's own clock rather than a literal, so the test
    // does not depend on whatever epoch the test app happens to boot at.
    let now = setup().app.block_info().time;
    let mut f = setup_with(LaunchRules {
        max_per_wallet: None,
        trade_start: Some(now.plus_seconds(600)),
        early_fee: None,
    });
    let alice = f.alice.clone();
    let err = f.buy(&alice, amt(1)).unwrap_err().to_string();
    assert!(err.contains("trading opens at"), "wrong refusal: {err}");

    // And it opens once the chain reaches the time, rather than needing anything else
    // to happen: there is no "open the launch" transaction to forget to send.
    f.app.update_block(|b| b.time = b.time.plus_seconds(601));
    f.buy(&alice, amt(1)).expect("the launch did not open at its start time");
    f.assert_solvent();
}

#[test]
fn a_start_time_that_has_passed_is_simply_open() {
    // The boundary is inclusive, so a launch whose start is exactly this block is open.
    // Refusing the boundary would push every start one block later than asked for.
    let now = setup().app.block_info().time;
    let mut f = setup_with(LaunchRules { max_per_wallet: None, trade_start: Some(now), early_fee: None });
    let alice = f.alice.clone();
    f.buy(&alice, amt(1)).expect("a launch starting now was closed");
}

#[test]
fn a_rule_that_could_never_bind_is_refused_at_launch() {
    /*
     * A cap at or above the whole sellable supply is stored happily and does nothing.
     * Displayed, it reads as a protection the launch does not have, and a buyer takes
     * "max 1,000,000,000 per wallet" as a guarantee about distribution. Refusing is the
     * only honest option: the alternative is a rule that advertises what it cannot do.
     */
    let supply = curve_cfg().curve_supply;
    for bad in [supply, supply + Uint128::one(), Uint128::zero()] {
        let res = std::panic::catch_unwind(move || {
            setup_with(LaunchRules { max_per_wallet: Some(bad), trade_start: None, early_fee: None })
        });
        assert!(res.is_err(), "a cap of {bad} was accepted");
    }
}

#[test]
fn a_buy_landing_exactly_on_the_cap_is_allowed() {
    /*
     * The boundary, which nothing else here reaches.
     *
     * Mutation testing showed `after > cap` could be loosened to `after > cap + 1` and
     * every cap test still passed, because all of them cross the cap by a wide margin.
     * Both directions of that off-by-one are user-visible: a cap of 1,000,000 that
     * refuses a buyer at exactly 1,000,000 is wrong, and one that lets them reach
     * 1,000,001 is wrong in the direction the rule exists to prevent.
     *
     * The cap is set to exactly what one INJ buys on a fresh curve, so the first buy
     * lands on it precisely.
     */
    let exact = quoted_tokens(&setup(), amt(1));
    let mut f = setup_with(LaunchRules { max_per_wallet: Some(exact), trade_start: None, early_fee: None });
    let alice = f.alice.clone();

    f.buy(&alice, amt(1)).expect("a buy landing exactly on the cap was refused");
    assert_eq!(f.balance(&alice, TOKEN), exact, "the fixture did not land on the cap");

    // And one base unit more is over it. Sized as small as the curve allows, so this
    // is about the boundary rather than about the size of the second order.
    let err = f.buy(&alice, Uint128::new(1_000)).unwrap_err().to_string();
    assert!(err.contains("caps a wallet"), "one unit over the cap was allowed: {err}");
    f.assert_solvent();
}

// ------------------------------------------------------------- early fee --

fn with_early_fee(start_bps: u16, secs: u64) -> LaunchRules {
    LaunchRules {
        max_per_wallet: None,
        trade_start: None,
        early_fee: Some(curve::state::EarlyFee { start_bps, seconds: secs }),
    }
}

#[test]
fn an_early_buyer_pays_the_opening_fee_and_a_later_one_does_not() {
    /*
     * The rule working, measured as tokens received rather than as a fee figure.
     *
     * That is deliberate: a buyer does not read the fee, they read what they got. If
     * the premium were charged and the quote still handed over the base-fee quantity,
     * the contract would owe tokens it had not reserved, and the fee number would look
     * right the whole time.
     */
    /*
     * TWO SEPARATE LAUNCHES, and the first version of this test did not do that.
     *
     * It bought twice on one curve and expected the later buy to receive more. It
     * received less, by a wide margin, because the first buy had moved the price:
     * early 245.7M tokens, late 167.8M. The curve effect dominates a 10% fee
     * difference easily, so a same-curve comparison measures the curve, not the rule.
     * Both buys here are the FIRST buy on identical curves, so the only difference
     * left is the fee.
     */
    let mut early = setup_with(with_early_fee(1_100, 1_000)); // 11% opening, 1% base
    let a1 = early.alice.clone();
    early.buy(&a1, amt(10)).unwrap();
    let early_tokens = early.balance(&a1, TOKEN);

    let mut late = setup_with(with_early_fee(1_100, 1_000));
    let a2 = late.alice.clone();
    late.app.update_block(|b| b.time = b.time.plus_seconds(1_001)); // past the decay
    late.buy(&a2, amt(10)).unwrap();
    let late_tokens = late.balance(&a2, TOKEN);

    assert!(
        late_tokens > early_tokens,
        "the opening fee did not make being early more expensive: early {early_tokens}, late {late_tokens}"
    );
    early.assert_solvent();
    late.assert_solvent();
}

#[test]
fn the_premium_goes_to_the_pool_and_not_to_the_creator() {
    /*
     * The design decision, asserted so it cannot drift. A creator who earns more when
     * snipers win has a reason to want snipers, which is the opposite of the rule's
     * purpose. Creator and platform are paid exactly what the curve's own fee would
     * have produced; the difference is held for the pool.
     */
    let mut f = setup_with(with_early_fee(1_100, 1_000));
    let alice = f.alice.clone();
    f.buy(&alice, amt(10)).unwrap();
    let early = f.state();

    // The same trade on a launch with no opening fee, for the baseline.
    let mut g = setup();
    let a2 = g.alice.clone();
    g.buy(&a2, amt(10)).unwrap();
    let plain = g.state();

    /*
     * NEVER MORE, and in fact slightly less, which is a real consequence of taking the
     * premium off the top rather than folding it into the curve's fee: the curve's own
     * fee then applies to what is left after the premium. The difference is
     * second-order (1% of 10%) and it points the right way, since a creator earns
     * marginally less during an opening window rather than more.
     *
     * Asserted as an inequality because the direction is the property that matters. An
     * equality here would also fail if the creator were paid MORE, but it would fail
     * for a correct implementation too, which is how a test ends up being "fixed" by
     * weakening the thing it was protecting.
     */
    assert!(
        early.creator_owed <= plain.creator_owed,
        "the creator was paid MORE because of the opening fee: {} vs {}",
        early.creator_owed,
        plain.creator_owed
    );
    assert!(
        early.platform_owed <= plain.platform_owed,
        "the platform was paid more because of the opening fee"
    );
    // And the shortfall is small: the premium is not quietly coming out of their share.
    assert!(
        early.creator_owed * Uint128::new(100) >= plain.creator_owed * Uint128::new(85),
        "the creator lost more than a rounding margin: {} vs {}",
        early.creator_owed,
        plain.creator_owed
    );
    assert!(early.lp_bonus > Uint128::zero(), "no premium was accrued");
    f.assert_solvent();
}

#[test]
fn the_premium_becomes_pool_liquidity_at_graduation() {
    /*
     * An accumulator that fills and is never paid out is a tax collected for nobody,
     * and it would sit in the contract looking exactly like solvency. This is the test
     * that makes the rule real rather than merely accounted.
     *
     * EXACT, because `>=` was not an assertion: mutation testing on the earlier version
     * showed the premium could be dropped and an inequality still passed. Here the
     * contract's whole quote balance must equal pool + owed fees to the unit, so a
     * premium left out of the pool shows up as a surplus and fails.
     */
    let mut f = setup_with(with_early_fee(1_100, 100_000));
    let alice = f.alice.clone();
    let mut accrued = Uint128::zero();
    for _ in 0..12 {
        let st = f.state();
        if st.graduated { break }
        accrued = st.lp_bonus;
        let _ = f.buy(&alice, amt(10));
    }
    let st = f.state();
    assert!(st.migrated, "the curve never graduated");
    assert!(accrued > Uint128::zero(), "no premium was accrued during the decay");
    assert_eq!(st.lp_bonus, Uint128::zero(), "the premium was not moved into the pool");
    assert_eq!(
        f.balance(&f.addr, QUOTE),
        st.pool_quote + st.creator_owed + st.platform_owed,
        "quote held does not equal pool plus fees: premium stranded or leaked"
    );
    f.assert_solvent();
}

#[test]
fn the_decay_is_measured_from_the_start_time_not_from_creation() {
    /*
     * A launch announced in advance would otherwise spend its whole opening premium
     * before anyone was allowed to trade: the rule set, displayed, and doing nothing.
     * That is the quietest way for this feature to fail, because the configuration
     * still reads correctly afterwards.
     */
    let open_at = {
        let f = setup();
        f.app.block_info().time.plus_seconds(500)
    };
    let mut f = setup_with(LaunchRules {
        max_per_wallet: None,
        trade_start: Some(open_at),
        early_fee: Some(curve::state::EarlyFee { start_bps: 1_100, seconds: 1_000 }),
    });
    let alice = f.alice.clone();

    // Move to exactly the opening. The decay has not started, so the first buyer pays
    // the full opening fee even though 500 seconds have passed since creation.
    f.app.update_block(|b| b.time = open_at);
    f.buy(&alice, amt(10)).unwrap();
    let at_open = f.balance(&alice, TOKEN);

    // The same launch, opening immediately, bought at the same block height offset.
    let mut g = setup_with(with_early_fee(1_100, 1_000));
    let a2 = g.alice.clone();
    g.app.update_block(|b| b.time = b.time.plus_seconds(500));
    g.buy(&a2, amt(10)).unwrap();
    let half_decayed = g.balance(&a2, TOKEN);

    assert!(
        half_decayed > at_open,
        "the delayed launch had already decayed before it opened: {at_open} vs {half_decayed}"
    );
    f.assert_solvent();
}

#[test]
fn a_buy_that_fills_the_curve_during_the_opening_window_refunds_in_full() {
    /*
     * The refund path crossed with the premium, which is the one combination where
     * the accounting can leak.
     *
     * The premium is charged on what is SPENT, so the curve is quoted twice: once to
     * learn what it cannot absorb, then again on the remainder. That leaves two
     * refunds to hand back, and mutation testing showed dropping the first one broke
     * nothing, because no test had ever filled a curve while an opening fee was
     * running. Money the contract keeps and does not owe anyone is the quietest
     * possible hole.
     *
     * Asserted on the BUYER'S BALANCE rather than on an attribute: an attribute can
     * report a refund that was never sent.
     */
    let mut f = setup_with(with_early_fee(1_100, 100_000));
    let alice = f.alice.clone();

    // Fill most of the curve, then send far more than it can still take.
    for _ in 0..8 {
        if f.state().graduated { break }
        let _ = f.buy(&alice, amt(10));
    }
    assert!(!f.state().graduated, "the curve filled before the oversized buy");

    let before = f.balance(&alice, QUOTE);
    let sent = amt(400);
    assert!(before >= sent, "the fixture cannot fund the oversized buy");
    f.buy(&alice, sent).unwrap();
    let spent = before - f.balance(&alice, QUOTE);

    assert!(f.state().graduated, "the oversized buy did not fill the curve");
    assert!(
        spent < sent,
        "nothing was refunded on a buy that filled the curve: sent {sent}, spent {spent}"
    );
    /*
     * The contract may keep only what it accounts for. Anything else is quote it is
     * holding on nobody's behalf, which `assert_solvent` cannot see because solvency
     * asks whether it holds ENOUGH, never whether it holds too much.
     */
    let st = f.state();
    let accounted =
        st.inj_collected + st.platform_owed + st.creator_owed + st.lp_bonus + st.pool_quote;
    let held = f.balance(&f.addr, QUOTE);
    assert_eq!(
        held, accounted,
        "the contract holds {held} but accounts for {accounted}: the difference was not refunded"
    );
    f.assert_solvent();
}

#[test]
fn the_wallet_cap_follows_the_recipient_not_the_payer() {
    /*
     * The way a cap gets walked around, and the reason `recipient` needed thinking
     * about rather than just adding.
     *
     * A curve pays whoever is named, so if the cap were keyed on the PAYER then
     * someone could buy from a fresh address every time and direct every purchase to
     * one wallet. Each payer would look untouched, the cap would never bind, and the
     * destination would accumulate without limit: the exact outcome the rule exists
     * to prevent, achieved without doing anything the contract calls unusual.
     *
     * Mutation testing found this uncovered. Nothing here had ever bought on behalf of
     * anyone, so keying the cap on `info.sender` passed every test.
     */
    let one_buy = quoted_tokens(&setup(), amt(1));
    let cap = one_buy + one_buy / Uint128::new(2);
    let mut f = setup_with(LaunchRules {
        max_per_wallet: Some(cap),
        trade_start: None,
        early_fee: None,
    });
    let alice = f.alice.clone();
    let bob = f.bob.clone();

    // Alice pays, Bob receives. Bob's allowance is what gets used.
    f.app
        .execute_contract(
            alice.clone(),
            f.addr.clone(),
            &ExecuteMsg::Buy {
                min_tokens_out: Uint128::zero(),
                recipient: Some(bob.to_string()),
            },
            &coins(amt(1).u128(), QUOTE),
        )
        .unwrap();
    assert!(f.balance(&bob, TOKEN) > Uint128::zero(), "the recipient got nothing");
    assert_eq!(f.balance(&alice, TOKEN), Uint128::zero(), "the payer was given the tokens");

    // A second buy to Bob, paid by Alice again, must now be refused: Bob holds.
    let err = f
        .app
        .execute_contract(
            alice.clone(),
            f.addr.clone(),
            &ExecuteMsg::Buy {
                min_tokens_out: Uint128::zero(),
                recipient: Some(bob.to_string()),
            },
            &coins(amt(1).u128(), QUOTE),
        )
        .unwrap_err();
    assert!(
        format!("{err:#}").contains("caps a wallet"),
        "a fresh payer walked around the cap: {err:#}"
    );

    // And Alice's own allowance is untouched, because she never received anything.
    f.buy(&alice, amt(1)).expect("the payer's own allowance was consumed");
    f.assert_solvent();
}

#[test]
fn a_malformed_recipient_is_refused_by_name() {
    // An unvalidated string would reach the bank module, which fails the transaction
    // with its own error about an address rather than saying which field was wrong.
    let mut f = setup();
    let alice = f.alice.clone();
    let err = f
        .app
        .execute_contract(
            alice,
            f.addr.clone(),
            &ExecuteMsg::Buy {
                min_tokens_out: Uint128::zero(),
                recipient: Some("not-an-address".into()),
            },
            &coins(amt(1).u128(), QUOTE),
        )
        .unwrap_err();
    assert!(format!("{err:#}").to_lowercase().contains("address"), "{err:#}");
}

// ------------------------------------------------------------ randomised runs --

/// A tiny deterministic generator, so a failing run names its seed and replays exactly.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Every unit of quote and every token is somewhere, and the contract's books say
/// exactly what it holds. Exact equalities, not `>=`: a surplus is a unit stranded on
/// nobody's behalf, and solvency checks cannot see it.
fn assert_books(f: &Fixture, seed: u64, step: usize, quote_total: Uint128) {
    let st = f.state();
    let held_q = f.balance(&f.addr, QUOTE);
    let books_q =
        st.inj_collected + st.lp_bonus + st.pool_quote + st.creator_owed + st.platform_owed;
    assert_eq!(held_q, books_q, "seed {seed} step {step}: quote held != books");

    let held_t = f.balance(&f.addr, TOKEN);
    let books_t = if st.migrated {
        st.pool_tokens
    } else {
        curve_cfg().curve_supply - st.tokens_sold + lp_reserve()
    };
    assert_eq!(held_t, books_t, "seed {seed} step {step}: tokens held != books");

    let everyone = [&f.alice, &f.bob, &f.creator, &f.platform, &f.migration, &f.addr];
    let q: Uint128 = everyone.iter().map(|a| f.balance(a, QUOTE)).sum();
    let t: Uint128 = everyone.iter().map(|a| f.balance(a, TOKEN)).sum();
    assert_eq!(q, quote_total, "seed {seed} step {step}: quote created or destroyed");
    assert_eq!(t, curve_cfg().curve_supply + lp_reserve(), "seed {seed} step {step}: tokens created or destroyed");
    // Nothing is ever sent to the old migration address.
    assert!(f.balance(&f.migration, QUOTE).is_zero() && f.balance(&f.migration, TOKEN).is_zero());
}

fn random_run(seed: u64, rules: LaunchRules) -> bool {
    let mut f = setup_with(rules);
    let mut rng = Lcg(seed);
    let traders = [f.alice.clone(), f.bob.clone()];
    let quote_total = amt(2_000);
    let mut graduated_at = None;

    for step in 0..80 {
        let who = traders[rng.below(2) as usize].clone();
        match rng.below(10) {
            // Buys from dust to whale, weighted toward the middle.
            0..=4 => {
                let size = match rng.below(4) {
                    0 => Uint128::new(rng.below(1_000_000_000) as u128 + 1),
                    1 => amt(rng.below(3) as u128 + 1),
                    2 => amt(rng.below(15) as u128 + 1),
                    _ => amt(rng.below(60) as u128 + 1),
                };
                if f.balance(&who, QUOTE) >= size {
                    let _ = f.buy(&who, size);
                }
            }
            // Sells of a random fraction of what the trader holds.
            5..=8 => {
                let held = f.balance(&who, TOKEN);
                if !held.is_zero() {
                    let frac = rng.below(100) as u128 + 1;
                    let _ = f.sell(&who, held.multiply_ratio(frac, 100u128).max(Uint128::one()));
                }
            }
            _ => {
                let _ = f.app.execute_contract(who, f.addr.clone(), &ExecuteMsg::ClaimFees {}, &[]);
            }
        }
        if graduated_at.is_none() && f.state().migrated {
            graduated_at = Some(step);
        }
        assert_books(&f, seed, step, quote_total);
        f.assert_solvent();
    }

    // Whatever happened, both traders can always exit what they hold, and the books
    // still balance after they do.
    for who in traders.clone() {
        let held = f.balance(&who, TOKEN);
        if !held.is_zero() {
            f.sell(&who, held).unwrap_or_else(|e| panic!("seed {seed}: exit refused: {e}"));
        }
    }
    let _ = f.app.execute_contract(f.alice.clone(), f.addr.clone(), &ExecuteMsg::ClaimFees {}, &[]);
    assert_books(&f, seed, usize::MAX, quote_total);
    graduated_at.is_some()
}

#[test]
fn random_trading_across_graduation_keeps_exact_books() {
    let mut graduated = 0;
    for seed in 1..=24u64 {
        if random_run(seed, Default::default()) {
            graduated += 1;
        }
    }
    // The property is only interesting if the runs actually cross the boundary.
    assert!(graduated >= 6, "only {graduated} of 24 runs graduated; widen the sizes");
}

#[test]
fn random_trading_with_an_opening_fee_keeps_exact_books() {
    let mut graduated = 0;
    for seed in 101..=112u64 {
        if random_run(seed, with_early_fee(1_100, 100_000)) {
            graduated += 1;
        }
    }
    assert!(graduated >= 3, "only {graduated} of 12 runs graduated");
}
