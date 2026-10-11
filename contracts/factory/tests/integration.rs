//! Factory tests.
//!
//! The one that matters most is `reply_captures_the_curve_address`: if the
//! reply handler fails to read the child's address, the launch is created,
//! funded, and then unreachable forever. That is the failure mode of this
//! pattern, so it gets tested directly.

use cosmwasm_std::{coin, coins, Addr, Api, Binary, BlockInfo, CustomMsg, CustomQuery, Empty, Querier, Storage, Uint128};
use cw_multi_test::{
    App, AppBuilder, AppResponse, BankKeeper, BankSudo, Contract, ContractWrapper, CosmosRouter,
    DistributionKeeper, Executor, FailingModule, GovFailingModule, IbcFailingModule, StakeKeeper,
    Stargate, SudoMsg, WasmKeeper,
};
use cosmwasm_std::testing::{MockApi, MockStorage};
use cosmwasm_schema::serde::de::DeserializeOwned;

/// A stand-in for Injective's tokenfactory admin rule, which is the only part of that
/// module these contracts depend on: `MsgChangeAdmin` is refused unless its sender is
/// the denom's current admin.
///
/// A denom nobody has registered is treated as already administered by the factory,
/// which models what every launch transaction does first (the creator's own
/// `MsgChangeAdmin` to the factory), so the existing tests describe a well-formed
/// launch. `/test.SetAdmin` registers a different admin, which is how
/// `a_creator_who_keeps_the_mint_key_cannot_launch` models a creator who did not.
struct TokenFactorySim;

const TF_DEFAULT: &[u8] = b"tfsim:default";
fn tf_key(denom: &str) -> Vec<u8> {
    [b"tfsim:admin:".as_slice(), denom.as_bytes()].concat()
}

/// Decode the three length-delimited strings of a `MsgChangeAdmin`.
fn decode_change_admin(b: &[u8]) -> (String, String, String) {
    let mut fields = [String::new(), String::new(), String::new()];
    let mut i = 0;
    while i < b.len() {
        let tag = b[i] >> 3;
        i += 1;
        let (mut len, mut shift) = (0usize, 0);
        loop {
            let byte = b[i];
            i += 1;
            len |= ((byte & 0x7f) as usize) << shift;
            if byte & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        fields[(tag - 1) as usize] = String::from_utf8(b[i..i + len].to_vec()).unwrap();
        i += len;
    }
    let [a, d, n] = fields;
    (a, d, n)
}

impl Stargate for TokenFactorySim {
    fn execute_stargate<ExecC, QueryC>(
        &self,
        _api: &dyn Api,
        storage: &mut dyn Storage,
        _router: &dyn CosmosRouter<ExecC = ExecC, QueryC = QueryC>,
        _block: &BlockInfo,
        sender: Addr,
        type_url: String,
        value: Binary,
    ) -> anyhow::Result<AppResponse>
    where
        ExecC: CustomMsg + DeserializeOwned + 'static,
        QueryC: CustomQuery + DeserializeOwned + 'static,
    {
        match type_url.as_str() {
            "/test.DefaultAdmin" => storage.set(TF_DEFAULT, value.as_slice()),
            "/test.SetAdmin" => {
                let (denom, admin) = String::from_utf8(value.to_vec())?
                    .split_once('|')
                    .map(|(a, b)| (a.to_string(), b.to_string()))
                    .unwrap();
                storage.set(&tf_key(&denom), admin.as_bytes());
            }
            factory::MSG_CHANGE_ADMIN => {
                let (from, denom, to) = decode_change_admin(value.as_slice());
                anyhow::ensure!(from == sender.as_str(), "signer mismatch");
                let current = storage
                    .get(&tf_key(&denom))
                    .or_else(|| storage.get(TF_DEFAULT))
                    .unwrap_or_default();
                anyhow::ensure!(
                    current == from.as_bytes(),
                    "unauthorized account: {from} is not the admin of {denom}"
                );
                storage.set(&tf_key(&denom), to.as_bytes());
            }
            other => anyhow::bail!("unexpected stargate message {other}"),
        }
        Ok(AppResponse::default())
    }

    fn query_stargate(
        &self,
        _api: &dyn Api,
        storage: &dyn Storage,
        _querier: &dyn Querier,
        _block: &BlockInfo,
        path: String,
        data: Binary,
    ) -> anyhow::Result<Binary> {
        anyhow::ensure!(path == "/test.Admin", "unexpected stargate query {path}");
        let denom = String::from_utf8(data.to_vec())?;
        let admin = storage
            .get(&tf_key(&denom))
            .or_else(|| storage.get(TF_DEFAULT))
            .unwrap_or_default();
        Ok(cosmwasm_std::to_json_binary(&String::from_utf8(admin)?)?)
    }
}

type TestApp = App<
    BankKeeper,
    MockApi,
    MockStorage,
    FailingModule<Empty, Empty, Empty>,
    WasmKeeper<Empty, Empty>,
    StakeKeeper,
    DistributionKeeper,
    IbcFailingModule,
    GovFailingModule,
    TokenFactorySim,
>;

#[allow(deprecated)]
fn stargate(type_url: &str, value: Vec<u8>) -> cosmwasm_std::CosmosMsg {
    cosmwasm_std::CosmosMsg::Stargate { type_url: type_url.into(), value: Binary::from(value) }
}

fn denom_admin(app: &TestApp, denom: &str) -> String {
    #[allow(deprecated)]
    let q = cosmwasm_std::QueryRequest::Stargate {
        path: "/test.Admin".into(),
        data: Binary::from(denom.as_bytes().to_vec()),
    };
    app.wrap().query(&q).unwrap()
}

use curve::msg::{ExecuteMsg as CurveExec, QueryMsg as CurveQuery};
use curve::state::State as CurveState;
use factory::{Config, ExecuteMsg, InstantiateMsg, Launch, LaunchesResponse, QueryMsg};

const QUOTE: &str = "inj";
const TOKEN: &str = "factory/inj1launch/TEST";

fn one() -> Uint128 {
    Uint128::new(1_000_000_000_000_000_000)
}
fn amt(n: u128) -> Uint128 {
    Uint128::new(n) * one()
}
fn seed_total() -> Uint128 {
    factory::FIXED_TOTAL_SUPPLY
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
    app: TestApp,
    factory: Addr,
    admin: Addr,
    creator: Addr,
    buyer: Addr,
    /// Carried so a test can assert the platform was PAID, not merely configured.
    platform: Addr,
}

fn setup() -> Fx {
    let mut app = AppBuilder::new().with_stargate(TokenFactorySim).build(|_, _, _| {});
    let api = app.api().clone();
    let admin = api.addr_make("admin");
    let creator = api.addr_make("creator");
    let buyer = api.addr_make("buyer");
    let platform = api.addr_make("platform");

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
                quote_denom: QUOTE.into(),
                quote_decimals: 18,
            quote_virtual_whole: None,
            },
            &[],
            "factory",
            None,
        )
        .unwrap();
    app.execute(admin.clone(), stargate("/test.DefaultAdmin", factory.as_bytes().to_vec()))
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
                    fee_bps: 100,
                    fee_sell_bps: None,
                    reward_route: Default::default(),
                quote_denom: None,
                    profile,
                    rules,
                    initial_buy: None,
                },
                &coins(seed_total().u128(), denom),
            )
            .map(|_| ())
            .map_err(|e| anyhow::anyhow!(e.to_string()))
    }
    /// Seed the creator with a second token, so a test can launch twice.
    ///
    /// The fixture funds one denom. Without this a second launch fails in the BANK
    /// module with "Cannot Sub" before the factory runs, and a test asserting on that
    /// error would be asserting the creator is poor rather than anything about policy.
    fn mint(&mut self, denom: &str) {
        let to = self.creator.to_string();
        self.app
            .sudo(SudoMsg::Bank(BankSudo::Mint {
                to_address: to,
                amount: coins(seed_total().u128(), denom),
            }))
            .unwrap();
    }

    /// A launch with a chosen fee, which is the only curve number left to choose.
    fn create_with_fee(&mut self, denom: &str, fee_bps: u16) -> anyhow::Result<()> {
        self.app
            .execute_contract(
                self.creator.clone(),
                self.factory.clone(),
                &ExecuteMsg::CreateLaunch {
                    denom: denom.into(),
                    fee_bps,
                    quote_denom: None,
                    profile: Default::default(),
                    rules: Default::default(),
                    initial_buy: None,
                    fee_sell_bps: None,
                    reward_route: Default::default(),
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
            fee_bps: 100,
            fee_sell_bps: None,
            reward_route: Default::default(),
                quote_denom: None,
        },
        &coins(amt(1).u128(), TOKEN), // nowhere near the required seed
    );
    assert!(res.is_err(), "under-funded launch was accepted");
}

#[test]
fn the_policy_curve_can_actually_reach_its_graduation_target() {
    /*
     * REPLACES a test that sent a deliberately unreachable `graduation_target` and
     * asserted the factory refused it. The caller cannot send a curve any more, so
     * that input no longer exists.
     *
     * The risk it was guarding did not go away, it MOVED: the target is now a
     * hand-written constant, and a typo there produces a launchpad where every launch
     * is stalled by design, with no caller to blame and nothing refusing it. So the
     * assertion is against the constants themselves.
     */
    let curve: launchpad_math::CurveConfig = (&factory::fixed_curve(100, 100, &factory::QuoteSpec { decimals: 18, virtual_quote_whole: Uint128::new(676) })).into();
    let ceiling = curve.max_collectable().expect("the policy curve cannot be priced");
    assert!(
        curve.graduation_target <= ceiling,
        "the policy curve can never graduate: target {} exceeds the {} it can collect",
        curve.graduation_target,
        ceiling
    );
    // And not so far under that the reserve is trivial, which would graduate instantly.
    assert!(
        curve.graduation_target > ceiling / Uint128::new(2),
        "the policy target is less than half what the curve can collect"
    );
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

#[test]
fn the_mint_key_ends_with_the_curve_where_nothing_can_use_it() {
    // A denom admin can mint without limit, so a creator who kept it could mint after
    // graduation and empty the locked pool. After a launch the admin must be the curve.
    let mut f = setup();
    f.create(TOKEN).unwrap();
    let curve = f.launch(1).curve;
    assert_eq!(denom_admin(&f.app, TOKEN), curve.to_string());
}

#[test]
fn a_creator_who_keeps_the_mint_key_cannot_launch() {
    let mut f = setup();
    let creator = f.creator.clone();
    // The creator still administers the denom: they skipped the handover to the factory.
    f.app
        .execute(
            creator.clone(),
            stargate("/test.SetAdmin", format!("{TOKEN}|{creator}").into_bytes()),
        )
        .unwrap();
    let err = f.create(TOKEN).unwrap_err().to_string();
    assert!(err.contains("not the admin") || err.contains("Error executing"), "{err}");
    // Nothing was created and the seed is back with the creator: the tx reverted whole.
    assert_eq!(f.balance(&creator, TOKEN), seed_total());
    let all: LaunchesResponse = f
        .app
        .wrap()
        .query_wasm_smart(f.factory.clone(), &QueryMsg::Launches { start_after: None, limit: None })
        .unwrap();
    assert!(all.launches.is_empty(), "a launch exists whose creator kept the mint key");

    // Handing admin to the factory, as the app does in the same transaction, fixes it.
    f.app
        .execute(
            creator.clone(),
            stargate(
                factory::MSG_CHANGE_ADMIN,
                factory::encode_change_admin(creator.as_str(), TOKEN, f.factory.as_str()).to_vec(),
            ),
        )
        .unwrap();
    f.create(TOKEN).unwrap();
    assert_eq!(denom_admin(&f.app, TOKEN), f.launch(1).curve.to_string());
}

#[test]
fn a_launched_curve_has_no_wasm_admin_so_its_code_can_never_be_replaced() {
    // The locked pool is only locked if no key can migrate the contract holding it.
    let mut f = setup();
    f.create(TOKEN).unwrap();
    let curve = f.launch(1).curve;
    let info = f.app.wrap().query_wasm_contract_info(curve).unwrap();
    assert_eq!(info.admin, None, "a curve was created with a wasm admin");
}

#[test]
fn an_admin_handover_takes_effect_only_when_accepted() {
    let mut f = setup();
    let (admin, creator, buyer) = (f.admin.clone(), f.creator.clone(), f.buyer.clone());
    let cfg = |f: &Fx| -> Config {
        f.app.wrap().query_wasm_smart(f.factory.clone(), &QueryMsg::Config {}).unwrap()
    };

    f.app
        .execute_contract(
            admin.clone(),
            f.factory.clone(),
            &ExecuteMsg::UpdateAdmin { admin: creator.to_string() },
            &[],
        )
        .unwrap();
    // Proposed, not transferred: the old admin still holds it.
    assert_eq!(cfg(&f).admin, admin);
    assert_eq!(cfg(&f).pending_admin, Some(creator.clone()));

    // Nobody but the proposed address can complete it.
    assert!(f
        .app
        .execute_contract(buyer, f.factory.clone(), &ExecuteMsg::AcceptAdmin {}, &[])
        .is_err());

    f.app
        .execute_contract(creator.clone(), f.factory.clone(), &ExecuteMsg::AcceptAdmin {}, &[])
        .unwrap();
    assert_eq!(cfg(&f).admin, creator);
    assert_eq!(cfg(&f).pending_admin, None);

    // And the old admin has lost it.
    assert!(f
        .app
        .execute_contract(
            admin,
            f.factory.clone(),
            &ExecuteMsg::SetCurveCodeId { code_id: 7 },
            &[]
        )
        .is_err());
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
                fee_bps: 100,
                fee_sell_bps: None,
                reward_route: Default::default(),
                quote_denom: None,
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
                fee_bps: 100,
                fee_sell_bps: None,
                reward_route: Default::default(),
                quote_denom: None,
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
            fee_bps: 100,
            fee_sell_bps: None,
            reward_route: Default::default(),
                quote_denom: None,
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
            fee_bps: 100,
            fee_sell_bps: None,
            reward_route: Default::default(),
                quote_denom: None,
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
            fee_bps: 100,
            fee_sell_bps: None,
            reward_route: Default::default(),
                quote_denom: None,
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
 * What a creator cannot choose.
 *
 * Supply, curve shape and the fee split are all protocol policy now, and the tests
 * below changed shape with them. They used to send a bad `curve` or a mismatched
 * `lp_reserve` and assert the factory refused it. `CreateLaunch` no longer carries
 * either field, so those inputs cannot be expressed at all: a stronger guarantee
 * than a rejected one, and worth saying so rather than deleting the tests silently.
 *
 * What is still worth asserting is that the launched curve carries the policy, which
 * is the half a missing input cannot prove on its own.
 * ---------------------------------------------------------------------------
 */

/// The curve contract's own config, which is where the shape and the fee split live.
fn curve_config(f: &Fx, id: u64) -> curve::state::Config {
    let l = f.launch(id);
    f.app
        .wrap()
        .query_wasm_smart(l.curve.clone(), &CurveQuery::Config {})
        .unwrap()
}

#[test]
fn a_launch_cannot_specify_its_own_curve_or_supply() {
    /*
     * A SOURCE READ, because this is the one property no runtime test can reach: the
     * fields are gone from the message type, so there is nothing to send and nothing
     * to be refused. If they are ever reintroduced as caller input, every number on
     * the board stops being comparable and nothing else here would notice.
     */
    let src = include_str!("../src/lib.rs");
    let msg_start = src.find("    CreateLaunch {").expect("CreateLaunch not found");
    let msg = &src[msg_start..msg_start + 400];
    for banned in ["curve: CurveConfigStored", "lp_reserve: Uint128", "creator_fee_share_bps"] {
        assert!(
            !msg.contains(banned),
            "`{banned}` is back on CreateLaunch; the curve is a creator input again"
        );
    }
    assert!(msg.contains("fee_bps: u16"), "the fee is no longer settable");
}

#[test]
fn every_launch_gets_the_same_curve_and_the_same_supply() {
    let mut f = setup();
    f.create(TOKEN).unwrap();

    let cfg = curve_config(&f, 1);
    assert_eq!(cfg.curve.virtual_inj, amt(676), "opening reserve is not policy");
    assert_eq!(cfg.curve.virtual_tokens, amt(1_073_000_000));
    assert_eq!(cfg.curve.curve_supply, amt(800_000_000));
    // 676 * 17/6, floored. The ratio is the policy; this is what it comes to.
    assert_eq!(cfg.curve.graduation_target, amt(1915));
    assert_eq!(cfg.lp_reserve, amt(200_000_000));
    assert_eq!(
        cfg.curve.curve_supply + cfg.lp_reserve,
        factory::FIXED_TOTAL_SUPPLY,
        "the launched supply is not the fixed one"
    );
}

#[test]
fn two_launches_are_identical_apart_from_their_fee() {
    let mut f = setup();
    /*
     * The actual product claim: two cards on the board measure the same thing. Asserted
     * by launching twice and comparing, rather than by reading the constants, because
     * the constants agreeing with themselves proves nothing about what gets written.
     */
    f.create(TOKEN).unwrap();
    f.mint("factory/inj1launch/OTHER");
    f.create("factory/inj1launch/OTHER").unwrap();

    let a = curve_config(&f, 1);
    let b = curve_config(&f, 2);
    assert_eq!(a.curve.virtual_inj, b.curve.virtual_inj);
    assert_eq!(a.curve.virtual_tokens, b.curve.virtual_tokens);
    assert_eq!(a.curve.curve_supply, b.curve.curve_supply);
    assert_eq!(a.curve.graduation_target, b.curve.graduation_target);
    assert_eq!(a.lp_reserve, b.lp_reserve);
    assert_eq!(a.creator_fee_share_bps, b.creator_fee_share_bps);
}

#[test]
fn the_fee_is_the_one_thing_a_launch_still_chooses() {
    let mut f = setup();
    // Not a formality: fixing the shape makes it easy to fix the fee by accident too,
    // and a launchpad where nobody can compete on cost is a worse one.
    f.create_with_fee(TOKEN, 100).unwrap();
    f.mint("factory/inj1launch/CHEAP");
    f.create_with_fee("factory/inj1launch/CHEAP", 0).unwrap();
    assert_eq!(curve_config(&f, 1).curve.fee_bps, 100);
    assert_eq!(curve_config(&f, 2).curve.fee_bps, 0, "a zero-fee launch was refused");
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
     */
    assert_eq!(factory::CREATOR_FEE_SHARE_BPS, 7_000);
    f.create(TOKEN).unwrap();
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
     * is configured and never paid is the failure this project keeps finding.
     */
    f.create(TOKEN).unwrap();
    let curve = f.launch(1).curve;
    let platform = f.platform.clone();
    assert!(f.balance(&platform, QUOTE).is_zero(), "platform starts clean");

    f.app
        .execute_contract(
            f.buyer.clone(),
            curve.clone(),
            &CurveExec::Buy { min_tokens_out: Uint128::zero(), recipient: None },
            &coins(amt(10).u128(), QUOTE),
        )
        .unwrap();

    let st: CurveState = f
        .app
        .wrap()
        .query_wasm_smart(curve.clone(), &CurveQuery::State {})
        .unwrap();
    assert!(!st.platform_owed.is_zero(), "nothing accrued to the platform");
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
    f.app
        .execute_contract(
            f.creator.clone(),
            f.factory.clone(),
            &ExecuteMsg::CreateLaunch {
                denom: denom.into(),
                fee_bps: 100,
                fee_sell_bps: None,
                reward_route: Default::default(),
                quote_denom: None,
                profile: Default::default(),
                rules: Default::default(),
                initial_buy: Some(spend),
            },
            &[coin(seed_total().u128(), denom), coin(spend.u128(), QUOTE)],
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
     * address could see the token existed. 40 INJ against this curve takes 76.31% of
     * the supply, measured.
     */
    let err = create_with_dev_buy(&mut f, TOKEN, amt(80)).expect_err("the dev took the curve");
    assert!(
        err.contains("the most a creator may take"),
        "the refusal does not name the cap: {err}"
    );
}

#[test]
fn a_modest_opening_buy_is_still_allowed() {
    let mut f = setup();
    // 1 INJ takes 4.28% of supply on this curve, measured: comfortably inside the cap
    // and the sort of opening position a creator actually makes.
    create_with_dev_buy(&mut f, TOKEN, amt(2)).unwrap();
    let st: CurveState = f
        .app
        .wrap()
        .query_wasm_smart(f.launch(1).curve, &CurveQuery::State {})
        .unwrap();
    let ceiling = Uint128::new(factory::CURVE_SUPPLY)
        .multiply_ratio(factory::MAX_INITIAL_BUY_BPS, 10_000u128);
    assert!(!st.tokens_sold.is_zero(), "the opening buy did not execute");
    assert!(st.tokens_sold <= ceiling, "an allowed buy exceeded the cap");
}

#[test]
fn the_opening_buy_cap_is_a_share_of_the_curve_not_of_the_total_supply() {
    let mut f = setup();
    /*
     * ADDED AFTER A MUTATION ESCAPED. Changing the ceiling to
     * `(curve_supply + lp_reserve) * bps` loosened the cap by a quarter and every
     * other test still passed, because none used an amount between the two bases.
     *
     * 10% of the curve is 80,000,000 tokens and 10% of the total is 100,000,000. A
     * 60 INJ opening buy takes about 86,670,000, which sits between them.
     *
     * THE AMOUNT IS DERIVED FROM THE CURVE, so rescaling the curve breaks this test
     * loudly rather than quietly. It was 5 INJ against the opening reserve of 60;
     * moving that reserve to 676 made 5 INJ buy 7.8M, comfortably under BOTH caps, so
     * the test would have passed while testing nothing at all.
     *
     * The curve supply is the right basis because it is what is actually purchasable:
     * the reserve is held back for the pool and nobody can buy it.
     */
    let between = amt(60);
    let err = create_with_dev_buy(&mut f, TOKEN, between)
        .expect_err("a buy above 10% of the curve was accepted");
    assert!(
        err.contains("the most a creator may take"),
        "refused for the wrong reason: {err}"
    );

    let curve_basis = Uint128::new(factory::CURVE_SUPPLY)
        .multiply_ratio(factory::MAX_INITIAL_BUY_BPS, 10_000u128);
    assert!(
        err.contains(&curve_basis.to_string()),
        "the refusal names a ceiling other than 10% of the curve supply: {err}"
    );
}

/*
 * ---------------------------------------------------------------------------
 * Quote assets.
 *
 * Injective's USDC is SIX decimals, measured on `denoms_metadata`, where most ERC20s
 * are 18 and some are 8. The curve constants are whole quote units scaled at launch,
 * and getting that scaling wrong does not fail loudly: it produces a launch whose
 * opening reserve is 30 trillion USDC and whose graduation target can never be
 * reached. These tests exist for that one number.
 * ---------------------------------------------------------------------------
 */

const USDC: &str = "peggy0xUSDC";

#[test]
fn the_curve_shape_is_identical_at_every_quote_decimals() {
    /*
     * The property that makes scaling safe at all. The curve is
     * `tokens_out = vt - (vi * vt) / (vi + x)`, in which `vi` and `x` share units, so
     * the ratio is dimensionless. One whole quote unit must therefore buy the same
     * number of tokens whatever the quote's decimals are.
     *
     * Asserted rather than assumed, because the whole multi-quote feature rests on it.
     */
    let mut outs = vec![];
    for dec in [18u8, 8, 6] {
        let cfg: launchpad_math::CurveConfig = (&factory::fixed_curve(100, 100, &factory::QuoteSpec { decimals: dec, virtual_quote_whole: Uint128::new(676) })).into();
        let one_whole = Uint128::new(10u128.pow(dec as u32));
        let q = launchpad_math::quote_buy(
            &cfg,
            &launchpad_math::CurveState {
                inj_collected: Uint128::zero(),
                tokens_sold: Uint128::zero(),
                graduated: false,
            },
            one_whole,
        )
        .expect("the policy curve could not be priced");
        outs.push(q.tokens_out);
    }
    assert_eq!(outs[0], outs[1], "18 and 8 decimals priced differently");
    assert_eq!(outs[1], outs[2], "8 and 6 decimals priced differently");
}

#[test]
fn a_six_decimal_quote_scales_the_curve_rather_than_inheriting_eighteen() {
    // The specific disaster: 18-decimal constants against a 6-decimal quote put the
    // graduation target in the trillions. It must be in whole units of the quote.
    let c = factory::fixed_curve(100, 100, &factory::QuoteSpec { decimals: 6, virtual_quote_whole: Uint128::new(676) });
    assert_eq!(c.graduation_target, Uint128::new(1_915_000_000));
    assert_eq!(c.virtual_inj, Uint128::new(676_000_000));
    // Token amounts do NOT scale: every launched token is 18 decimals.
    assert_eq!(c.curve_supply, amt(800_000_000));
    assert_eq!(c.virtual_tokens, amt(1_073_000_000));
}

#[test]
fn a_quote_nobody_allowlisted_is_refused() {
    let mut f = setup();
    let err = f
        .app
        .execute_contract(
            f.creator.clone(),
            f.factory.clone(),
            &ExecuteMsg::CreateLaunch {
                denom: TOKEN.into(),
                fee_bps: 100,
                fee_sell_bps: None,
                reward_route: Default::default(),
                quote_denom: Some(USDC.into()),
                profile: Default::default(),
                rules: Default::default(),
                initial_buy: None,
            },
            &coins(seed_total().u128(), TOKEN),
        )
        .map_err(|e| format!("{e:#}"))
        .expect_err("an unknown quote was accepted");
    assert!(err.contains("is not allowed on this launchpad"), "unexpected: {err}");
}

#[test]
fn an_allowlisted_quote_launches_with_its_own_scale() {
    let mut f = setup();
    let admin = f.admin.clone();
    f.app
        .execute_contract(
            admin,
            f.factory.clone(),
            &ExecuteMsg::SetQuote {
            virtual_quote_whole: Uint128::new(676), denom: USDC.into(), decimals: 6, symbol: None },
            &[],
        )
        .unwrap();

    f.app
        .execute_contract(
            f.creator.clone(),
            f.factory.clone(),
            &ExecuteMsg::CreateLaunch {
                denom: TOKEN.into(),
                fee_bps: 100,
                fee_sell_bps: None,
                reward_route: Default::default(),
                quote_denom: Some(USDC.into()),
                profile: Default::default(),
                rules: Default::default(),
                initial_buy: None,
            },
            &coins(seed_total().u128(), TOKEN),
        )
        .unwrap();

    let cfg = curve_config(&f, 1);
    assert_eq!(cfg.quote_denom, USDC, "the curve was given the wrong quote");
    assert_eq!(
        cfg.curve.graduation_target,
        Uint128::new(1_915_000_000),
        "the curve kept 18-decimal constants against a 6-decimal quote"
    );
}

#[test]
fn only_the_admin_curates_quotes() {
    let mut f = setup();
    let creator = f.creator.clone();
    let err = f
        .app
        .execute_contract(
            creator,
            f.factory.clone(),
            &ExecuteMsg::SetQuote {
            virtual_quote_whole: Uint128::new(676), denom: USDC.into(), decimals: 6, symbol: None },
            &[],
        )
        .map_err(|e| format!("{e:#}"))
        .expect_err("anyone could allowlist a quote");
    /*
     * This matters more than an ordinary admin gate. Any address can create a bank
     * denom on Injective, so an open quote field means a launch priced in a token the
     * creator minted that morning, which reads on the board exactly like a real pair.
     */
    assert!(err.contains("nauthorised") || err.contains("nauthorized"), "unexpected: {err}");
}

#[test]
fn absurd_decimals_are_refused_rather_than_silently_clamped() {
    let mut f = setup();
    let admin = f.admin.clone();
    let err = f
        .app
        .execute_contract(
            admin,
            f.factory.clone(),
            &ExecuteMsg::SetQuote {
            virtual_quote_whole: Uint128::new(676), denom: USDC.into(), decimals: 40, symbol: None },
            &[],
        )
        .map_err(|e| format!("{e:#}"))
        .expect_err("40 decimals was accepted");
    // Clamping would be worse than refusing: a quote recorded at 40 and used at 24
    // launches a curve priced 10^16 away from what the admin intended.
    assert!(err.contains("maximum is 24"), "unexpected: {err}");
}

#[test]
fn the_default_quote_cannot_be_removed() {
    let mut f = setup();
    let admin = f.admin.clone();
    let err = f
        .app
        .execute_contract(
            admin,
            f.factory.clone(),
            &ExecuteMsg::RemoveQuote { denom: QUOTE.into() },
            &[],
        )
        .map_err(|e| format!("{e:#}"))
        .expect_err("the default quote was removed");
    // Removing it leaves a factory whose CreateLaunch refuses everything, including a
    // launch that named no quote at all: an outage that looks like a setting.
    assert!(err.contains("cannot be removed"), "unexpected: {err}");
}

#[test]
fn the_quote_list_is_readable_and_names_its_default() {
    /*
     * The create form needs this to decide whether to OFFER a choice. With one
     * allowlisted quote a picker is a control that does nothing; with several it is
     * the difference between this and a single-pair launchpad. So the query must
     * report both the list AND which one a launch gets when it names none, because
     * the form cannot infer the default from the list alone.
     */
    let mut f = setup();
    let admin = f.admin.clone();

    let before: factory::QuotesResponse = f
        .app
        .wrap()
        .query_wasm_smart(f.factory.clone(), &QueryMsg::Quotes {})
        .unwrap();
    assert_eq!(before.default_denom, QUOTE);
    assert_eq!(before.quotes.len(), 1, "instantiate did not allowlist its own default");
    assert_eq!(before.quotes[0].decimals, 18);

    f.app
        .execute_contract(
            admin.clone(),
            f.factory.clone(),
            &ExecuteMsg::SetQuote {
            virtual_quote_whole: Uint128::new(676), denom: USDC.into(), decimals: 6, symbol: None },
            &[],
        )
        .unwrap();

    let after: factory::QuotesResponse = f
        .app
        .wrap()
        .query_wasm_smart(f.factory.clone(), &QueryMsg::Quotes {})
        .unwrap();
    assert_eq!(after.quotes.len(), 2);
    let usdc = after.quotes.iter().find(|q| q.denom == USDC).expect("USDC missing");
    assert_eq!(usdc.decimals, 6, "the decimals that scale the curve were not stored");

    // And removal takes it back out, so the form stops offering it.
    f.app
        .execute_contract(
            admin,
            f.factory.clone(),
            &ExecuteMsg::RemoveQuote { denom: USDC.into() },
            &[],
        )
        .unwrap();
    let gone: factory::QuotesResponse = f
        .app
        .wrap()
        .query_wasm_smart(f.factory.clone(), &QueryMsg::Quotes {})
        .unwrap();
    assert_eq!(gone.quotes.len(), 1);
}

// ------------------------------------------------ opening buy vs launch rules --

fn create_with_buy(f: &mut Fx, rules: LaunchRules, spend: Uint128) -> anyhow::Result<()> {
    f.app
        .execute_contract(
            f.creator.clone(),
            f.factory.clone(),
            &ExecuteMsg::CreateLaunch {
                denom: TOKEN.into(),
                fee_bps: 100,
                fee_sell_bps: None,
                reward_route: Default::default(),
                quote_denom: None,
                profile: Default::default(),
                rules,
                initial_buy: Some(spend),
            },
            &[coin(seed_total().u128(), TOKEN), coin(spend.u128(), QUOTE)],
        )
        .map(|_| ())
        .map_err(|e| anyhow::anyhow!(format!("{e:#}")))
}

#[test]
fn an_opening_buy_with_a_future_start_is_refused_by_name() {
    // The curve would refuse the buy inside the reply and revert the launch anyway;
    // refusing here names the reason and fails at simulation, before signing.
    let mut f = setup();
    let later = f.app.block_info().time.plus_seconds(3_600);
    let rules = LaunchRules { max_per_wallet: None, trade_start: Some(later), early_fee: None };
    let err = create_with_buy(&mut f, rules, amt(1)).unwrap_err().to_string();
    assert!(err.contains("start time in the future"), "{err}");
}

#[test]
fn an_opening_buy_over_the_wallet_cap_is_refused_by_name() {
    let mut f = setup();
    // On the 676 curve 1 INJ buys ~1.58M tokens, so the cap has to be below that to
    // be the thing that refuses. It was 10M against the old 60 curve, where 1 INJ
    // bought ~34.6M; rescaling the curve made the cap larger than the buy and the
    // test passed for no reason until the buy stopped being refused at all.
    let cap = Uint128::new(500_000) * one();
    let rules = LaunchRules { max_per_wallet: Some(cap), trade_start: None, early_fee: None };
    let err = create_with_buy(&mut f, rules, amt(1)).unwrap_err().to_string();
    assert!(err.contains("over this launch's wallet cap"), "{err}");
}

#[test]
fn an_opening_buy_within_the_rules_still_launches() {
    let mut f = setup();
    let cap = Uint128::new(100_000_000) * one();
    let rules = LaunchRules { max_per_wallet: Some(cap), trade_start: None, early_fee: None };
    create_with_buy(&mut f, rules, amt(1)).unwrap();
    assert!(f.balance(&f.creator.clone(), TOKEN) > Uint128::zero());
}

#[test]
fn a_quote_can_carry_a_display_symbol_and_bad_ones_are_refused() {
    // Peggy and erc20 denoms are hex addresses; without a symbol the UI prints the hex.
    let mut f = setup();
    let admin = f.admin.clone();
    let hex = "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7";
    for bad in ["", "WAY-TOO-LONG-SYMBOL", "US DT", "<b>"] {
        assert!(f
            .app
            .execute_contract(
                admin.clone(),
                f.factory.clone(),
                &ExecuteMsg::SetQuote {
            virtual_quote_whole: Uint128::new(676), denom: hex.into(), decimals: 6, symbol: Some(bad.into()) },
                &[],
            )
            .is_err(), "symbol {bad:?} was accepted");
    }
    f.app
        .execute_contract(
            admin.clone(),
            f.factory.clone(),
            &ExecuteMsg::SetQuote {
            virtual_quote_whole: Uint128::new(676), denom: hex.into(), decimals: 6, symbol: Some("USDT".into()) },
            &[],
        )
        .unwrap();
    let q: factory::QuotesResponse =
        f.app.wrap().query_wasm_smart(f.factory.clone(), &QueryMsg::Quotes {}).unwrap();
    let usdt = q.quotes.iter().find(|x| x.denom == hex).unwrap();
    assert_eq!(usdt.symbol.as_deref(), Some("USDT"));
    // A later SetQuote without a symbol keeps the one already set.
    f.app
        .execute_contract(
            admin,
            f.factory.clone(),
            &ExecuteMsg::SetQuote {
            virtual_quote_whole: Uint128::new(676), denom: hex.into(), decimals: 6, symbol: None },
            &[],
        )
        .unwrap();
    let q: factory::QuotesResponse =
        f.app.wrap().query_wasm_smart(f.factory.clone(), &QueryMsg::Quotes {}).unwrap();
    assert_eq!(q.quotes.iter().find(|x| x.denom == hex).unwrap().symbol.as_deref(), Some("USDT"));
}

/*
 * ---------------------------------------------------------------------------
 * Per-side fees and reward routing.
 * ---------------------------------------------------------------------------
 */

fn create_with_fees(
    f: &mut Fx,
    denom: &str,
    buy: u16,
    sell: Option<u16>,
    route: curve::state::RewardRoute,
) -> Result<(), String> {
    f.app
        .execute_contract(
            f.creator.clone(),
            f.factory.clone(),
            &ExecuteMsg::CreateLaunch {
                denom: denom.into(),
                fee_bps: buy,
                fee_sell_bps: sell,
                reward_route: route,
                quote_denom: None,
                profile: Default::default(),
                rules: Default::default(),
                initial_buy: None,
            },
            &coins(seed_total().u128(), denom),
        )
        .map(|_| ())
        .map_err(|e| format!("{e:#}"))
}

#[test]
fn each_side_of_the_fee_is_capped_on_its_own() {
    let mut f = setup();
    /*
     * Capped separately because entry and exit are not the same decision. A creator
     * pricing them differently is making a real choice about their own launch; what
     * they cannot do is make it unsellable, which an uncapped sell fee does without
     * ever looking like a block.
     */
    let err = create_with_fees(&mut f, TOKEN, 1_001, None, Default::default())
        .expect_err("a buy fee over 10% was accepted");
    assert!(err.contains("buy fee is 1001 bps"), "unexpected: {err}");

    let err = create_with_fees(&mut f, TOKEN, 100, Some(1_001), Default::default())
        .expect_err("a sell fee over 10% was accepted");
    assert!(err.contains("sell fee is 1001 bps"), "unexpected: {err}");
}

#[test]
fn the_two_sides_can_differ_and_either_may_be_free() {
    let mut f = setup();
    // Free entry, taxed exit is a legitimate shape and must not be refused.
    create_with_fees(&mut f, TOKEN, 0, Some(1_000), Default::default()).unwrap();
    let c = curve_config(&f, 1);
    assert_eq!(c.curve.fee_bps, 0);
    assert_eq!(c.curve.fee_sell_bps, 1_000);
}

#[test]
fn an_absent_sell_fee_mirrors_the_buy_fee() {
    let mut f = setup();
    // What every launch charged before the sides could differ, so an older caller
    // that sends no sell fee still gets the symmetric launch it expects.
    create_with_fees(&mut f, TOKEN, 250, None, Default::default()).unwrap();
    let c = curve_config(&f, 1);
    assert_eq!(c.curve.fee_bps, 250);
    assert_eq!(c.curve.fee_sell_bps, 250);
}

#[test]
fn routing_to_the_pool_sends_the_creators_share_there_instead() {
    let mut f = setup();
    create_with_fees(&mut f, TOKEN, 100, None, curve::state::RewardRoute::Pool).unwrap();
    let curve = f.launch(1).curve;

    f.app
        .execute_contract(
            f.buyer.clone(),
            curve.clone(),
            &CurveExec::Buy { min_tokens_out: Uint128::zero(), recipient: None },
            &coins(amt(10).u128(), QUOTE),
        )
        .unwrap();

    let st: CurveState = f
        .app
        .wrap()
        .query_wasm_smart(curve, &CurveQuery::State {})
        .unwrap();

    /*
     * The creator is owed NOTHING and the pool holds their share. The platform's cut
     * is untouched: a creator routes their own portion, not the launchpad's.
     */
    assert!(st.creator_owed.is_zero(), "the creator was still credited");
    assert!(!st.platform_owed.is_zero(), "the platform's share was routed away too");
    assert!(!st.lp_bonus.is_zero(), "nothing reached the pool");
    assert_eq!(
        st.lp_bonus + st.platform_owed,
        amt(10) / Uint128::new(100),
        "the routed share plus the platform's is not the whole 1% fee"
    );
}

#[test]
fn the_default_route_still_credits_the_creator() {
    let mut f = setup();
    // The absence of a choice must behave exactly as the launchpad did before the
    // choice existed, or every older caller silently changes behaviour.
    create_with_fees(&mut f, TOKEN, 100, None, Default::default()).unwrap();
    let curve = f.launch(1).curve;
    f.app
        .execute_contract(
            f.buyer.clone(),
            curve.clone(),
            &CurveExec::Buy { min_tokens_out: Uint128::zero(), recipient: None },
            &coins(amt(10).u128(), QUOTE),
        )
        .unwrap();
    let st: CurveState = f.app.wrap().query_wasm_smart(curve, &CurveQuery::State {}).unwrap();
    assert!(!st.creator_owed.is_zero(), "the creator was not credited");
    assert!(st.lp_bonus.is_zero(), "the pool took a share it was not routed");
}

#[test]
fn a_sell_is_charged_the_sell_fee_not_the_buy_fee() {
    let mut f = setup();
    /*
     * ADDED AFTER A MUTATION ESCAPED. Every test above asserts the two fees are
     * STORED separately; none made a sell, so swapping the sell quote back to
     * `fee_bps` left the whole suite green while the feature did nothing.
     *
     * Asymmetric on purpose, and at the extremes: free entry, 10% exit. If the sell
     * were charged the buy fee the seller would pay nothing, which is the exact
     * shape of the escaped mutation.
     */
    create_with_fees(&mut f, TOKEN, 0, Some(1_000), Default::default()).unwrap();
    let curve = f.launch(1).curve;

    f.app
        .execute_contract(
            f.buyer.clone(),
            curve.clone(),
            &CurveExec::Buy { min_tokens_out: Uint128::zero(), recipient: None },
            &coins(amt(10).u128(), QUOTE),
        )
        .unwrap();

    let after_buy: CurveState = f
        .app
        .wrap()
        .query_wasm_smart(curve.clone(), &CurveQuery::State {})
        .unwrap();
    // Free entry: the buy must have skimmed nothing at all.
    assert!(
        after_buy.creator_owed.is_zero() && after_buy.platform_owed.is_zero(),
        "a 0 bps buy charged a fee"
    );

    let held = f.balance(&f.buyer, TOKEN);
    assert!(!held.is_zero(), "the buy produced no tokens");

    f.app
        .execute_contract(
            f.buyer.clone(),
            curve.clone(),
            &CurveExec::Sell { min_inj_out: Uint128::zero() },
            &coins(held.u128(), TOKEN),
        )
        .unwrap();

    let after_sell: CurveState = f
        .app
        .wrap()
        .query_wasm_smart(curve, &CurveQuery::State {})
        .unwrap();
    let charged = after_sell.creator_owed + after_sell.platform_owed;
    assert!(
        !charged.is_zero(),
        "the sell was charged the 0 bps BUY fee instead of the 10% sell fee"
    );
}

/// A launch opens at the market cap the curve was scaled for.
///
/// THE CONSTANT IS NOT THE POINT, the opening market cap is. `virtual_quote_whole`
/// was chosen so a launch opens around $5,000 at the INJ price on the day it was
/// picked; asserting the constant only restates it, and would pass if somebody
/// changed `virtual_tokens` or `FIXED_TOTAL_SUPPLY` underneath and moved the market
/// cap without touching the reserve.
///
/// Opening market cap = opening spot x total supply
///                    = (virtual_quote / virtual_tokens) x total supply.
///
/// Measured in WHOLE QUOTE UNITS, which is the only honest unit here: the dollar
/// figure that motivated the number is a premise about the price of INJ on one day,
/// and there is no oracle in this product to carry it.
#[test]
fn a_launch_opens_at_the_market_cap_the_curve_was_scaled_for() {
    let mut f = setup();
    f.create(TOKEN).unwrap();
    let cfg = curve_config(&f, 1);

    // Scaled by 1e18 so the division keeps its precision in integer arithmetic.
    let total_supply = Uint128::new(factory::FIXED_TOTAL_SUPPLY.u128());
    let opening_mc = cfg
        .curve
        .virtual_inj
        .multiply_ratio(total_supply, cfg.curve.virtual_tokens);

    /*
     * 630.0093, not 630 exactly: the opening market cap is
     * `virtual_quote * total_supply / virtual_tokens`, and 1,073,000,000 does not
     * divide 1,000,000,000 evenly. Asserted as a tight band rather than rounded to a
     * figure the arithmetic does not produce, because a test that states a prettier
     * number than the code computes is a test that will be "fixed" in the wrong
     * direction later.
     */
    let lo = amt(629) + Uint128::new(900_000_000_000_000_000);
    let hi = amt(630) + Uint128::new(100_000_000_000_000_000);
    assert!(
        opening_mc >= lo && opening_mc <= hi,
        "a launch no longer opens at about 630 whole quote units of market cap: {opening_mc}"
    );

    /*
     * And the shape, which the graduation RATIO is there to hold constant. Both are
     * asserted together because the pair is the policy: rescaling the opening reserve
     * without the ratio would move graduation relative to the curve's ceiling, which
     * changes how a launch behaves rather than where it starts.
     */
    let ceiling = {
        let k = cfg.curve.virtual_inj.full_mul(cfg.curve.virtual_tokens);
        let left = cfg.curve.virtual_tokens - cfg.curve.curve_supply;
        Uint128::try_from(k / cosmwasm_std::Uint256::from(left)).unwrap() - cfg.curve.virtual_inj
    };
    let pct = cfg.curve.graduation_target.multiply_ratio(10_000u128, ceiling);
    assert!(
        (9_650..=9_690).contains(&pct.u128()),
        "graduation moved relative to the curve ceiling: {pct} bps, expected ~9670"
    );
}

/// Two quotes, two scales, and the curve shape identical in both.
///
/// THE DEFECT THIS EXISTS FOR. The opening reserve was one constant applied to every
/// quote asset, so the number chosen to open an INJ launch at about $5,000 opened a
/// dollar-stablecoin launch at about $630, and nothing on chain or on screen said so.
/// The scale belongs to the asset; the SHAPE belongs to the launchpad.
#[test]
fn each_quote_carries_its_own_scale_and_the_same_shape() {
    let inj = factory::fixed_curve(
        100,
        100,
        &factory::QuoteSpec { decimals: 18, virtual_quote_whole: Uint128::new(676) },
    );
    // What a dollar quote would be set to for the same opening market cap, at the INJ
    // price measured on 11 Oct 2026. A judgement the admin records, not a constant.
    let usd = factory::fixed_curve(
        100,
        100,
        &factory::QuoteSpec { decimals: 6, virtual_quote_whole: Uint128::new(5_354) },
    );

    assert_eq!(inj.virtual_inj, amt(676));
    assert_eq!(usd.virtual_inj, Uint128::new(5_354_000_000));

    // Same ratio of target to opening reserve on both, which is the shape.
    let shape = |target: Uint128, vi: Uint128| target.multiply_ratio(10_000u128, vi);
    /*
     * Within a handful of basis points, not identical. `graduation = whole * 17/6`
     * floors at WHOLE units, so 676 gives 1915 (of 1915.33) and 5354 gives 15169 (of
     * 15169.67); the ratios land 4 bps apart. That residue is the granularity of the
     * quote's own unit and cannot be removed without storing a fractional target.
     */
    let a = shape(inj.graduation_target, inj.virtual_inj).u128() as i128;
    let b = shape(usd.graduation_target, usd.virtual_inj).u128() as i128;
    assert!(
        (a - b).abs() <= 10,
        "the two quotes drew different curves: {a} bps against {b} bps",
    );

    // Token amounts never scale: every launched token is 18 decimals.
    assert_eq!(inj.curve_supply, usd.curve_supply);
    assert_eq!(inj.virtual_tokens, usd.virtual_tokens);
}

/// A quote with no opening reserve, or an absurd one, is refused at the door.
#[test]
fn a_quote_scale_of_zero_or_beyond_the_cap_is_refused() {
    let mut f = setup();
    for bad in [Uint128::zero(), Uint128::new(factory::MAX_VIRTUAL_QUOTE_WHOLE) + Uint128::one()] {
        let err = f
            .app
            .execute_contract(
                f.admin.clone(),
                f.factory.clone(),
                &ExecuteMsg::SetQuote {
                    denom: "uscam".into(),
                    decimals: 6,
                    virtual_quote_whole: bad,
                    symbol: None,
                },
                &[],
            )
            .unwrap_err();
        /*
         * `to_string()` on a cw-multi-test error prints the WasmMsg that failed, not
         * the contract's own message, so asserting on it matches the JSON rather than
         * the reason. The root cause is the `FactoryError`.
         */
        let reason = err.root_cause().to_string();
        assert!(
            reason.contains("opening reserve"),
            "a scale of {bad} was accepted or refused for the wrong reason: {reason}"
        );
    }
}
