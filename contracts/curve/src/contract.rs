use cosmwasm_std::{
    coins, entry_point, to_json_binary, BankMsg, Binary, Deps, DepsMut, Env, MessageInfo, Response,
    StdResult, Uint128,
};
use launchpad_math::{quote_buy, quote_sell, spot_price, CurveConfig};

use crate::error::ContractError;
use crate::msg::{
    ExecuteMsg, InstantiateMsg, QueryMsg, SimulateBuyResponse, SimulateSellResponse,
    SpotPriceResponse,
};
use crate::state::{Config, State, CONFIG, STATE};

const BPS: u128 = 10_000;

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    if msg.denom == msg.quote_denom {
        return Err(ContractError::SameDenom);
    }
    if msg.creator_fee_share_bps > BPS as u16 {
        return Err(ContractError::BadFeeShare {
            got: msg.creator_fee_share_bps,
        });
    }

    let curve: CurveConfig = (&msg.curve).into();
    curve.validate()?;

    // The launch is funded here and only here: the creator sends the entire
    // sellable supply up front. Nothing mints later, so the curve can never
    // promise tokens it does not hold.
    // Sellable supply plus the LP allocation held back for migration.
    let required = msg.curve.curve_supply.checked_add(msg.lp_reserve)?;
    let sent = cw_utils::must_pay(&info, &msg.denom)?;
    if sent != required {
        return Err(ContractError::BadSeed {
            denom: msg.denom.clone(),
            expected: required,
            got: sent,
        });
    }

    let cfg = Config {
        denom: msg.denom,
        quote_denom: msg.quote_denom,
        creator: deps.api.addr_validate(&msg.creator)?,
        platform: deps.api.addr_validate(&msg.platform)?,
        migration_target: deps.api.addr_validate(&msg.migration_target)?,
        lp_reserve: msg.lp_reserve,
        creator_fee_share_bps: msg.creator_fee_share_bps,
        curve: msg.curve,
    };
    CONFIG.save(deps.storage, &cfg)?;
    STATE.save(deps.storage, &State::default())?;

    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("denom", cfg.denom)
        .add_attribute("curve_supply", cfg.curve.curve_supply)
        .add_attribute("graduation_target", cfg.curve.graduation_target))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::Buy { min_tokens_out } => exec_buy(deps, info, min_tokens_out),
        ExecuteMsg::Sell { min_inj_out } => exec_sell(deps, info, min_inj_out),
        ExecuteMsg::Graduate {} => exec_graduate(deps, env),
        ExecuteMsg::ClaimFees {} => exec_claim_fees(deps),
    }
}

/// Split a fee between creator and platform. Creator's share rounds down, so
/// any odd unit lands with the platform rather than being conjured.
fn split_fee(fee: Uint128, creator_share_bps: u16) -> (Uint128, Uint128) {
    let creator = fee.multiply_ratio(creator_share_bps as u128, BPS);
    let platform = fee.checked_sub(creator).unwrap_or(Uint128::zero());
    (creator, platform)
}

fn exec_buy(
    deps: DepsMut,
    info: MessageInfo,
    min_tokens_out: Uint128,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    if state.graduated {
        return Err(ContractError::Graduated);
    }

    let inj_in = cw_utils::must_pay(&info, &cfg.quote_denom)?;
    let curve: CurveConfig = (&cfg.curve).into();
    let q = quote_buy(&curve, &state.curve_state(), inj_in)?;

    if q.tokens_out < min_tokens_out {
        return Err(ContractError::Slippage {
            got: q.tokens_out,
            min: min_tokens_out,
        });
    }

    let (creator_cut, platform_cut) = split_fee(q.fee, cfg.creator_fee_share_bps);

    // Effects before interactions: state is written before any funds move.
    state.inj_collected = state.inj_collected.checked_add(q.inj_in_after_fee)?;
    state.tokens_sold = state.tokens_sold.checked_add(q.tokens_out)?;
    state.creator_owed = state.creator_owed.checked_add(creator_cut)?;
    state.platform_owed = state.platform_owed.checked_add(platform_cut)?;
    if q.graduates {
        state.graduated = true;
    }
    STATE.save(deps.storage, &state)?;

    let mut res = Response::new()
        .add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: coins(q.tokens_out.u128(), &cfg.denom),
        })
        .add_attribute("action", "buy")
        .add_attribute("buyer", info.sender.as_str())
        .add_attribute("inj_in", inj_in)
        .add_attribute("tokens_out", q.tokens_out)
        .add_attribute("fee", q.fee)
        .add_attribute("refund", q.refund)
        .add_attribute("graduated", q.graduates.to_string());

    // Partial fill: hand back whatever the curve could not absorb.
    if !q.refund.is_zero() {
        res = res.add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: coins(q.refund.u128(), &cfg.quote_denom),
        });
    }

    Ok(res)
}

fn exec_sell(
    deps: DepsMut,
    info: MessageInfo,
    min_inj_out: Uint128,
) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    if state.graduated {
        return Err(ContractError::Graduated);
    }

    let tokens_in = cw_utils::must_pay(&info, &cfg.denom)?;
    let curve: CurveConfig = (&cfg.curve).into();
    let q = quote_sell(&curve, &state.curve_state(), tokens_in)?;

    if q.inj_out < min_inj_out {
        return Err(ContractError::Slippage {
            got: q.inj_out,
            min: min_inj_out,
        });
    }

    // The reserve gives up the full gross; the fee is skimmed off it, not
    // added on top, so the reserve always backs what remains outstanding.
    let gross = q.inj_out.checked_add(q.fee)?;
    let (creator_cut, platform_cut) = split_fee(q.fee, cfg.creator_fee_share_bps);

    state.inj_collected = state.inj_collected.checked_sub(gross)?;
    state.tokens_sold = state.tokens_sold.checked_sub(tokens_in)?;
    state.creator_owed = state.creator_owed.checked_add(creator_cut)?;
    state.platform_owed = state.platform_owed.checked_add(platform_cut)?;
    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: coins(q.inj_out.u128(), &cfg.quote_denom),
        })
        .add_attribute("action", "sell")
        .add_attribute("seller", info.sender.as_str())
        .add_attribute("tokens_in", tokens_in)
        .add_attribute("inj_out", q.inj_out)
        .add_attribute("fee", q.fee))
}

fn exec_graduate(deps: DepsMut, _env: Env) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;

    if state.migrated {
        return Err(ContractError::Graduated);
    }
    // Defensive: allow graduation on the target being met even if no buy
    // happened to set the flag.
    if !state.graduated && state.inj_collected < cfg.curve.graduation_target {
        return Err(ContractError::NotReady);
    }

    let reserve = state.inj_collected;
    // The held-back LP allocation, plus anything the curve never managed to
    // sell. The LP allocation is what guarantees the migrated pool has a
    // token side at all, even when the curve sells out exactly.
    let unsold = cfg
        .curve
        .curve_supply
        .checked_sub(state.tokens_sold)
        .unwrap_or(Uint128::zero());
    let leftover = cfg.lp_reserve.checked_add(unsold)?;

    state.graduated = true;
    state.migrated = true;
    state.inj_collected = Uint128::zero();
    state.tokens_sold = cfg.curve.curve_supply;
    STATE.save(deps.storage, &state)?;

    let mut res = Response::new()
        .add_attribute("action", "graduate")
        .add_attribute("reserve_moved", reserve)
        .add_attribute("tokens_moved", leftover)
        .add_attribute("target", cfg.migration_target.as_str());

    // Fees are deliberately left behind for ClaimFees; only the reserve and
    // the unsold tokens become liquidity.
    if !reserve.is_zero() {
        res = res.add_message(BankMsg::Send {
            to_address: cfg.migration_target.to_string(),
            amount: coins(reserve.u128(), &cfg.quote_denom),
        });
    }
    if !leftover.is_zero() {
        res = res.add_message(BankMsg::Send {
            to_address: cfg.migration_target.to_string(),
            amount: coins(leftover.u128(), &cfg.denom),
        });
    }

    Ok(res)
}

fn exec_claim_fees(deps: DepsMut) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;

    let creator = state.creator_owed;
    let platform = state.platform_owed;
    if creator.is_zero() && platform.is_zero() {
        return Err(ContractError::NothingToClaim);
    }

    state.creator_owed = Uint128::zero();
    state.platform_owed = Uint128::zero();
    STATE.save(deps.storage, &state)?;

    let mut res = Response::new()
        .add_attribute("action", "claim_fees")
        .add_attribute("creator", creator)
        .add_attribute("platform", platform);

    if !creator.is_zero() {
        res = res.add_message(BankMsg::Send {
            to_address: cfg.creator.to_string(),
            amount: coins(creator.u128(), &cfg.quote_denom),
        });
    }
    if !platform.is_zero() {
        res = res.add_message(BankMsg::Send {
            to_address: cfg.platform.to_string(),
            amount: coins(platform.u128(), &cfg.quote_denom),
        });
    }

    Ok(res)
}

#[entry_point]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::State {} => to_json_binary(&STATE.load(deps.storage)?),
        QueryMsg::SimulateBuy { inj_in } => {
            let cfg = CONFIG.load(deps.storage)?;
            let state = STATE.load(deps.storage)?;
            let curve: CurveConfig = (&cfg.curve).into();
            let q = quote_buy(&curve, &state.curve_state(), inj_in)
                .map_err(|e| cosmwasm_std::StdError::generic_err(e.to_string()))?;
            to_json_binary(&SimulateBuyResponse {
                tokens_out: q.tokens_out,
                fee: q.fee,
                refund: q.refund,
                graduates: q.graduates,
            })
        }
        QueryMsg::SimulateSell { tokens_in } => {
            let cfg = CONFIG.load(deps.storage)?;
            let state = STATE.load(deps.storage)?;
            let curve: CurveConfig = (&cfg.curve).into();
            let q = quote_sell(&curve, &state.curve_state(), tokens_in)
                .map_err(|e| cosmwasm_std::StdError::generic_err(e.to_string()))?;
            to_json_binary(&SimulateSellResponse {
                inj_out: q.inj_out,
                fee: q.fee,
            })
        }
        QueryMsg::SpotPrice { one_token } => {
            let cfg = CONFIG.load(deps.storage)?;
            let state = STATE.load(deps.storage)?;
            let curve: CurveConfig = (&cfg.curve).into();
            let price = spot_price(&curve, &state.curve_state(), one_token)
                .map_err(|e| cosmwasm_std::StdError::generic_err(e.to_string()))?;
            to_json_binary(&SpotPriceResponse { price })
        }
    }
}
