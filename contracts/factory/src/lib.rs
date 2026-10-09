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

    #[error("creator fee share is {got} bps, maximum is 10000")]
    BadFeeShare { got: u16 },

    /// Names the field, because a form with four URL inputs and one rejection that
    /// says only "invalid" leaves the creator guessing which one.
    #[error("token profile field `{field}` is invalid: {reason}")]
    BadProfile { field: String, reason: String },

    #[error("unexpected funds attached: {denom}")]
    UnexpectedFunds { denom: String },

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
const PENDING: Item<Pending> = Item::new("pending");

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: String,
    pub curve_code_id: u64,
    pub platform: String,
    pub migration_target: String,
    pub quote_denom: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Create a launch. The entire token supply must be attached:
    /// `curve.curve_supply + lp_reserve`. The factory forwards it to the new
    /// curve contract, so the factory never holds launch funds itself.
    CreateLaunch {
        denom: String,
        lp_reserve: Uint128,
        creator_fee_share_bps: u16,
        curve: CurveConfigStored,
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
            quote_denom: msg.quote_denom,
        },
    )?;
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
            lp_reserve,
            creator_fee_share_bps,
            curve,
            profile,
            rules,
            initial_buy,
        } => create_launch(
            deps,
            env,
            info,
            denom,
            lp_reserve,
            creator_fee_share_bps,
            curve,
            profile,
            rules,
            initial_buy,
        ),
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
    lp_reserve: Uint128,
    creator_fee_share_bps: u16,
    curve: CurveConfigStored,
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
    if creator_fee_share_bps > 10_000 {
        return Err(FactoryError::BadFeeShare {
            got: creator_fee_share_bps,
        });
    }

    // Validate the curve here as well as in the child. Failing early means a
    // bad launch never consumes a reply slot or an id.
    let parsed: CurveConfig = (&curve).into();
    parsed.validate()?;

    let required = curve.curve_supply.checked_add(lp_reserve)?;

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
        } else if coin.denom == cfg.quote_denom {
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
            quote_denom: cfg.quote_denom.clone(),
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
        quote_denom: cfg.quote_denom.clone(),
        creator: info.sender.to_string(),
        platform: cfg.platform.to_string(),
        migration_target: cfg.migration_target.to_string(),
        lp_reserve,
        creator_fee_share_bps,
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
