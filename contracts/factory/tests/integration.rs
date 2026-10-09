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

    Fx { app, factory, admin, creator, buyer }
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
                    creator_fee_share_bps: 5_000,
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
            profile: Default::default(),
            rules: Default::default(),
            initial_buy: None,
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
    let spend = amt(5);

    f.app
        .execute_contract(
            creator.clone(),
            f.factory.clone(),
            &ExecuteMsg::CreateLaunch {
                denom: TOKEN.into(),
                lp_reserve: lp_reserve(),
                creator_fee_share_bps: 5_000,
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
                creator_fee_share_bps: 5_000,
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
            creator_fee_share_bps: 5_000,
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
            creator_fee_share_bps: 5_000,
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
            creator_fee_share_bps: 5_000,
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
