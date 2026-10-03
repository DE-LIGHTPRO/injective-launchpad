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
    Response, StdResult, SubMsg, Uint128, WasmMsg,
};
use cw_storage_plus::{Item, Map};
use launchpad_math::CurveConfig;
use thiserror::Error;

use curve::msg::InstantiateMsg as CurveInstantiateMsg;
use curve::state::CurveConfigStored;

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

#[cw_serde]
pub struct Launch {
    pub id: u64,
    pub denom: String,
    pub creator: Addr,
    pub curve: Addr,
}

/// Parameters parked while the curve instantiate is in flight.
#[cw_serde]
struct Pending {
    id: u64,
    denom: String,
    creator: Addr,
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
        } => create_launch(deps, env, info, denom, lp_reserve, creator_fee_share_bps, curve),
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
) -> Result<Response, FactoryError> {
    let cfg = CONFIG.load(deps.storage)?;

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
    let sent = cw_utils::must_pay(&info, &denom)?;
    if sent != required {
        return Err(FactoryError::BadSeed {
            denom,
            expected: required,
            got: sent,
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
        },
    )?;

    let init = CurveInstantiateMsg {
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
    };
    LAUNCHES.save(deps.storage, pending.id, &launch)?;
    BY_DENOM.save(deps.storage, &pending.denom, &pending.id)?;

    Ok(Response::new()
        .add_attribute("action", "launch_created")
        .add_attribute("id", pending.id.to_string())
        .add_attribute("curve", curve.as_str()))
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
