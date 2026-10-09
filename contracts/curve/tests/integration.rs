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

/// Tokens held back to pair against the collected INJ at migration.
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
                migration_target: migration.to_string(),
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
                &ExecuteMsg::Buy { min_tokens_out: Uint128::zero() },
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
        let owed = st.inj_collected + st.platform_owed + st.creator_owed;
        assert!(
            held >= owed,
            "insolvent: holds {held} {QUOTE}, owes {owed} (reserve {} + fees {})",
            st.inj_collected,
            st.platform_owed + st.creator_owed
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
            migration_target: creator.to_string(),
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
        &ExecuteMsg::Buy { min_tokens_out: sim.tokens_out + Uint128::one() },
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
        &ExecuteMsg::Buy { min_tokens_out: sim.tokens_out },
        &coins(amt(10).u128(), QUOTE),
    );
    let msg = format!("{:#}", err.unwrap_err());
    assert!(
        msg.contains("asked for at least"),
        "the sandwiched buy failed for some other reason: {msg}"
    );
    f.assert_solvent();
}

#[test]
fn curve_graduates_and_then_refuses_trades() {
    let mut f = setup();
    let alice = f.alice.clone();

    // Push past the 85 INJ target.
    for _ in 0..10 {
        if f.state().graduated {
            break;
        }
        let _ = f.buy(&alice, amt(10));
    }
    assert!(f.state().graduated, "curve never graduated");

    let buy_err = f.buy(&alice, amt(1)).unwrap_err().to_string();
    assert!(buy_err.contains("graduated"), "buying after graduation failed for another reason: {buy_err}");
    let held = f.balance(&alice, TOKEN);
    let sell_err = f.sell(&alice, held).unwrap_err().to_string();
    assert!(sell_err.contains("graduated"), "selling after graduation failed for another reason: {sell_err}");
    f.assert_solvent();
}

#[test]
fn graduation_moves_liquidity_once_and_only_once() {
    let mut f = setup();
    let alice = f.alice.clone();
    for _ in 0..10 {
        if f.state().graduated {
            break;
        }
        let _ = f.buy(&alice, amt(10));
    }
    assert!(f.state().graduated);

    let reserve = f.state().inj_collected;
    f.app
        .execute_contract(alice.clone(), f.addr.clone(), &ExecuteMsg::Graduate {}, &[])
        .unwrap();

    assert_eq!(f.balance(&f.migration, QUOTE), reserve, "reserve did not move");
    assert!(
        f.balance(&f.migration, TOKEN) >= lp_reserve(),
        "migrated pool got no token side: {} < reserved {}",
        f.balance(&f.migration, TOKEN),
        lp_reserve()
    );
    assert!(f.state().migrated);

    // A second attempt must fail, or the fee pot gets drained as "reserve".
    let twice =
        f.app
            .execute_contract(alice, f.addr.clone(), &ExecuteMsg::Graduate {}, &[]);
    assert!(twice.is_err(), "graduation ran twice");
}

#[test]
fn graduation_is_permissionless_but_not_premature() {
    let mut f = setup();
    let bob = f.bob.clone();

    // Nowhere near the target yet.
    f.buy(&bob, amt(1)).unwrap();
    let early = f
        .app
        .execute_contract(bob.clone(), f.addr.clone(), &ExecuteMsg::Graduate {}, &[]);
    assert!(early.is_err(), "graduated before reaching the target");

    // A stranger, not the creator, can finish it once the target is met.
    for _ in 0..10 {
        if f.state().graduated {
            break;
        }
        let _ = f.buy(&bob, amt(10));
    }
    f.app
        .execute_contract(bob, f.addr.clone(), &ExecuteMsg::Graduate {}, &[])
        .unwrap();
    assert!(f.state().migrated);
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

    f.app
        .execute_contract(alice.clone(), f.addr.clone(), &ExecuteMsg::Graduate {}, &[])
        .unwrap();

    // Migration must not have swept the fee pot.
    let s = f.state();
    assert_eq!(s.creator_owed, creator_owed);
    assert_eq!(s.platform_owed, platform_owed);

    f.app
        .execute_contract(alice, f.addr.clone(), &ExecuteMsg::ClaimFees {}, &[])
        .unwrap();
    assert_eq!(f.balance(&f.creator, QUOTE), creator_owed);
    assert_eq!(f.balance(&f.platform, QUOTE), platform_owed);
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
    let mut f = setup_with(LaunchRules { max_per_wallet: Some(cap), trade_start: None });
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
    let mut f = setup_with(LaunchRules { max_per_wallet: Some(cap), trade_start: None });
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
    let mut f = setup_with(LaunchRules { max_per_wallet: Some(cap), trade_start: None });
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
    let mut f = setup_with(LaunchRules { max_per_wallet: Some(cap), trade_start: None });
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
    let mut f = setup_with(LaunchRules { max_per_wallet: None, trade_start: Some(now) });
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
            setup_with(LaunchRules { max_per_wallet: Some(bad), trade_start: None })
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
    let mut f = setup_with(LaunchRules { max_per_wallet: Some(exact), trade_start: None });
    let alice = f.alice.clone();

    f.buy(&alice, amt(1)).expect("a buy landing exactly on the cap was refused");
    assert_eq!(f.balance(&alice, TOKEN), exact, "the fixture did not land on the cap");

    // And one base unit more is over it. Sized as small as the curve allows, so this
    // is about the boundary rather than about the size of the second order.
    let err = f.buy(&alice, Uint128::new(1_000)).unwrap_err().to_string();
    assert!(err.contains("caps a wallet"), "one unit over the cap was allowed: {err}");
    f.assert_solvent();
}
