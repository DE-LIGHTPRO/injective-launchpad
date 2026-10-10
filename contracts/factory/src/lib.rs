//! Factory: spawns curve launches and keeps the registry.
//!
//! Instantiating a child contract and learning its address is the one place
//! where the Cosmos model differs most sharply from NEAR's. There are no
//! promise callbacks here: the instantiate goes out as a submessage, the
//! handler returns, and the address only becomes knowable in `reply`. So the
//! launch parameters have to be parked in storage across that boundary.

use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::{
    entry_point, to_json_binary, Addr, Binary, Coin, Deps, DepsMut, Env, MessageInfo, Order, Reply,
    Response, StdResult, SubMsg, Uint128, WasmMsg, coins};
use cw_storage_plus::{Item, Map};
use launchpad_math::CurveConfig;
use thiserror::Error;

use curve::msg::ExecuteMsg as CurveExecuteMsg;
use curve::msg::InstantiateMsg as CurveInstantiateMsg;
use curve::state::{CurveConfigStored, LaunchRules};

/// Every launch has exactly this many tokens, and a creator cannot change it.
///
/// One billion at 18 decimals, the supply pump.fun, nearly.trade and ponsfamily.com
/// all settle on. The reason they do is that a supply the creator picks is one more
/// number a buyer must read before a price means anything: fixed, "market cap" and
/// "1 INJ buys N tokens" are comparable across every launch on the board; variable,
/// they are not, and the comparison a board exists to support quietly stops working.
///
/// ENFORCED HERE, not in the form. A form field is a suggestion: anyone can call this
/// contract directly, and a launchpad whose supply guarantee lives in a React
/// component does not have one.
///
/// It used to say the split between the curve and the pool reserve stayed the
/// creator's choice. It no longer does: see `CURVE_SUPPLY` below. Fixing the supply
/// alone did not deliver what it promised, because market cap is the spot price times
/// the supply and the price came from a curve the creator shaped.
pub const FIXED_TOTAL_SUPPLY: Uint128 = Uint128::new(1_000_000_000_000_000_000_000_000_000);

/// The creator's share of every trading fee, in bps of the fee. The rest is the
/// platform's.
///
/// FIXED, NOT CHOSEN, and that is the correction. This was `creator_fee_share_bps` on
/// `CreateLaunch`, a number the creator picked, capped only at 10_000 bps: the whole
/// fee. A rational creator sets it to the maximum, so the cap was in practice the
/// split, and the split was 100/0. The platform's share accrued on every trade and the
/// amount it accrued was zero: a fee that was modelled, routed, claimable, and
/// guaranteed to be empty.
///
/// Capping it lower was the first fix and it was still the wrong shape. Measured
/// 10 Oct 2026, neither comparable launchpad lets a creator set this:
///
///   nearly.trade/launch, rendered: "1B supply. 70% of the 1% pool fee is yours",
///   beside "RHEA POOL · 1% FEE" and "#2844 · 1B SUPPLY".
///   ponsdotdev/pons-labs README: the curve fee plus hook fee is "split protocol /
///   creator / buyback", read from `IPonsV2FeePolicy` and "snapshotted per launch",
///   with guardrails "Curve fee <= 10%, creator tax <= 10%, total trade fee <= 20%".
///
/// Both treat the split as protocol policy snapshotted at launch, and both land on 70%
/// to the creator. So this is 7_000: with the default 100 bps fee, 0.7% to the creator
/// and 0.3% to us, on every trade, on every launch, with no launch able to opt out.
///
/// What a creator still chooses is `fee_bps` itself, so a launch with a 0 bps fee earns
/// both sides nothing. That is their launch to make uneconomic.
pub const CREATOR_FEE_SHARE_BPS: u16 = 7_000;

/// The curve every launch gets. Shape is policy; only the fee on it is chosen.
///
/// WHY THE CREATOR DOES NOT PICK THIS. Fixing the supply was supposed to make market
/// caps comparable across the board, and on its own it does not: market cap is the
/// spot price times the supply, and the spot price comes from the curve. A creator who
/// halved the opening reserve opened at a different price with the same supply, so the
/// headline number on two cards still measured different things. Same for progress to
/// graduation, which is a fraction of a target the creator also chose: `KingOfTheHill`
/// already ranks by market cap rather than progress for exactly that reason.
///
/// So the curve is identical everywhere and the board's numbers finally mean one thing:
///
/// ```text
/// virtual_inj        30 INJ    every launch opens at the same price
/// virtual_tokens  1.073 B      sets how far the curve runs before its asymptote
/// curve_supply      800 M      80% of the fixed supply is purchasable
/// lp_reserve        200 M      the remaining 20%, held back to pair at graduation
/// graduation_target  85 INJ    under the ~87.9 INJ this curve can collect
/// ```
///
/// This is what nearly.trade does: their create form carries no curve parameters at
/// all and states "Every launch opens at the same price". It is also three fewer
/// decisions a creator has to get right about something they cannot change afterwards.
///
/// `fee_bps` is deliberately NOT here. It is a cost, disclosed per launch with its own
/// badge on the card, and it does not make two launches incomparable the way a
/// different price curve does.
/// WHOLE QUOTE UNITS, scaled to the quote's own decimals at launch.
///
/// These were base units at 18 decimals, which was correct only while every launch
/// was quoted in INJ. Injective's USDC is **6 decimals** (measured on
/// `denoms_metadata`, where most ERC20s are 18, USDC is 6 and some are 8), so the old
/// constants against a USDC launch would have set the opening reserve to 30 TRILLION
/// USDC and a graduation target of 85 trillion, which nothing could ever reach.
///
/// Scaling is exact rather than approximate, and that is worth stating because it is
/// the reason this is safe at all. The curve is
/// `tokens_out = vt - (vi * vt) / (vi + x)`, in which `vi` and `x` share units, so the
/// ratio is dimensionless and the shape is invariant. Verified numerically: one whole
/// quote unit buys 34,612,903,225,806,451,612,903,226 tokens at 18, 8 and 6 decimals
/// alike. Getting it wrong instead puts 1 USDC at 35,766,666,666,666 tokens, out by
/// twelve orders of magnitude.
pub const CURVE_VIRTUAL_QUOTE_WHOLE: u128 = 30;
pub const CURVE_GRADUATION_QUOTE_WHOLE: u128 = 85;

/// Token-denominated, and therefore NOT scaled by the quote.
///
/// Every token this factory launches is 18 decimals, so these are identical on every
/// launch whatever it is priced in. Keeping them in base units beside two constants
/// that are in whole units is a trap, which is why both kinds say which they are in
/// their names.
pub const CURVE_VIRTUAL_TOKENS: u128 = 1_073_000_000_000_000_000_000_000_000;
pub const CURVE_SUPPLY: u128 = 800_000_000_000_000_000_000_000_000;

/// The quote's decimals, raised to a multiplier.
///
/// Capped at 24 because `10^24` already exceeds any real denom and the next steps run
/// into `u128`. A denom claiming more is refused when it is allowlisted, not here, so
/// this cannot be reached with a bad value.
fn quote_unit(decimals: u8) -> Uint128 {
    Uint128::new(10u128.pow(decimals.min(24) as u32))
}

/// The reserve held back for the pool: whatever the fixed supply leaves over.
///
/// Derived rather than declared, so the two can never be written to disagree. It was a
/// parameter the caller sent, which the factory then had to check summed to the fixed
/// total; there is nothing left to check.
pub fn lp_reserve() -> Uint128 {
    FIXED_TOTAL_SUPPLY.checked_sub(Uint128::new(CURVE_SUPPLY)).unwrap()
}

/// The one curve, in the quote asset's own units.
///
/// Only the two QUOTE-denominated figures scale. `virtual_tokens` and `curve_supply`
/// are token amounts and every token this factory launches is 18 decimals, so they
/// are the same on every launch whatever it is priced in.
pub fn fixed_curve(fee_bps: u16, quote_decimals: u8) -> CurveConfigStored {
    let unit = quote_unit(quote_decimals);
    CurveConfigStored {
        virtual_inj: unit * Uint128::new(CURVE_VIRTUAL_QUOTE_WHOLE),
        virtual_tokens: Uint128::new(CURVE_VIRTUAL_TOKENS),
        curve_supply: Uint128::new(CURVE_SUPPLY),
        graduation_target: unit * Uint128::new(CURVE_GRADUATION_QUOTE_WHOLE),
        fee_bps,
    }
}

/// The most of the curve's supply a creator may take in their own opening buy, in bps.
///
/// WHY A HARD CAP. `initial_buy` was unbounded. A creator could put in enough quote to
/// take most of the curve at the opening price, in the same transaction that created
/// the launch, before any other address could possibly see the token existed. The
/// create form warned about the share and warned is all it did, so the one guarantee a
/// launchpad exists to make was a sentence in a React component.
///
/// `max_per_wallet` does bind the creator when it is set, since the cap is charged to
/// the RECIPIENT and the factory buys with the creator as recipient. But it is
/// optional, and an optional protection is one that is absent exactly when it matters.
///
/// 10%, and NOT the 4% nearly.trade uses, because their number does not transfer.
///
/// Their create form reads "Optional. Max 4% of supply (approximately 42.9 NEAR)"
/// against a launch that opens at a 1,000 NEAR FDV. Measured on this curve, 4% of
/// supply costs under 1 INJ: the default shape has a 30 INJ opening reserve against an
/// 85 INJ graduation target, so the first tokens are very cheap and the share moves
/// fast. Copied literally, the cap would have refused almost every real opening buy
/// while reading as though it matched the market.
///
/// Measured against the default curve, 10 Oct 2026:
///
/// ```text
/// 0.5 INJ ->  2.18%      2.5 INJ -> 10.22%      8.5 INJ -> 29.38%
/// 1.0 INJ ->  4.28%      3.0 INJ -> 12.08%       20 INJ -> 53.33%
/// 2.0 INJ ->  8.30%      5.0 INJ -> 19.00%       40 INJ -> 76.31%
/// ```
///
/// So the thing worth refusing is the controlling share, not the opening position: a
/// creator holding a tenth of the curve is ordinary and is published on the launch
/// page anyway, and one holding three quarters of it before anyone else has seen the
/// token is the failure this cap exists for. 10% lands at roughly 2.45 INJ here.
///
/// The GUARANTEE is a share of supply, so it holds whatever curve a creator picks. The
/// INJ figures above are a property of the default shape and move with it, which is
/// exactly why the cap is not written in quote.
pub const MAX_INITIAL_BUY_BPS: u128 = 1_000;

/// Submessage id for the curve instantiate we are waiting on.
const REPLY_INSTANTIATE_CURVE: u64 = 1;

#[derive(Error, Debug, PartialEq)]
pub enum FactoryError {
    #[error("{0}")]
    Std(#[from] cosmwasm_std::StdError),

    #[error("{0}")]
    Overflow(#[from] cosmwasm_std::OverflowError),

    #[error("{0}")]
    Payment(#[from] cw_utils::PaymentError),

    #[error("{0}")]
    Curve(#[from] launchpad_math::CurveError),

    /// The same type the curve raises, so the sentence a creator reads is identical
    /// whichever contract refused the launch.
    #[error("{0}")]
    Rule(#[from] curve::state::RuleError),

    #[error("unauthorised")]
    Unauthorised,

    #[error("a launch for denom {denom} already exists")]
    DenomTaken { denom: String },

    #[error("seed must be exactly {expected} of {denom}, got {got}")]
    BadSeed {
        denom: String,
        expected: Uint128,
        got: Uint128,
    },

    /// Names the field, because a form with four URL inputs and one rejection that
    /// says only "invalid" leaves the creator guessing which one.
    /// States the ceiling in TOKENS, because that is the quantity being capped and a
    /// creator who sees only "too large" has no idea what to reduce it to.
    #[error("the opening buy takes {tokens} tokens; the most a creator may take is {max}")]
    InitialBuyTooLarge {
        tokens: cosmwasm_std::Uint128,
        max: cosmwasm_std::Uint128,
    },

    #[error("token profile field `{field}` is invalid: {reason}")]
    BadProfile { field: String, reason: String },

    #[error("quote asset `{denom}` is not allowed on this launchpad")]
    QuoteNotAllowed { denom: String },

    #[error("quote `{denom}` declares {decimals} decimals; the maximum is 24")]
    BadQuoteDecimals { denom: String, decimals: u8 },

    #[error("a quote denom cannot be empty")]
    BadQuoteDenom,

    #[error("`{denom}` is this factory's default quote and cannot be removed")]
    CannotRemoveDefaultQuote { denom: String },

    #[error("unexpected funds attached: {denom}")]
    UnexpectedFunds { denom: String },

    #[error("every launch has exactly {expected} tokens; this one declares {got}")]
    BadTotalSupply {
        expected: cosmwasm_std::Uint128,
        got: cosmwasm_std::Uint128,
    },

    #[error("initial buy is {expected} but {got} was attached")]
    BadInitialBuy {
        expected: cosmwasm_std::Uint128,
        got: cosmwasm_std::Uint128,
    },

    #[error("no launch is pending; reply arrived unexpectedly")]
    NoPendingLaunch,

    #[error("could not read the new contract address from the instantiate reply")]
    MissingInstantiateAddress,

    #[error("unknown reply id {id}")]
    UnknownReply { id: u64 },
}

#[cw_serde]
pub struct Config {
    pub admin: Addr,
    /// Code id of the curve contract this factory instantiates.
    pub curve_code_id: u64,
    /// Fee recipient for every launch this factory creates.
    pub platform: Addr,
    /// Where graduated liquidity is sent.
    pub migration_target: Addr,
    /// What buyers pay with, normally "inj".
    pub quote_denom: String,
}

/// Who a token says it is, stored where it can actually be read back.
///
/// The obvious home for this is bank denom metadata, and it does not work: measured
/// against Injective, `/cosmos/bank/v1beta1/denoms_metadata/{denom}` returns 501 Not
/// Implemented for a factory denom, and the list endpoint answers with 2000+ entries
/// across pages. So metadata can be SET there and never read back per token. A
/// launchpad that cannot show a token's own image is not a launchpad, so identity
/// lives in contract state, which is queryable, and bank metadata is still set at
/// creation for wallets and explorers that read it their own way.
///
/// IMMUTABLE, like everything else about a launch. Mutable metadata means the token
/// somebody bought can change its identity afterwards, which is a rename-to-impersonate
/// vector rather than a convenience. The cost is that a dead link stays dead, and that
/// is the better side to err on.
#[cw_serde]
#[derive(Default)]
pub struct TokenProfile {
    pub image: Option<String>,
    pub website: Option<String>,
    pub x: Option<String>,
    pub telegram: Option<String>,
}

/// Longest any one field may be. Storage is paid for, and an unbounded string is a
/// griefing vector that bloats every query that returns a launch.
pub const MAX_URI_LEN: usize = 256;

impl TokenProfile {
    /// Every field is a URL, and a URL from an untrusted creator is an injection
    /// surface the moment a frontend renders it as `href` or `src`.
    ///
    /// `javascript:` is script execution, and `data:text/html` is the same thing
    /// wearing a different hat, so the scheme is allowlisted rather than denylisted:
    /// a denylist has to guess every future scheme, and the browser only has to find
    /// one that was missed. `https` and `ipfs` are what a token actually needs.
    ///
    /// This is the chain-side half. The frontend validates again at render, because
    /// contract state is attacker-controlled data and a chain that was correct when
    /// this shipped is not a guarantee about the chain the UI is pointed at.
    pub fn validate(&self) -> Result<(), FactoryError> {
        for (field, value) in [
            ("image", &self.image),
            ("website", &self.website),
            ("x", &self.x),
            ("telegram", &self.telegram),
        ] {
            let Some(raw) = value else { continue };
            /*
             * NO SEPARATE EMPTY-STRING BRANCH, and the absence is deliberate.
             *
             * I wrote one: `raw.trim().is_empty()` with its own "empty" reason. Mutation
             * testing showed disabling it changed nothing, and the reason is that the
             * scheme check below already refuses every input it would have caught: "",
             * "   " and "  https://x.org " all fail `starts_with("https://")`, with a
             * message that actually tells the creator what to type.
             *
             * Fifth unreachable defensive branch on this project. The pattern each time
             * was adding a check without first testing whether anything reaches it, so
             * the rule stands: write the test that reaches the branch before the branch.
             */
            if raw.len() > MAX_URI_LEN {
                return Err(FactoryError::BadProfile {
                    field: field.into(),
                    reason: "too long".into(),
                });
            }
            /*
             * Compared lowercased because scheme matching is case-insensitive in every
             * URL parser and in every browser: `JavaScript:alert(1)` is script, and a
             * check that only knows `javascript:` waves it through. The allowlist makes
             * that safe by construction rather than by remembering.
             */
            let lower = raw.to_ascii_lowercase();
            if !(lower.starts_with("https://") || lower.starts_with("ipfs://")) {
                return Err(FactoryError::BadProfile {
                    field: field.into(),
                    reason: "must start with https:// or ipfs://".into(),
                });
            }
            /*
             * Control characters and whitespace inside a URL. A newline is what lets a
             * value smuggle a second header or break out of an attribute in whatever
             * consumes it downstream, and nothing legitimate needs one.
             */
            if raw.chars().any(|c| c.is_control() || c == '"' || c == '\'' || c == '<' || c == '>') {
                return Err(FactoryError::BadProfile {
                    field: field.into(),
                    reason: "contains a control character or quote".into(),
                });
            }
        }
        Ok(())
    }
}

#[cw_serde]
pub struct Launch {
    pub id: u64,
    pub denom: String,
    pub creator: Addr,
    pub curve: Addr,
    /// Defaulted so a launch stored before this field existed still deserialises.
    #[serde(default)]
    pub profile: TokenProfile,
}

/// Parameters parked while the curve instantiate is in flight.
#[cw_serde]
struct Pending {
    id: u64,
    denom: String,
    creator: Addr,
    /// The creator's opening buy, spent in the reply once the curve exists.
    #[serde(default)]
    initial_buy: Option<Uint128>,
    /// What the creator pays with, carried so the reply does not have to reload the
    /// config to learn one string.
    #[serde(default)]
    quote_denom: String,
    /// Carried across the reply because `Launch` is not written until the curve
    /// instantiate comes back, and the submessage reply cannot see the original
    /// `info`. Validated before this is parked, so what lands here is already clean.
    profile: TokenProfile,
}

pub const CONFIG: Item<Config> = Item::new("config");
pub const LAUNCHES: Map<u64, Launch> = Map::new("launches");
pub const BY_DENOM: Map<&str, u64> = Map::new("by_denom");
pub const NEXT_ID: Item<u64> = Item::new("next_id");

/// Quote assets a launch may be priced in, and their decimals.
///
/// AN ALLOWLIST, NOT ANY DENOM, for two separate reasons and both matter.
///
/// The decimals are the correctness one. A quote's decimals set the scale of the
/// curve, and nothing on chain reliably reports them for an arbitrary bank denom:
/// `denoms_metadata` is optional and a tokenfactory denom often carries none. Reading
/// them wrong does not fail, it produces a launch whose graduation target is off by
/// orders of magnitude. So the admin records them once, per asset, deliberately.
///
/// The curation is the other. Any address can create a bank denom on Injective, so an
/// open quote field means a launch priced in a worthless token the creator minted
/// that morning, which would read on the board exactly like a real pair.
pub const QUOTES: Map<&str, u8> = Map::new("quotes");
const PENDING: Item<Pending> = Item::new("pending");

fn default_quote_decimals() -> u8 {
    18
}

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub curve_code_id: u64,
    pub platform: String,
    pub migration_target: String,
    pub quote_denom: String,
    /// Decimals of the default quote. INJ is 18; Injective's USDC is 6, which is the
    /// reason this is asked for rather than assumed. Defaults to 18 so an existing
    /// deployment script that does not send it still produces an INJ factory.
    #[serde(default = "default_quote_decimals")]
    pub quote_decimals: u8,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Create a launch. The entire token supply must be attached:
    /// `curve.curve_supply + lp_reserve`. The factory forwards it to the new
    /// curve contract, so the factory never holds launch funds itself.
    CreateLaunch {
        denom: String,
        /// The trading fee, in bps. The only number about the curve a creator picks:
        /// its shape is `fixed_curve()` and is identical on every launch in a quote.
        fee_bps: u16,
        /// What buyers pay with. Must be allowlisted; absent means the factory's
        /// default, which is what every launch before this field existed used.
        #[serde(default)]
        quote_denom: Option<String>,
        /// Optional, and absent is a perfectly good answer: a token with no links is
        /// honest, where a token with a broken one is not.
        #[serde(default)]
        profile: TokenProfile,
        /// Trading rules the curve enforces until graduation. Absent means an open
        /// launch, which is what every launch before this field existed was.
        #[serde(default)]
        rules: LaunchRules,
        /// Quote the creator spends on their own launch, in the same transaction.
        ///
        /// What every launchpad calls a dev buy, and what creators expect: without it
        /// the only way to take a position in your own launch is a second transaction
        /// that a bot watching the mempool can land first, which is the whole problem.
        ///
        /// This amount must be ATTACHED as quote alongside the token seed, so the
        /// factory never has to be funded and never holds anything between
        /// transactions. It is spent inside the reply, on the curve that was just
        /// created, with the tokens sent to the creator rather than to the factory.
        #[serde(default)]
        initial_buy: Option<Uint128>,
    },
    /// Allow a quote asset, recording the decimals the curve will be scaled to.
    ///
    /// Also used to correct one: a wrong decimals value is the single most damaging
    /// thing in this contract's configuration, so it must be fixable without a
    /// redeploy. Launches already created keep the curve they were given, because the
    /// curve is stored on the child at instantiate and nothing here can reach it.
    SetQuote { denom: String, decimals: u8 },
    /// Stop new launches using a quote asset. Existing launches are untouched: their
    /// curve and their reserve are on the curve contract and keep working.
    RemoveQuote { denom: String },
    /// Point the factory at a new curve code id. Only affects future launches;
    /// existing ones are immutable by construction.
    SetCurveCodeId { code_id: u64 },
    UpdateAdmin { admin: String },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(Config)]
    Config {},
    #[returns(Launch)]
    Launch { id: u64 },
    #[returns(Launch)]
    LaunchByDenom { denom: String },
    #[returns(LaunchesResponse)]
    Launches {
        start_after: Option<u64>,
        limit: Option<u32>,
    },
    /// Quote assets a launch may be priced in, with their decimals.
    ///
    /// The create form needs this to decide whether to OFFER a choice at all: with
    /// one allowlisted quote a picker is a control that does nothing, and with
    /// several it is the difference between this launchpad and a single-pair one.
    #[returns(QuotesResponse)]
    Quotes {},
}

#[cw_serde]
pub struct QuoteAsset {
    pub denom: String,
    pub decimals: u8,
}

#[cw_serde]
pub struct QuotesResponse {
    pub quotes: Vec<QuoteAsset>,
    /// Which one a launch gets when it names none.
    pub default_denom: String,
}

#[cw_serde]
pub struct LaunchesResponse {
    pub launches: Vec<Launch>,
}

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, FactoryError> {
    CONFIG.save(
        deps.storage,
        &Config {
            admin: deps.api.addr_validate(&msg.admin)?,
            curve_code_id: msg.curve_code_id,
            platform: deps.api.addr_validate(&msg.platform)?,
            migration_target: deps.api.addr_validate(&msg.migration_target)?,
            quote_denom: msg.quote_denom.clone(),
        },
    )?;
    /*
     * The default quote is allowlisted at birth, with the decimals the instantiator
     * declares. Without this the allowlist is empty and `create_launch` refuses
     * EVERY launch, including one that named no quote at all: a factory that
     * instantiates cleanly and then rejects its own default is an outage that looks
     * like a setting.
     */
    if msg.quote_decimals > 24 {
        return Err(FactoryError::BadQuoteDecimals {
            denom: msg.quote_denom,
            decimals: msg.quote_decimals,
        });
    }
    QUOTES.save(deps.storage, &msg.quote_denom, &msg.quote_decimals)?;
    NEXT_ID.save(deps.storage, &1u64)?;
    Ok(Response::new().add_attribute("action", "instantiate_factory"))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, FactoryError> {
    match msg {
        ExecuteMsg::CreateLaunch {
            denom,
            fee_bps,
            quote_denom,
            profile,
            rules,
            initial_buy,
        } => create_launch(
            deps,
            env,
            info,
            denom,
            fee_bps,
            quote_denom,
            profile,
            rules,
            initial_buy,
        ),
        ExecuteMsg::SetQuote { denom, decimals } => {
            let cfg = CONFIG.load(deps.storage)?;
            if info.sender != cfg.admin {
                return Err(FactoryError::Unauthorised);
            }
            /*
             * Bounded, because this number scales the whole curve. 24 is already past
             * any real denom and the next power overflows the multiplication; refusing
             * here is the only place it can be caught, since `fixed_curve` runs on a
             * value this has already accepted.
             */
            if decimals > 24 {
                return Err(FactoryError::BadQuoteDecimals { denom, decimals });
            }
            if denom.trim().is_empty() {
                return Err(FactoryError::BadQuoteDenom);
            }
            QUOTES.save(deps.storage, &denom, &decimals)?;
            Ok(Response::new()
                .add_attribute("action", "set_quote")
                .add_attribute("denom", denom)
                .add_attribute("decimals", decimals.to_string()))
        }
        ExecuteMsg::RemoveQuote { denom } => {
            let cfg = CONFIG.load(deps.storage)?;
            if info.sender != cfg.admin {
                return Err(FactoryError::Unauthorised);
            }
            /*
             * The factory's own default quote cannot be removed. Removing it would
             * leave a factory that accepts no quote at all and whose `CreateLaunch`
             * refuses everything, which looks like an outage rather than a setting.
             */
            if denom == cfg.quote_denom {
                return Err(FactoryError::CannotRemoveDefaultQuote { denom });
            }
            QUOTES.remove(deps.storage, &denom);
            Ok(Response::new()
                .add_attribute("action", "remove_quote")
                .add_attribute("denom", denom))
        }
        ExecuteMsg::SetCurveCodeId { code_id } => {
            let mut cfg = CONFIG.load(deps.storage)?;
            if info.sender != cfg.admin {
                return Err(FactoryError::Unauthorised);
            }
            cfg.curve_code_id = code_id;
            CONFIG.save(deps.storage, &cfg)?;
            Ok(Response::new()
                .add_attribute("action", "set_curve_code_id")
                .add_attribute("code_id", code_id.to_string()))
        }
        ExecuteMsg::UpdateAdmin { admin } => {
            let mut cfg = CONFIG.load(deps.storage)?;
            if info.sender != cfg.admin {
                return Err(FactoryError::Unauthorised);
            }
            cfg.admin = deps.api.addr_validate(&admin)?;
            CONFIG.save(deps.storage, &cfg)?;
            Ok(Response::new().add_attribute("action", "update_admin"))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn create_launch(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    denom: String,
    fee_bps: u16,
    quote_denom: Option<String>,
    profile: TokenProfile,
    rules: LaunchRules,
    initial_buy: Option<Uint128>,
) -> Result<Response, FactoryError> {
    let cfg = CONFIG.load(deps.storage)?;

    // Before anything is written or any id is consumed. A launch that fails on its
    // last step still burns a reply slot and leaves the creator resubmitting.
    profile.validate()?;

    if BY_DENOM.has(deps.storage, &denom) {
        return Err(FactoryError::DenomTaken { denom });
    }

    /*
     * The curve is BUILT, not received. Its shape is the same on every launch, which
     * is what makes two cards on the board comparable, so there is no caller input
     * left to validate here beyond the fee.
     *
     * Still validated, because the constants are hand-written and a typo in one of
     * them would otherwise produce a factory that happily instantiates curves nobody
     * can trade. The child validates again on instantiate.
     */
    /*
     * The quote, and the decimals that scale the curve to it.
     *
     * Resolved from the allowlist rather than taken from the caller or read off the
     * chain. `denoms_metadata` is optional on Injective and a tokenfactory denom
     * usually carries none, so there is no reliable on-chain source; and a wrong
     * value here does not fail, it produces a launch whose graduation target is out
     * by orders of magnitude. The admin records it once, per asset.
     */
    let quote = quote_denom.unwrap_or_else(|| cfg.quote_denom.clone());
    let quote_decimals = QUOTES
        .may_load(deps.storage, &quote)?
        .ok_or_else(|| FactoryError::QuoteNotAllowed { denom: quote.clone() })?;

    let curve = fixed_curve(fee_bps, quote_decimals);
    let lp_reserve = lp_reserve();
    let parsed: CurveConfig = (&curve).into();
    parsed.validate()?;

    /*
     * Belt and braces on the one thing the constants could get wrong silently: if
     * `CURVE_SUPPLY` were ever edited without `FIXED_TOTAL_SUPPLY`, `lp_reserve()`
     * absorbs the difference and nothing looks wrong. This is the assertion that the
     * seed a creator attaches is the whole supply and none of it goes missing.
     */
    let required = curve.curve_supply.checked_add(lp_reserve)?;
    if required != FIXED_TOTAL_SUPPLY {
        return Err(FactoryError::BadTotalSupply {
            expected: FIXED_TOTAL_SUPPLY,
            got: required,
        });
    }

    /*
     * The opening buy, measured in supply rather than in quote.
     *
     * Quoted against a FRESH curve, which is what it will execute against: the reply
     * handler spends it on a curve nobody has traded yet. Quoting it against anything
     * else would let the cap pass here and the real buy take more.
     */
    if let Some(spend) = initial_buy.filter(|v| !v.is_zero()) {
        let quote = launchpad_math::quote_buy(
            &parsed,
            &launchpad_math::CurveState {
                inj_collected: Uint128::zero(),
                tokens_sold: Uint128::zero(),
                graduated: false,
            },
            spend,
        )?;
        // `multiply_ratio` rather than mul-then-div: it widens internally, so a
        // supply near the Uint128 ceiling cannot overflow the intermediate, and it
        // rounds DOWN, which tightens the cap rather than loosening it.
        let ceiling = curve
            .curve_supply
            .multiply_ratio(MAX_INITIAL_BUY_BPS, 10_000u128);
        if quote.tokens_out > ceiling {
            return Err(FactoryError::InitialBuyTooLarge {
                tokens: quote.tokens_out,
                max: ceiling,
            });
        }
    }

    /*
     * TWO denoms may arrive now, and `must_pay` accepts exactly one.
     *
     * It was `cw_utils::must_pay(&info, &denom)`, which refuses anything but a single
     * coin, so attaching quote for an opening buy failed with `MultipleDenoms` and the
     * feature could not work at all. Replacing it means writing the check by hand,
     * which is the part worth being careful about: this is the only thing standing
     * between a launch and a seed that does not match what the curve was told.
     *
     * Three conditions, and all three matter:
     *   - exactly `required` of the launch token, as before
     *   - exactly the declared `initial_buy` of quote, so the amount the creator
     *     approved on screen is the amount that gets spent
     *   - NOTHING ELSE attached, because a third denom is funds the factory would be
     *     left holding with no path out, and a contract that silently keeps dust is
     *     how a fund-holding factory starts
     */
    let want_quote = initial_buy.unwrap_or_default();
    let mut got_seed = Uint128::zero();
    let mut got_quote = Uint128::zero();
    for coin in &info.funds {
        if coin.denom == denom {
            got_seed = got_seed.checked_add(coin.amount)?;
        } else if coin.denom == quote {
            got_quote = got_quote.checked_add(coin.amount)?;
        } else {
            return Err(FactoryError::UnexpectedFunds {
                denom: coin.denom.clone(),
            });
        }
    }

    if got_seed != required {
        return Err(FactoryError::BadSeed {
            denom,
            expected: required,
            got: got_seed,
        });
    }
    if got_quote != want_quote {
        /*
         * Both directions are refused. Too little and the buy fails mid-reply, taking
         * the whole launch with it after the creator has signed; too much and the
         * surplus has nowhere to go, because the reply spends exactly what was
         * declared.
         */
        return Err(FactoryError::BadInitialBuy {
            expected: want_quote,
            got: got_quote,
        });
    }

    let id = NEXT_ID.load(deps.storage)?;
    NEXT_ID.save(deps.storage, &(id + 1))?;
    PENDING.save(
        deps.storage,
        &Pending {
            id,
            denom: denom.clone(),
            creator: info.sender.clone(),
            profile,
            initial_buy,
            quote_denom: quote.clone(),
        },
    )?;

    /*
     * Validated here as well as in the curve, for the same reason the curve config is:
     * failing early means a bad launch never consumes a reply slot or an id, and the
     * creator sees which rule was wrong rather than a submessage failure.
     */
    rules.validate(curve.curve_supply, curve.fee_bps)?;

    let init = CurveInstantiateMsg {
        rules,
        denom: denom.clone(),
        // The launch's quote, not the factory's default. Sending the default here
        // would create a curve that prices in INJ while the funds check accepted
        // USDC, and the mismatch would only surface at the first trade.
        quote_denom: quote.clone(),
        creator: info.sender.to_string(),
        platform: cfg.platform.to_string(),
        migration_target: cfg.migration_target.to_string(),
        lp_reserve,
        // Policy, not a parameter: the creator never had a say and the curve stores
        // the figure it was launched under, so a later change to this constant does
        // not re-price a launch that is already running.
        creator_fee_share_bps: CREATOR_FEE_SHARE_BPS,
        curve,
    };

    // The seed is forwarded straight through, so the factory is never a
    // custodian of launch funds even for one block.
    let sub = SubMsg::reply_on_success(
        WasmMsg::Instantiate {
            admin: Some(env.contract.address.to_string()),
            code_id: cfg.curve_code_id,
            msg: to_json_binary(&init)?,
            funds: vec![Coin {
                denom: denom.clone(),
                amount: required,
            }],
            label: format!("curve-{id}-{denom}"),
        },
        REPLY_INSTANTIATE_CURVE,
    );

    Ok(Response::new()
        .add_submessage(sub)
        .add_attribute("action", "create_launch")
        .add_attribute("id", id.to_string())
        .add_attribute("denom", denom)
        .add_attribute("creator", info.sender.as_str()))
}

#[entry_point]
pub fn reply(deps: DepsMut, _env: Env, msg: Reply) -> Result<Response, FactoryError> {
    if msg.id != REPLY_INSTANTIATE_CURVE {
        return Err(FactoryError::UnknownReply { id: msg.id });
    }
    let pending = PENDING
        .may_load(deps.storage)?
        .ok_or(FactoryError::NoPendingLaunch)?;
    PENDING.remove(deps.storage);

    let addr = instantiated_address(&msg).ok_or(FactoryError::MissingInstantiateAddress)?;
    let curve = deps.api.addr_validate(&addr)?;

    let launch = Launch {
        id: pending.id,
        denom: pending.denom.clone(),
        creator: pending.creator,
        curve: curve.clone(),
        profile: pending.profile,
    };
    LAUNCHES.save(deps.storage, pending.id, &launch)?;
    BY_DENOM.save(deps.storage, &pending.denom, &pending.id)?;

    let mut res = Response::new()
        .add_attribute("action", "launch_created")
        .add_attribute("id", pending.id.to_string())
        .add_attribute("curve", curve.as_str());

    /*
     * The creator's opening buy, spent on the curve that was just created.
     *
     * `recipient` is the creator, not this contract. A curve pays whoever sent the
     * message, so without it the factory would be the buyer of record and would be
     * left holding the tokens, which is both wrong and a fund-holding factory.
     *
     * `min_tokens_out` is zero deliberately. This buy is the FIRST trade on a curve
     * that was created in the same transaction, so there is no one to be front-run by
     * and nothing for a slippage bound to protect against: the price is determined
     * entirely by parameters the creator just chose. A non-zero bound here could only
     * fail the launch.
     */
    if let Some(amount) = pending.initial_buy {
        if !amount.is_zero() {
            res = res
                .add_message(WasmMsg::Execute {
                    contract_addr: curve.to_string(),
                    msg: to_json_binary(&CurveExecuteMsg::Buy {
                        min_tokens_out: Uint128::zero(),
                        recipient: Some(launch.creator.to_string()),
                    })?,
                    funds: coins(amount.u128(), &pending.quote_denom),
                })
                .add_attribute("initial_buy", amount);
        }
    }

    Ok(res)
}

/// Dig the new contract address out of the instantiate reply. Reading the
/// event rather than the response data keeps this working whether or not the
/// child sets `data`.
fn instantiated_address(msg: &Reply) -> Option<String> {
    let res = match &msg.result {
        cosmwasm_std::SubMsgResult::Ok(r) => r,
        cosmwasm_std::SubMsgResult::Err(_) => return None,
    };
    res.events
        .iter()
        .find(|e| e.ty == "instantiate")
        .and_then(|e| {
            e.attributes
                .iter()
                .find(|a| a.key == "_contract_address" || a.key == "contract_address")
        })
        .map(|a| a.value.clone())
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Quotes {} => {
            let cfg = CONFIG.load(deps.storage)?;
            let quotes = QUOTES
                .range(deps.storage, None, None, cosmwasm_std::Order::Ascending)
                .map(|r| r.map(|(denom, decimals)| QuoteAsset { denom, decimals }))
                .collect::<Result<Vec<_>, _>>()?;
            to_json_binary(&QuotesResponse { quotes, default_denom: cfg.quote_denom })
        }
        QueryMsg::Launch { id } => to_json_binary(&LAUNCHES.load(deps.storage, id)?),
        QueryMsg::LaunchByDenom { denom } => {
            let id = BY_DENOM.load(deps.storage, &denom)?;
            to_json_binary(&LAUNCHES.load(deps.storage, id)?)
        }
        QueryMsg::Launches { start_after, limit } => {
            let limit = limit.unwrap_or(30).min(100) as usize;
            let start = start_after.map(cw_storage_plus::Bound::exclusive);
            let launches = LAUNCHES
                .range(deps.storage, start, None, Order::Ascending)
                .take(limit)
                .map(|r| r.map(|(_, v)| v))
                .collect::<StdResult<Vec<_>>>()?;
            to_json_binary(&LaunchesResponse { launches })
        }
    }
}
