//! Factory tests.
//!
//! The one that matters most is `reply_captures_the_curve_address`: if the
//! reply handler fails to read the child's address, the launch is created,
//! funded, and then unreachable forever. That is the failure mode of this
//! pattern, so it gets tested directly.

use cosmwasm_std::{coin, coins, Addr, Empty, Uint128};
use cw_multi_test::{App, AppBuilder, Contract, ContractWrapper, Executor};

use curve::msg::{ExecuteMsg as CurveExec, QueryMsg as CurveQuery};
use curve::state::{CurveConfigStored, State as CurveState};
use factory::{Config, ExecuteMsg, InstantiateMsg, Launch, LaunchesResponse, QueryMsg};

const QUOTE: &str = "inj";
const TOKEN: &str = "factory/inj1launch/TEST";

fn one() -> Uint128 {
    Uint128::new(1_000_000_000_000_000_000)
}
fn amt(n: u128) -> Uint128 {
    Uint128::new(n) * one()
}
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

fn seed_total() -> Uint128 {
    curve_cfg().curve_supply + lp_reserve()
}

fn curve_contract() -> Box<dyn Contract<Empty>> {
    Box::new(ContractWrapper::new(
        curve::contract::execute,
        curve::contract::instantiate,
        curve::contract::query,
    ))
}

fn factory_contract() -> Box<dyn Contract<Empty>> {
    Box::new(
        ContractWrapper::new(factory::execute, factory::instantiate, factory::query)
            .with_reply(factory::reply),
    )
}

struct Fx {
    app: App,
    factory: Addr,
    admin: Addr,
    creator: Addr,
    buyer: Addr,
}

fn setup() -> Fx {
    let mut app = AppBuilder::new().build(|_, _, _| {});
    let api = app.api().clone();
    let admin = api.addr_make("admin");
    let creator = api.addr_make("creator");
    let buyer = api.addr_make("buyer");
    let platform = api.addr_make("platform");
    let migration = api.addr_make("migration");

    app.init_modules(|router, _, storage| {
        // Fund the creator with every denom the tests launch.
        router
            .bank
            .init_balance(
                storage,
                &creator,
                vec![
                    coin(seed_total().u128(), TOKEN),
                    coin(seed_total().u128(), "factory/inj1launch/AAA"),
                    coin(seed_total().u128(), "factory/inj1launch/BBB"),
                ],
            )
            .unwrap();
        router
            .bank
            .init_balance(storage, &buyer, coins(amt(500).u128(), QUOTE))
            .unwrap();
    });

    let curve_code = app.store_code(curve_contract());
    let factory_code = app.store_code(factory_contract());

    let factory = app
        .instantiate_contract(
            factory_code,
            admin.clone(),
            &InstantiateMsg {
                admin: admin.to_string(),
                curve_code_id: curve_code,
                platform: platform.to_string(),
                migration_target: migration.to_string(),
                quote_denom: QUOTE.into(),
            },
            &[],
            "factory",
            None,
        )
        .unwrap();

    Fx { app, factory, admin, creator, buyer }
}

impl Fx {
    fn create(&mut self, denom: &str) -> anyhow::Result<()> {
        self.app
            .execute_contract(
                self.creator.clone(),
                self.factory.clone(),
                &ExecuteMsg::CreateLaunch {
                    denom: denom.into(),
                    lp_reserve: lp_reserve(),
                    creator_fee_share_bps: 5_000,
                    curve: curve_cfg(),
                },
                &coins(seed_total().u128(), denom),
            )
            .map(|_| ())
            .map_err(|e| anyhow::anyhow!(e.to_string()))
    }
    fn launch(&self, id: u64) -> Launch {
        self.app
            .wrap()
            .query_wasm_smart(self.factory.clone(), &QueryMsg::Launch { id })
            .unwrap()
    }
    fn balance(&self, who: &Addr, denom: &str) -> Uint128 {
        self.app.wrap().query_balance(who, denom).unwrap().amount
    }
}

/// If this breaks, launches are funded and then stranded with no way to reach
/// the contract holding the money.
#[test]
fn reply_captures_the_curve_address() {
    let mut f = setup();
    f.create(TOKEN).unwrap();

    let l = f.launch(1);
    assert_eq!(l.id, 1);
    assert_eq!(l.denom, TOKEN);
    assert_eq!(l.creator, f.creator);

    // The recorded address must be a real, live curve contract.
    let st: CurveState = f
        .app
        .wrap()
        .query_wasm_smart(l.curve.clone(), &CurveQuery::State {})
        .unwrap();
    assert!(st.tokens_sold.is_zero());
    assert!(!st.graduated);
}

#[test]
fn seed_is_forwarded_and_the_factory_keeps_nothing() {
    let mut f = setup();
    f.create(TOKEN).unwrap();
    let l = f.launch(1);

    assert_eq!(
        f.balance(&l.curve, TOKEN),
        seed_total(),
        "curve was not funded with the full seed"
    );
    assert!(
        f.balance(&f.factory, TOKEN).is_zero(),
        "factory held on to launch funds"
    );
}

#[test]
fn a_launch_created_through_the_factory_actually_trades() {
    let mut f = setup();
    f.create(TOKEN).unwrap();
    let l = f.launch(1);
    let buyer = f.buyer.clone();

    f.app
        .execute_contract(
            buyer.clone(),
            l.curve.clone(),
            &CurveExec::Buy { min_tokens_out: Uint128::zero() },
            &coins(amt(10).u128(), QUOTE),
        )
        .unwrap();

    assert!(!f.balance(&buyer, TOKEN).is_zero(), "buyer got no tokens");
}

#[test]
fn duplicate_denom_is_refused() {
    let mut f = setup();
    f.create(TOKEN).unwrap();
    assert!(f.create(TOKEN).is_err(), "same denom launched twice");
}

#[test]
fn wrong_seed_amount_is_refused() {
    let mut f = setup();
    let creator = f.creator.clone();
    let res = f.app.execute_contract(
        creator,
        f.factory.clone(),
        &ExecuteMsg::CreateLaunch {
            denom: TOKEN.into(),
            lp_reserve: lp_reserve(),
            creator_fee_share_bps: 0,
            curve: curve_cfg(),
        },
        &coins(amt(1).u128(), TOKEN), // nowhere near the required seed
    );
    assert!(res.is_err(), "under-funded launch was accepted");
}

#[test]
fn an_unreachable_graduation_target_is_refused_at_creation() {
    let mut f = setup();
    let creator = f.creator.clone();
    let bad = CurveConfigStored {
        graduation_target: amt(10_000), // more than the supply can ever raise
        ..curve_cfg()
    };
    let res = f.app.execute_contract(
        creator,
        f.factory.clone(),
        &ExecuteMsg::CreateLaunch {
            denom: TOKEN.into(),
            lp_reserve: lp_reserve(),
            creator_fee_share_bps: 0,
            curve: bad,
        },
        &coins(seed_total().u128(), TOKEN),
    );
    assert!(res.is_err(), "stalled-by-design launch was accepted");
}

#[test]
fn ids_increment_and_the_registry_lists_them() {
    let mut f = setup();
    f.create("factory/inj1launch/AAA").unwrap();
    f.create("factory/inj1launch/BBB").unwrap();

    let res: LaunchesResponse = f
        .app
        .wrap()
        .query_wasm_smart(
            f.factory.clone(),
            &QueryMsg::Launches { start_after: None, limit: None },
        )
        .unwrap();
    assert_eq!(res.launches.len(), 2);
    assert_eq!(res.launches[0].id, 1);
    assert_eq!(res.launches[1].id, 2);
    assert_ne!(res.launches[0].curve, res.launches[1].curve);

    let by_denom: Launch = f
        .app
        .wrap()
        .query_wasm_smart(
            f.factory.clone(),
            &QueryMsg::LaunchByDenom { denom: "factory/inj1launch/BBB".into() },
        )
        .unwrap();
    assert_eq!(by_denom.id, 2);
}

#[test]
fn only_admin_can_repoint_the_curve_code() {
    let mut f = setup();
    let creator = f.creator.clone();
    let admin = f.admin.clone();

    assert!(
        f.app
            .execute_contract(
                creator,
                f.factory.clone(),
                &ExecuteMsg::SetCurveCodeId { code_id: 999 },
                &[]
            )
            .is_err(),
        "a stranger repointed the factory at arbitrary code"
    );

    f.app
        .execute_contract(
            admin,
            f.factory.clone(),
            &ExecuteMsg::SetCurveCodeId { code_id: 999 },
            &[],
        )
        .unwrap();

    let cfg: Config = f
        .app
        .wrap()
        .query_wasm_smart(f.factory.clone(), &QueryMsg::Config {})
        .unwrap();
    assert_eq!(cfg.curve_code_id, 999);
}
