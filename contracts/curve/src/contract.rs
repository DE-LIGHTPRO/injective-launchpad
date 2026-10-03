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

#[cfg(test)]
mod tests {
    //! Unit tests for the handler-level checks the integration suite does not reach.
    //!
    //! `tests/integration.rs` already covers the behaviour of this contract through
    //! `cw-multi-test`: seeding, buys, sells, round trips, slippage, front-running,
    //! graduation once and only once, permissionless graduation, fees surviving
    //! migration, and solvency through mixed trading. I wrote sixteen tests here
    //! before reading that file, having counted `#[test]` in `src/*.rs` only, and
    //! eleven of them were duplicates of tests that already existed. They have been
    //! removed. A glob that misses `tests/` reports a project as untested when it has
    //! thirty-six tests, which is the same class of mistake as every other
    //! measurement error in this codebase's notes: the sweep was narrower than the
    //! claim drawn from it.
    //!
    //! What is left is the handful nothing else asserts, and they are unit-level on
    //! purpose: two are property sweeps over a pure function, and two are guards that
    //! sit in the handler before any state moves.

    use super::*;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env};
    use cosmwasm_std::{coin, from_json};

    const TOKEN: &str = "factory/inj1launch/KAIJU";
    const QUOTE: &str = "inj";
    const ONE: u128 = 1_000_000_000_000_000_000;
    const LP_RESERVE: u128 = 200_000_000 * ONE;

    fn curve_cfg() -> crate::state::CurveConfigStored {
        crate::state::CurveConfigStored {
            virtual_inj: Uint128::new(30 * ONE),
            virtual_tokens: Uint128::new(1_073_000_000 * ONE),
            curve_supply: Uint128::new(800_000_000 * ONE),
            graduation_target: Uint128::new(85 * ONE),
            fee_bps: 100,
        }
    }

    type Deps0 = cosmwasm_std::OwnedDeps<
        cosmwasm_std::testing::MockStorage,
        cosmwasm_std::testing::MockApi,
        cosmwasm_std::testing::MockQuerier,
    >;

    /// An instantiated curve, seeded correctly.
    fn setup() -> (Deps0, cosmwasm_std::Addr) {
        let mut deps = mock_dependencies();
        let who = deps.api.addr_make("creator");
        let seed = curve_cfg().curve_supply.u128() + LP_RESERVE;
        let msg = InstantiateMsg {
            denom: TOKEN.to_string(),
            quote_denom: QUOTE.to_string(),
            creator: who.to_string(),
            platform: who.to_string(),
            migration_target: who.to_string(),
            lp_reserve: Uint128::new(LP_RESERVE),
            creator_fee_share_bps: 2_000,
            curve: curve_cfg(),
        };
        let info = message_info(&who, &[coin(seed, TOKEN)]);
        instantiate(deps.as_mut(), mock_env(), info, msg).expect("instantiate");
        (deps, who)
    }

    #[test]
    fn a_launch_cannot_be_quoted_in_its_own_token() {
        // There is no curve between a token and itself, and it would make every
        // `must_pay` in this contract ambiguous: one coin would satisfy both sides.
        let mut deps = mock_dependencies();
        let who = deps.api.addr_make("creator");
        let msg = InstantiateMsg {
            denom: QUOTE.to_string(),
            quote_denom: QUOTE.to_string(),
            creator: who.to_string(),
            platform: who.to_string(),
            migration_target: who.to_string(),
            lp_reserve: Uint128::zero(),
            creator_fee_share_bps: 0,
            curve: curve_cfg(),
        };
        let info = message_info(&who, &[coin(1, QUOTE)]);
        let err = instantiate(deps.as_mut(), mock_env(), info, msg).unwrap_err();
        assert!(matches!(err, ContractError::SameDenom), "got {err:?}");
    }

    #[test]
    fn the_fee_split_never_loses_or_invents_a_unit() {
        /*
         * `creator = floor(fee * share / BPS)` and `platform = fee - creator`.
         * Taking the remainder rather than computing the second share is what makes
         * the two sum to the fee exactly at every share and every fee; computing
         * both independently would drop a unit at most odd splits, and that unit
         * would be owed to nobody while still leaving the contract.
         *
         * Swept rather than sampled, because the failure is in the rounding and a
         * single example is as likely to miss it as to find it.
         */
        for share in [0u16, 1, 3, 2_000, 3_333, 5_000, 6_667, 9_999, 10_000] {
            for fee in [0u128, 1, 2, 3, 7, 99, 100, 101, 9_999, 1_000_000_007, u64::MAX as u128] {
                let (creator, platform) = split_fee(Uint128::new(fee), share);
                assert_eq!(creator + platform, Uint128::new(fee), "share {share}, fee {fee}");
                assert!(creator <= Uint128::new(fee), "creator over-paid at share {share}");
            }
        }
    }

    #[test]
    fn the_wrong_denom_is_refused_rather_than_counted_as_the_other() {
        /*
         * `must_pay` is the only thing standing between "a buy paid in the launch
         * token" and the curve treating those units as quote. Both directions are
         * checked: the mistake is symmetrical and so is the damage.
         */
        let (mut deps, who) = setup();

        let info = message_info(&who, &[coin(ONE, TOKEN)]);
        let err = execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::Buy { min_tokens_out: Uint128::zero() },
        ).unwrap_err();
        assert!(matches!(err, ContractError::Payment(_)), "buy paid in the launch token: {err:?}");

        let info = message_info(&who, &[coin(ONE, QUOTE)]);
        let err = execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::Sell { min_inj_out: Uint128::zero() },
        ).unwrap_err();
        assert!(matches!(err, ContractError::Payment(_)), "sell paid in quote: {err:?}");

        // And nothing at all is refused too, rather than read as zero.
        let info = message_info(&who, &[]);
        let err = execute(
            deps.as_mut(), mock_env(), info,
            ExecuteMsg::Buy { min_tokens_out: Uint128::zero() },
        ).unwrap_err();
        assert!(matches!(err, ContractError::Payment(_)), "buy with no funds: {err:?}");
    }

    #[test]
    fn simulate_buy_is_exactly_what_executing_does() {
        /*
         * The UI quotes from `SimulateBuy`. The integration suite uses it as the
         * INPUT to its slippage and front-running scenarios, so it exercises the
         * query without ever asserting it equals execution. If the two diverged,
         * every quote shown would be wrong and the slippage guard would be
         * measuring against a number the chain never produces.
         *
         * This is the on-chain half of the parity the TypeScript port is checked
         * for: one implementation of the maths, three consumers, all of which must
         * agree.
         */
        let (mut deps, who) = setup();
        let sim: SimulateBuyResponse = from_json(
            query(deps.as_ref(), mock_env(), QueryMsg::SimulateBuy { inj_in: Uint128::new(7 * ONE) }).unwrap(),
        ).unwrap();

        let info = message_info(&who, &[coin(7 * ONE, QUOTE)]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Buy { min_tokens_out: Uint128::zero() })
            .expect("buy");

        let st = STATE.load(deps.as_ref().storage).unwrap();
        assert_eq!(sim.tokens_out, st.tokens_sold, "simulated tokens_out");
        assert_eq!(sim.fee, st.creator_owed + st.platform_owed, "simulated fee");
        assert_eq!(sim.graduates, st.graduated, "simulated graduation flag");
    }

    #[test]
    fn simulate_sell_is_exactly_what_executing_does() {
        // The same property on the other side, which is the leg a holder uses to
        // decide whether to exit.
        let (mut deps, who) = setup();
        let info = message_info(&who, &[coin(20 * ONE, QUOTE)]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Buy { min_tokens_out: Uint128::zero() })
            .expect("buy");

        let before = STATE.load(deps.as_ref().storage).unwrap();
        let sim: SimulateSellResponse = from_json(
            query(deps.as_ref(), mock_env(), QueryMsg::SimulateSell { tokens_in: before.tokens_sold }).unwrap(),
        ).unwrap();

        let info = message_info(&who, &[coin(before.tokens_sold.u128(), TOKEN)]);
        let res = execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Sell { min_inj_out: Uint128::zero() })
            .expect("sell");

        let paid: u128 = res.messages.iter().filter_map(|m| match &m.msg {
            cosmwasm_std::CosmosMsg::Bank(BankMsg::Send { amount, .. }) => Some(amount),
            _ => None,
        }).flatten().filter(|c| c.denom == QUOTE).map(|c| c.amount.u128()).sum();

        assert_eq!(sim.inj_out.u128(), paid, "simulated inj_out vs what was actually sent");
        let after = STATE.load(deps.as_ref().storage).unwrap();
        let fee_added = (after.creator_owed + after.platform_owed)
            - (before.creator_owed + before.platform_owed);
        assert_eq!(sim.fee, fee_added, "simulated fee");
    }

    #[test]
    fn the_spot_price_query_is_sane_and_rises_with_the_curve() {
        /*
         * `SpotPrice` is display-only and was tested nowhere. That makes it the
         * easiest number on the page to be quietly wrong: nothing reverts, nothing
         * reconciles, somebody just reads a price that is not the price.
         *
         * Two properties are enough to catch a broken one: it is positive on a
         * fresh curve, and it rises after a buy. A constant, a zero, or an inverted
         * quote all fail at least one.
         */
        let (mut deps, who) = setup();
        let one_token = Uint128::new(ONE);

        let fresh: SpotPriceResponse = from_json(
            query(deps.as_ref(), mock_env(), QueryMsg::SpotPrice { one_token }).unwrap(),
        ).unwrap();
        assert!(!fresh.price.is_zero(), "a fresh curve must still quote a price");

        let info = message_info(&who, &[coin(40 * ONE, QUOTE)]);
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Buy { min_tokens_out: Uint128::zero() })
            .expect("buy");

        let after: SpotPriceResponse = from_json(
            query(deps.as_ref(), mock_env(), QueryMsg::SpotPrice { one_token }).unwrap(),
        ).unwrap();
        assert!(
            after.price > fresh.price,
            "price must rise as the curve is bought: {} then {}",
            fresh.price, after.price,
        );
    }
}
