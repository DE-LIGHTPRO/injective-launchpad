//! End-to-end tests against a simulated chain.
//!
//! The maths crate proves the curve cannot be drained in the abstract. These
//! prove the contract around it moves the right funds, keeps its books, and
//! stays solvent.

use cosmwasm_std::{coin, coins, Addr, Empty, Uint128};
use cw_multi_test::{App, AppBuilder, Contract, ContractWrapper, Executor};

use curve::msg::{ExecuteMsg, InstantiateMsg, QueryMsg, SimulateBuyResponse};
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
            .map_err(|e| anyhow::anyhow!(e.to_string()))
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
            .map_err(|e| anyhow::anyhow!(e.to_string()))
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
    assert!(err.is_err(), "slippage guard did not fire");
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
    assert!(err.is_err(), "sandwiched buy should have been rejected");
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

    assert!(f.buy(&alice, amt(1)).is_err(), "buying after graduation");
    let held = f.balance(&alice, TOKEN);
    assert!(f.sell(&alice, held).is_err(), "selling after graduation");
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
