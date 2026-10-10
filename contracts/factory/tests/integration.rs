//! Factory tests.
//!
//! The one that matters most is `reply_captures_the_curve_address`: if the
//! reply handler fails to read the child's address, the launch is created,
//! funded, and then unreachable forever. That is the failure mode of this
//! pattern, so it gets tested directly.

use cosmwasm_std::{coin, coins, Addr, Empty, Uint128};
use cw_multi_test::{App, AppBuilder, BankSudo, Contract, ContractWrapper, Executor, SudoMsg};

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
    /// Carried so a test can assert the platform was PAID, not merely configured.
    platform: Addr,
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
                    // Quote as well as tokens: a creator making an opening buy pays
                    // with it in the same transaction, and the fixture funded only
                    // the seed, so the bank refused the subtraction with "Cannot Sub"
                    // rather than anything naming a balance.
                    coin(amt(100).u128(), QUOTE),
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

    Fx { app, factory, admin, creator, buyer, platform }
}

impl Fx {
    fn create(&mut self, denom: &str) -> anyhow::Result<()> {
        // Absent links are a valid profile, and the default path deserves the coverage.
        self.create_with(denom, Default::default())
    }

    fn create_with(&mut self, denom: &str, profile: TokenProfile) -> anyhow::Result<()> {
        // An open launch: no cap, no start time.
        self.create_full(denom, profile, Default::default())
    }

    fn create_full(
        &mut self,
        denom: &str,
        profile: TokenProfile,
        rules: LaunchRules,
    ) -> anyhow::Result<()> {
        self.app
            .execute_contract(
                self.creator.clone(),
                self.factory.clone(),
                &ExecuteMsg::CreateLaunch {
                    denom: denom.into(),
                    lp_reserve: lp_reserve(),
                    curve: curve_cfg(),
                    profile,
                    rules,
                    initial_buy: None,
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
            &CurveExec::Buy { min_tokens_out: Uint128::zero(), recipient: None },
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
            profile: Default::default(),
            rules: Default::default(),
            initial_buy: None,
            denom: TOKEN.into(),
            lp_reserve: lp_reserve(),
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
            profile: Default::default(),
            rules: Default::default(),
            initial_buy: None,
            denom: TOKEN.into(),
            lp_reserve: lp_reserve(),
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

// ---------------------------------------------------------------- token profile --

use curve::state::LaunchRules;
use factory::{TokenProfile, MAX_URI_LEN};

fn profile_with(field: &str, value: &str) -> TokenProfile {
    let v = Some(value.to_string());
    match field {
        "image" => TokenProfile { image: v, ..Default::default() },
        "website" => TokenProfile { website: v, ..Default::default() },
        "x" => TokenProfile { x: v, ..Default::default() },
        "telegram" => TokenProfile { telegram: v, ..Default::default() },
        other => panic!("no such field {other}"),
    }
}

#[test]
fn a_profile_with_no_links_is_valid() {
    // Absent is the honest answer for a token with nothing to link to, and it is the
    // default, so the common path must not need a single character of input.
    assert!(TokenProfile::default().validate().is_ok());
}

#[test]
fn https_and_ipfs_are_accepted_on_every_field() {
    for field in ["image", "website", "x", "telegram"] {
        assert!(
            profile_with(field, "https://example.org/a.png").validate().is_ok(),
            "{field} refused https"
        );
        assert!(
            profile_with(field, "ipfs://bafyexampleexampleexample").validate().is_ok(),
            "{field} refused ipfs"
        );
    }
}

#[test]
fn a_script_url_is_refused_on_every_field() {
    /*
     * The reason this validation exists at all. These fields become `href` and `src`
     * in a frontend, and a `javascript:` URL there is script execution in the context
     * of the launchpad, triggered by any visitor who clicks a token's own website
     * link. `data:text/html` is the same thing wearing a different hat.
     *
     * Checked per field rather than once, because the loop that validates them is
     * exactly the kind of thing that gets written for one field and copied for three.
     */
    for field in ["image", "website", "x", "telegram"] {
        for bad in [
            "javascript:alert(1)",
            "data:text/html;base64,PHNjcmlwdD4=",
            "http://example.org/a.png",
            "vbscript:msgbox(1)",
            "file:///etc/passwd",
            "//example.org/a.png",
            "example.org",
        ] {
            assert!(
                profile_with(field, bad).validate().is_err(),
                "{field} accepted {bad}"
            );
        }
    }
}

#[test]
fn the_scheme_check_is_case_insensitive() {
    /*
     * `JavaScript:` is script in every browser, and a check that compares against the
     * lowercase literal waves it through. This is the single mutation most likely to
     * pass review, because the string it is compared against looks right.
     */
    for bad in ["JavaScript:alert(1)", "JAVASCRIPT:alert(1)", "jAvAsCrIpT:alert(1)"] {
        assert!(
            profile_with("website", bad).validate().is_err(),
            "accepted {bad}"
        );
    }
    // And the allowlist still matches whatever case a creator types.
    assert!(profile_with("website", "HTTPS://example.org").validate().is_ok());
}

#[test]
fn an_empty_string_is_not_a_url() {
    /*
     * Left as `Some("")` a field renders as a link to the current page: it looks like a
     * working link, goes nowhere, and no error ever said so. `None` is how a missing
     * link is spelled.
     *
     * Kept after the branch that was written for it turned out to be unreachable: the
     * scheme check refuses all of these already. The behaviour is what matters and the
     * behaviour is still asserted, so if someone ever loosens the scheme check into
     * something that lets a blank through, this still fails.
     */
    for blank in ["", "   ", "\t"] {
        assert!(profile_with("website", blank).validate().is_err(), "accepted {blank:?}");
    }
}

#[test]
fn a_url_carrying_a_control_character_or_quote_is_refused() {
    // A newline is what lets a value break out of whatever renders it. Nothing
    // legitimate needs one, so the cheapest correct answer is to refuse them.
    for bad in [
        "https://example.org/a\npng",
        "https://example.org/\"onerror=alert(1)",
        "https://example.org/'><script>",
        "https://example.org/a\u{0}b",
    ] {
        assert!(profile_with("image", bad).validate().is_err(), "accepted {bad:?}");
    }
}

#[test]
fn an_overlong_url_is_refused() {
    // Storage is paid for and every query that returns a launch carries this.
    let long = format!("https://example.org/{}", "a".repeat(MAX_URI_LEN));
    assert!(long.len() > MAX_URI_LEN);
    assert!(profile_with("image", &long).validate().is_err());

    let ok = format!("https://e.org/{}", "a".repeat(MAX_URI_LEN - 20));
    assert!(ok.len() <= MAX_URI_LEN);
    assert!(profile_with("image", &ok).validate().is_ok());
}

#[test]
fn the_error_names_which_field_was_wrong() {
    // A form with four URL inputs and one rejection reading "invalid" leaves the
    // creator guessing which of the four to fix.
    let err = profile_with("telegram", "javascript:alert(1)").validate().unwrap_err();
    assert!(
        format!("{err}").contains("telegram"),
        "error does not name the field: {err}"
    );
}

#[test]
fn a_launch_carrying_a_script_url_is_refused_by_execute() {
    /*
     * The test that was missing, and its absence is the defect this suite is built to
     * catch in other people's code.
     *
     * `TokenProfile::validate` had eight tests and every one of them called it
     * directly. Deleting the `profile.validate()?` line from `create_launch` left all
     * eight passing: the validation was correct, thoroughly covered, and not reached.
     * Mutation testing found it; no amount of reading would have, because the call site
     * is one line in the middle of a function that does six other things.
     *
     * So this one goes through `execute_contract`, which is the path a creator's wallet
     * actually takes, and asserts the launch does not exist afterwards.
     */
    let mut f = setup();
    /*
     * Uses a FUNDED denom on purpose. With an unfunded one the execute fails for
     * insufficient funds and the test passes without the validation ever running,
     * which is the same false-pass this test exists to rule out. The assertion on the
     * field name is the second guard against that.
     */
    let res = f.create_with(
        TOKEN,
        TokenProfile {
            website: Some("javascript:alert(document.cookie)".into()),
            ..Default::default()
        },
    );
    assert!(res.is_err(), "a javascript: URL was accepted by execute");
    let err = res.unwrap_err().to_string();
    assert!(err.contains("website"), "the rejection does not name the field: {err}");

    // And nothing was written: no id consumed, no denom claimed, no half-made launch.
    assert!(
        f.app
            .wrap()
            .query_wasm_smart::<Launch>(f.factory.clone(), &QueryMsg::Launch { id: 1 })
            .is_err(),
        "a refused launch still created a record"
    );
}

#[test]
fn a_valid_profile_survives_the_round_trip_into_storage() {
    /*
     * The other half: a profile that passes must come back out of a query intact.
     * It crosses a submessage reply to get there, parked on `Pending`, which is the
     * kind of hop where a field quietly stops being carried and nothing complains.
     */
    let mut f = setup();
    let profile = TokenProfile {
        image: Some("ipfs://bafyexampleexampleexample".into()),
        website: Some("https://example.org".into()),
        x: Some("https://x.com/example".into()),
        telegram: None,
    };
    f.create_with(TOKEN, profile.clone()).unwrap();

    let stored = f.launch(1).profile;
    assert_eq!(stored, profile, "the profile did not survive the reply");
    assert_eq!(stored.telegram, None, "an absent link came back as something else");
}

// ------------------------------------------------------------- initial buy --

#[test]
fn an_initial_buy_sends_the_tokens_to_the_creator_not_the_factory() {
    /*
     * The property the whole feature turns on.
     *
     * A curve pays whoever sent the message, and the sender here is the FACTORY: it
     * spends the creator's attached quote in the reply, after the curve exists. Without
     * a recipient the factory would be the buyer of record and would sit holding the
     * tokens, which is both the wrong outcome and a fund-holding factory, the one thing
     * this contract's own tests assert it never becomes.
     *
     * Asserted on balances rather than on an attribute: an attribute can report a
     * transfer that was never sent.
     */
    let mut f = setup();
    let creator = f.creator.clone();
    // 2 INJ takes 8.30% of supply on this curve, inside the 10% opening-buy cap.
    // It was 5 INJ (19.00%), which the cap now refuses: this test is about WHERE the
    // tokens land, not about how many, so it uses a legal amount.
    let spend = amt(2);

    f.app
        .execute_contract(
            creator.clone(),
            f.factory.clone(),
            &ExecuteMsg::CreateLaunch {
                denom: TOKEN.into(),
                lp_reserve: lp_reserve(),
                curve: curve_cfg(),
                profile: Default::default(),
                rules: Default::default(),
                initial_buy: Some(spend),
            },
            &[
                coin(seed_total().u128(), TOKEN),
                coin(spend.u128(), QUOTE),
            ],
        )
        .unwrap();

    let launch = f.launch(1);
    assert!(
        f.balance(&creator, TOKEN) > Uint128::zero(),
        "the creator received no tokens from their own opening buy"
    );
    assert_eq!(
        f.balance(&f.factory, TOKEN),
        Uint128::zero(),
        "the factory is holding launch tokens"
    );
    assert_eq!(
        f.balance(&f.factory, QUOTE),
        Uint128::zero(),
        "the factory is holding quote"
    );
    // And the quote reached the curve, which is what backs the tokens handed out.
    assert!(f.balance(&launch.curve, QUOTE) > Uint128::zero());
}

#[test]
fn the_attached_quote_must_match_the_declared_initial_buy() {
    /*
     * Both directions refused, and both for a concrete reason. Too little and the buy
     * fails inside the reply, taking the whole launch down after the creator has
     * already signed. Too much and the surplus has nowhere to go, because the reply
     * spends exactly what was declared, so the factory would keep it.
     */
    for attached in [amt(4), amt(6), amt(0)] {
        let mut f = setup();
        let creator = f.creator.clone();
        let mut funds = vec![coin(seed_total().u128(), TOKEN)];
        if !attached.is_zero() {
            funds.push(coin(attached.u128(), QUOTE));
        }
        let res = f.app.execute_contract(
            creator,
            f.factory.clone(),
            &ExecuteMsg::CreateLaunch {
                denom: TOKEN.into(),
                lp_reserve: lp_reserve(),
                curve: curve_cfg(),
                profile: Default::default(),
                rules: Default::default(),
                initial_buy: Some(amt(5)),
            },
            &funds,
        );
        assert!(res.is_err(), "{attached} was accepted against a declared 5");
    }
}

#[test]
fn a_launch_with_no_initial_buy_still_takes_exactly_the_seed() {
    // The default path, which must not have been loosened by making room for a second
    // denom. Attaching quote without declaring a buy is refused.
    let mut f = setup();
    let creator = f.creator.clone();
    let res = f.app.execute_contract(
        creator,
        f.factory.clone(),
        &ExecuteMsg::CreateLaunch {
            denom: TOKEN.into(),
            lp_reserve: lp_reserve(),
            curve: curve_cfg(),
            profile: Default::default(),
            rules: Default::default(),
            initial_buy: None,
        },
        &[coin(seed_total().u128(), TOKEN), coin(amt(1).u128(), QUOTE)],
    );
    assert!(res.is_err(), "undeclared quote was accepted");
}

#[test]
fn a_third_denom_is_refused_rather_than_kept() {
    /*
     * Funds the factory would be left holding with no path out. A contract that
     * silently keeps dust is how a fund-holding factory starts, and the seed check
     * used to catch this for free by accepting exactly one coin.
     */
    let mut f = setup();
    let creator = f.creator.clone();
    let res = f.app.execute_contract(
        creator,
        f.factory.clone(),
        &ExecuteMsg::CreateLaunch {
            denom: TOKEN.into(),
            lp_reserve: lp_reserve(),
            curve: curve_cfg(),
            profile: Default::default(),
            rules: Default::default(),
            initial_buy: None,
        },
        &[
            coin(seed_total().u128(), TOKEN),
            coin(1, "factory/inj1launch/AAA"),
        ],
    );
    assert!(res.is_err(), "an unrelated denom was accepted and kept");
}

#[test]
fn the_factory_refuses_a_bad_seed_itself_rather_than_leaving_it_to_the_curve() {
    /*
     * Mutation testing showed the factory's seed check could be deleted entirely and
     * every test still passed, because the CURVE checks the seed too and the
     * transaction failed either way. Defence in depth is right; a check nothing can
     * tell is working is not, because the next person removes it as redundant.
     *
     * Asserted on the factory's own error text. Failing early also matters in itself:
     * it means a bad launch never consumes an id or a reply slot.
     */
    let mut f = setup();
    let creator = f.creator.clone();
    let res = f.app.execute_contract(
        creator,
        f.factory.clone(),
        &ExecuteMsg::CreateLaunch {
            denom: TOKEN.into(),
            lp_reserve: lp_reserve(),
            curve: curve_cfg(),
            profile: Default::default(),
            rules: Default::default(),
            initial_buy: None,
        },
        &[coin(seed_total().u128() - 1, TOKEN)],
    );
    let err = format!("{:#}", res.unwrap_err());
    assert!(
        err.contains("seed") || err.contains("expected"),
        "the refusal does not name the seed: {err}"
    );
}

/*
 * ---------------------------------------------------------------------------
 * The fixed supply, and the platform's floor on every fee.
 *
 * Both are the same kind of guarantee: a number a visitor is invited to compare
 * across the whole board, which only means anything if a creator cannot set it.
 * Both are therefore tested by trying to set them, not by reading them back.
 * ---------------------------------------------------------------------------
 */

/// Create with an arbitrary split and total, so a test can aim at the guard
/// rather than at the fixture.
fn create_sized(
    f: &mut Fx,
    denom: &str,
    curve_supply: Uint128,
    lp: Uint128,
) -> Result<(), String> {
    let mut curve = curve_cfg();
    curve.curve_supply = curve_supply;
    // `virtual_tokens` must stay above `curve_supply` or the curve's own
    // validation refuses first and the test proves nothing about this guard.
    curve.virtual_tokens = curve_supply * Uint128::new(13_413) / Uint128::new(10_000);
    let seed = curve_supply + lp;
    f.app
        .execute_contract(
            f.creator.clone(),
            f.factory.clone(),
            &ExecuteMsg::CreateLaunch {
                denom: denom.into(),
                lp_reserve: lp,
                curve,
                profile: Default::default(),
                rules: Default::default(),
                initial_buy: None,
            },
            &coins(seed.u128(), denom),
        )
        .map(|_| ())
        /*
         * The ALTERNATE form, which is what carries the contract's own sentence.
         * Plain `to_string()` on the error cw_multi_test returns gives only the
         * outer "Error executing WasmMsg" frame, so an assertion written against
         * it passes for every possible rejection and tests nothing.
         */
        .map_err(|e| format!("{e:#}"))
}

/// The curve contract's own config, which is where `lp_reserve` and the fee split
/// actually live: `Launch` carries only what the factory indexes.
fn curve_config(f: &Fx, id: u64) -> curve::state::Config {
    let l = f.launch(id);
    f.app
        .wrap()
        .query_wasm_smart(l.curve.clone(), &CurveQuery::Config {})
        .unwrap()
}

#[test]
fn total_supply_is_fixed_at_one_billion() {
    let mut f = setup();
    assert_eq!(
        factory::FIXED_TOTAL_SUPPLY,
        amt(1_000_000_000),
        "the constant is not one billion at 18 decimals"
    );
    // The fixture's own 800M/200M split is the fixed total, so the happy path
    // is the default one every other test in this file already exercises.
    assert_eq!(seed_total(), factory::FIXED_TOTAL_SUPPLY);
    create_sized(&mut f, TOKEN, amt(800_000_000), amt(200_000_000)).unwrap();
}

#[test]
fn a_larger_total_is_refused() {
    let mut f = setup();
    /*
     * Minted first, and this is not incidental. The creator is seeded with exactly
     * the fixed supply, so attaching more than 1B fails in the BANK MODULE with
     * "Cannot Sub" before the factory runs at all. The first version of this test
     * passed on that error, which means it asserted the creator was poor rather
     * than that the supply is fixed. Rule 48: a rejection is only evidence when it
     * came from the thing being tested.
     */
    let creator = f.creator.clone();
    f.app
        .sudo(SudoMsg::Bank(BankSudo::Mint {
            to_address: creator.to_string(),
            amount: coins(amt(1_000_000_000).u128(), TOKEN),
        }))
        .unwrap();

    let err = create_sized(&mut f, TOKEN, amt(800_000_000), amt(400_000_000))
        .expect_err("1.2B was accepted");
    assert!(
        err.contains("exactly") && err.contains("tokens"),
        "the refusal does not name the fixed supply: {err}"
    );
}

#[test]
fn a_smaller_total_is_refused() {
    let mut f = setup();
    /*
     * The interesting direction. A creator who launches 10M tokens rather than 1B
     * gets a token priced 100x higher per unit on the same curve, so every market
     * cap on the board becomes incomparable, and nothing about the launch looks
     * wrong on its own card.
     */
    let err = create_sized(&mut f, TOKEN, amt(8_000_000), amt(2_000_000))
        .expect_err("10M was accepted");
    assert!(
        err.contains("exactly") && err.contains("tokens"),
        "the refusal does not name the fixed supply: {err}"
    );
}

#[test]
fn off_by_one_base_unit_is_refused() {
    let mut f = setup();
    /*
     * The guard is equality, not a tolerance, and this is what distinguishes it
     * from a bounds check that would let a rounding error through. One base unit
     * of 1e-18 of a token is economically nothing, which is the point: there is no
     * threshold here to find.
     */
    let lp = lp_reserve() - Uint128::one();
    let err = create_sized(&mut f, TOKEN, curve_cfg().curve_supply, lp)
        .expect_err("one base unit short was accepted");
    assert!(err.contains("exactly"), "unexpected refusal: {err}");
}

#[test]
fn the_split_between_curve_and_reserve_is_still_the_creators() {
    let mut f = setup();
    /*
     * Only the TOTAL is fixed. A creator who wants half the supply held back for
     * liquidity rather than a fifth is making a legitimate choice about their own
     * launch, and a guard that refused it would be enforcing a shape nobody asked
     * for under the name of a supply guarantee.
     */
    create_sized(&mut f, TOKEN, amt(500_000_000), amt(500_000_000)).unwrap();
    let cfg = curve_config(&f, 1);
    assert_eq!(cfg.lp_reserve, amt(500_000_000));
    assert_eq!(cfg.curve.curve_supply, amt(500_000_000));
}

#[test]
fn the_platform_earns_a_fixed_share_of_every_fee() {
    let mut f = setup();
    /*
     * THE DEFECT THIS PINS. `creator_fee_share_bps` used to arrive on `CreateLaunch`,
     * capped at 10_000 bps, which is the whole fee. A creator setting it to the
     * maximum is not an attack, it is the rational move, so the platform's cut
     * accrued on every trade and the amount it accrued was zero: a fee that was
     * modelled, routed, claimable, and guaranteed to be empty.
     *
     * The field is gone. The split is policy, at the 70/30 both comparable
     * launchpads use, and a launch cannot opt out of it because there is nothing
     * left to set.
     */
    assert_eq!(factory::CREATOR_FEE_SHARE_BPS, 7_000);
    create_sized(&mut f, TOKEN, amt(800_000_000), amt(200_000_000)).unwrap();
    assert_eq!(
        curve_config(&f, 1).creator_fee_share_bps,
        factory::CREATOR_FEE_SHARE_BPS,
        "the launched curve does not carry the policy split"
    );
}

#[test]
fn the_platform_is_actually_paid_its_share() {
    let mut f = setup();
    /*
     * End to end, because every check above is about configuration and a share that
     * is configured and never paid is the failure this project keeps finding. Buy,
     * claim, and read the platform's bank balance.
     */
    create_sized(&mut f, TOKEN, amt(800_000_000), amt(200_000_000)).unwrap();
    let curve = f.launch(1).curve;
    let platform = f.platform.clone();
    assert!(f.balance(&platform, QUOTE).is_zero(), "platform starts clean");

    let spend = amt(10);
    f.app
        .execute_contract(
            f.buyer.clone(),
            curve.clone(),
            &CurveExec::Buy { min_tokens_out: Uint128::zero(), recipient: None },
            &coins(spend.u128(), QUOTE),
        )
        .unwrap();

    let st: CurveState = f
        .app
        .wrap()
        .query_wasm_smart(curve.clone(), &CurveQuery::State {})
        .unwrap();
    assert!(!st.platform_owed.is_zero(), "nothing accrued to the platform");
    // 30% of the fee, which at 100 bps on a 10 INJ buy is 0.1 INJ of fee.
    let total_fee = st.platform_owed + st.creator_owed;
    assert_eq!(
        st.platform_owed,
        total_fee - total_fee * Uint128::new(7_000) / Uint128::new(10_000),
        "the accrued split is not 70/30"
    );

    f.app
        .execute_contract(f.buyer.clone(), curve, &CurveExec::ClaimFees {}, &[])
        .unwrap();
    assert_eq!(
        f.balance(&platform, QUOTE),
        st.platform_owed,
        "the platform's share was accrued and never paid"
    );
}

/// Create with an opening buy, which needs quote attached alongside the supply.
fn create_with_dev_buy(f: &mut Fx, denom: &str, spend: Uint128) -> Result<(), String> {
    let seed = seed_total();
    f.app
        .execute_contract(
            f.creator.clone(),
            f.factory.clone(),
            &ExecuteMsg::CreateLaunch {
                denom: denom.into(),
                lp_reserve: lp_reserve(),
                curve: curve_cfg(),
                profile: Default::default(),
                rules: Default::default(),
                initial_buy: Some(spend),
            },
            &[coin(seed.u128(), denom), coin(spend.u128(), QUOTE)],
        )
        .map(|_| ())
        .map_err(|e| format!("{e:#}"))
}

#[test]
fn a_creator_cannot_take_the_curve_in_their_own_opening_buy() {
    let mut f = setup();
    /*
     * `initial_buy` was unbounded. A creator could take most of the curve at the
     * opening price in the same transaction that created the launch, before any other
     * address could see the token existed. The create form warned about the share, and
     * warned is all it did.
     *
     * 40 INJ against the default curve takes 76.31% of the supply, measured.
     */
    let err = create_with_dev_buy(&mut f, TOKEN, amt(40)).expect_err("the dev took the curve");
    assert!(
        err.contains("the most a creator may take"),
        "the refusal does not name the cap: {err}"
    );
}

#[test]
fn a_modest_opening_buy_is_still_allowed() {
    let mut f = setup();
    /*
     * The cap must not refuse the ordinary case. A creator buying a small opening
     * position is the normal, disclosed thing every launchpad supports, and a cap that
     * blocked it would have removed a feature rather than bounded one.
     */
    // 1 INJ takes 4.28% of supply on the default curve, measured: comfortably
    // inside the cap and the sort of opening position a creator actually makes.
    create_with_dev_buy(&mut f, TOKEN, amt(1)).unwrap();
    let l = f.launch(1);
    let st: CurveState = f
        .app
        .wrap()
        .query_wasm_smart(l.curve, &CurveQuery::State {})
        .unwrap();
    let ceiling = curve_cfg()
        .curve_supply
        .multiply_ratio(factory::MAX_INITIAL_BUY_BPS, 10_000u128);
    assert!(!st.tokens_sold.is_zero(), "the opening buy did not execute");
    assert!(st.tokens_sold <= ceiling, "an allowed buy exceeded the cap");
}

#[test]
fn the_cap_is_measured_in_supply_not_in_quote() {
    let mut f = setup();
    /*
     * THE REASON THE CAP READS TOKENS. The same quote buys a wildly different share
     * depending on the curve, so a cap on the attached amount is one a creator designs
     * around in a single field: halve `virtual_inj` and the same INJ takes far more of
     * the supply. Here the shape is made cheap and the identical spend that passes on
     * the default curve must now be refused.
     */
    let cheap = amt(2);
    create_with_dev_buy(&mut f, TOKEN, cheap).expect("the control case should pass");

    let mut f2 = setup();
    let mut steep = curve_cfg();
    /*
     * A smaller opening reserve, so the same INJ buys far more of the curve, AND a
     * lower graduation target so the curve stays reachable. The first attempt used
     * `virtual_inj = 1` alone and was refused by curve validation ("graduation target
     * can never be reached") before the cap was ever consulted: the test passed its
     * own assertion on a rejection from a different guard entirely.
     */
    steep.virtual_inj = amt(10);
    steep.graduation_target = amt(25);
    let seed = seed_total();
    let err = f2
        .app
        .execute_contract(
            f2.creator.clone(),
            f2.factory.clone(),
            &ExecuteMsg::CreateLaunch {
                denom: TOKEN.into(),
                lp_reserve: lp_reserve(),
                curve: steep,
                profile: Default::default(),
                rules: Default::default(),
                initial_buy: Some(cheap),
            },
            &[coin(seed.u128(), TOKEN), coin(cheap.u128(), QUOTE)],
        )
        .map(|_| ())
        .map_err(|e| format!("{e:#}"))
        .expect_err("the same spend took an unbounded share on a steeper curve");
    assert!(
        err.contains("the most a creator may take"),
        "refused for the wrong reason: {err}"
    );
}

#[test]
fn the_opening_buy_cap_is_a_share_of_the_curve_not_of_the_total_supply() {
    let mut f = setup();
    /*
     * ADDED AFTER A MUTATION ESCAPED. Changing the ceiling to
     * `(curve_supply + lp_reserve) * bps` loosened the cap by a quarter and every
     * test above still passed, because none of them used an amount that falls
     * between the two bases.
     *
     * With the default 800M/200M split: 10% of the curve is 80,000,000 tokens and
     * 10% of the total is 100,000,000. A 2.5 INJ opening buy takes 81,775,982
     * (measured), which sits between them. It must be refused.
     *
     * The curve supply is the right basis because it is what is actually purchasable:
     * the reserve is held back for the pool and nobody can buy it, so counting it
     * would let a creator take a larger share of the tradable supply than the number
     * claims.
     */
    let between = amt(25) / Uint128::new(10);
    let err = create_with_dev_buy(&mut f, TOKEN, between)
        .expect_err("a buy above 10% of the curve was accepted");
    assert!(
        err.contains("the most a creator may take"),
        "refused for the wrong reason: {err}"
    );

    // And the ceiling named in the refusal is the curve's, not the total's.
    let curve_basis = curve_cfg()
        .curve_supply
        .multiply_ratio(factory::MAX_INITIAL_BUY_BPS, 10_000u128);
    assert!(
        err.contains(&curve_basis.to_string()),
        "the refusal names a ceiling other than 10% of the curve supply: {err}"
    );
}
