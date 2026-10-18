use cosmwasm_std::{
    coins, entry_point, to_json_binary, BankMsg, Binary, Deps, DepsMut, Env, MessageInfo, Response,
    StdResult, Uint128, Timestamp};
use launchpad_math::{
    pool_quote_buy, pool_quote_sell, pool_spot_price, quote_buy, quote_sell, spot_price,
    CurveConfig,
};

use crate::error::ContractError;
use crate::msg::{
    ExecuteMsg, InstantiateMsg, QueryMsg, SimulateBuyResponse, SimulateSellResponse,
    SpotPriceResponse,
};
use crate::state::{RewardRoute, PURCHASED, Config, State, CONFIG, STATE};

const BPS: u128 = 10_000;

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    env: Env,
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
    // Before the seed is checked, so a launch with a rule that can never bind is
    // refused before the creator's whole supply has moved anywhere.
    msg.rules.validate(msg.curve.curve_supply, msg.curve.fee_bps)?;

    // The launch is funded here and only here: the creator sends the entire
    // sellable supply up front. Nothing mints later, so the curve can never
    // promise tokens it does not hold.
    // Sellable supply plus the LP allocation held back for the locked pool.
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
        reward_route: msg.reward_route,
        denom: msg.denom,
        quote_denom: msg.quote_denom,
        creator: deps.api.addr_validate(&msg.creator)?,
        platform: deps.api.addr_validate(&msg.platform)?,
        lp_reserve: msg.lp_reserve,
        creator_fee_share_bps: msg.creator_fee_share_bps,
        curve: msg.curve,
        // Measured from when buying becomes possible, not from instantiate. A launch
        // announced a day in advance would otherwise burn its whole opening premium
        // before anyone was allowed to trade, which is the rule doing nothing while
        // appearing to be set.
        opened_at: msg.rules.trade_start.unwrap_or(env.block.time),
        rules: msg.rules,
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
        ExecuteMsg::Buy { min_tokens_out, recipient } => {
            exec_buy(deps, env, info, min_tokens_out, recipient)
        }
        ExecuteMsg::Sell { min_inj_out } => exec_sell(deps, info, min_inj_out),
        ExecuteMsg::Graduate {} => exec_graduate(deps, env),
        ExecuteMsg::ClaimFees {} => exec_claim_fees(deps),
    }
}

/// Where the creator's share of a fee actually goes.
///
/// The platform's share is never routed: it is the launchpad's and the creator does
/// not get to redirect it. Only the creator's own portion follows the route they
/// chose at launch, which is the whole point of offering the choice.
fn apply_route(state: &mut State, route: RewardRoute, creator_cut: Uint128) -> Result<(), ContractError> {
    match route {
        RewardRoute::Creator => {
            state.creator_owed = state.creator_owed.checked_add(creator_cut)?;
        }
        RewardRoute::Pool => {
            /*
             * Into `lp_bonus`, the same place the opening-fee premium is held: quote
             * kept out of `inj_collected` so it cannot move the curve, and paired
             * into the liquidity at graduation.
             *
             * Deliberately NOT added to `inj_collected`. That figure is one side of
             * the curve's invariant, and adding quote to it without issuing tokens
             * would move every later price.
             */
            state.lp_bonus = state.lp_bonus.checked_add(creator_cut)?;
        }
    }
    Ok(())
}

/// Split a fee between creator and platform. Creator's share rounds down, so
/// any odd unit lands with the platform rather than being conjured.
fn split_fee(fee: Uint128, creator_share_bps: u16) -> (Uint128, Uint128) {
    let creator = fee.multiply_ratio(creator_share_bps as u128, BPS);
    let platform = fee.checked_sub(creator).unwrap_or(Uint128::zero());
    (creator, platform)
}

/// The fee this buy actually pays, in bps.
///
/// Separate from the handler so the decay is testable at its own boundaries, which is
/// the lesson the wallet cap taught an hour earlier: an integration test cannot place a
/// trade at an exact second of the decay, so the arithmetic has to be reachable on its
/// own. The handler still proves it is called.
fn effective_fee_bps(cfg: &Config, now: Timestamp) -> u16 {
    let Some(ef) = &cfg.rules.early_fee else {
        return cfg.curve.fee_bps;
    };
    // Saturating: a block before `opened_at` is possible when a start time is set, and
    // it means zero elapsed rather than a negative that would wrap into a huge one.
    let elapsed = now.seconds().saturating_sub(cfg.opened_at.seconds());
    ef.bps_at(cfg.curve.fee_bps, elapsed)
}

/// A buy on the curve, with the opening premium taken off the top.
///
/// Returns the quote, the premium, and the part of the payment the FIRST quote already
/// found unabsorbable, which is still owed to the payer.
///
/// EXTRACTED BECAUSE THE SIMULATION COULD NOT SEE ANY OF IT. This lived inside
/// `exec_buy`, and `query` discarded its `Env`, so `SimulateBuy` quoted the base curve
/// with no way to know the block time and overstated `tokens_out` for the whole
/// duration of an opening window. A caller sizing a trade against it set
/// `min_tokens_out` from a figure this contract will not honour, so the simulation that
/// exists to stop a trade reverting was the thing causing it. Nothing in the app calls
/// `SimulateBuy`, so this reached integrators and bots rather than the panel - and a
/// simulation is mostly FOR them.
///
/// One function rather than a second copy in the query, because two transcriptions of
/// a fee basis is how the panel and the chain came to disagree in the first place.
fn quote_buy_with_premium(
    cfg: &Config,
    state: &State,
    inj_in: Uint128,
    now: Timestamp,
) -> Result<(launchpad_math::BuyQuote, Uint128, Uint128), ContractError> {
    let curve: CurveConfig = (&cfg.curve).into();
    let premium_bps = effective_fee_bps(cfg, now).saturating_sub(cfg.curve.fee_bps);
    if premium_bps == 0 {
        // The common path, byte for byte what it was before the rule existed.
        return Ok((
            quote_buy(&curve, &state.curve_state(), inj_in)?,
            Uint128::zero(),
            Uint128::zero(),
        ));
    }
    /*
     * CHARGED ON WHAT IS ACTUALLY SPENT. The curve refunds whatever a buy cannot
     * absorb, so skimming the premium from `inj_in` would charge it on quote that is
     * handed straight back. That only happens on the buy that fills the curve, which
     * during an opening window is close to impossible, and "close to impossible" is
     * exactly the assumption that becomes a defect. One extra quote settles it.
     */
    let probe = quote_buy(&curve, &state.curve_state(), inj_in)?;
    let spent = inj_in.checked_sub(probe.refund)?;
    let premium = spent.multiply_ratio(premium_bps as u128, BPS);
    // Reducing the input can only reduce the refund, never grow it, so the second
    // quote's own refund is normally zero; it is carried anyway rather than assumed.
    let q = quote_buy(&curve, &state.curve_state(), spent.checked_sub(premium)?)?;
    Ok((q, premium, probe.refund))
}

fn exec_buy(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    min_tokens_out: Uint128,
    recipient: Option<String>,
) -> Result<Response, ContractError> {
    /*
     * Validated, not trusted. An unvalidated string here would send a launch's whole
     * opening buy to an address that does not exist, and a bank send to a malformed
     * address fails the transaction rather than burning the funds, but only because
     * the bank module checks. Checking here names the problem instead.
     */
    let buyer = match &recipient {
        Some(r) => deps.api.addr_validate(r)?,
        None => info.sender.clone(),
    };
    let cfg = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    if state.migrated {
        return exec_pool_buy(deps, info, cfg, state, buyer, min_tokens_out);
    }
    if state.graduated {
        // Target met but the pool not yet seeded. Unreachable through `Buy`, which
        // seeds in the same transaction, but a curve must never be stuck here.
        seed_pool(&cfg, &mut state)?;
        STATE.save(deps.storage, &state)?;
        return exec_pool_buy(deps, info, cfg, state, buyer, min_tokens_out);
    }

    /*
     * Before anything is quoted or any funds are counted.
     *
     * A start-time check placed after the quote would still refuse the trade, and it
     * would do so having already done work, with an error that arrives after the UI has
     * shown the buyer a price. Refusing first means the panel can say "not open yet"
     * rather than quoting something nobody can take.
     */
    if !cfg.rules.buying_open_at(env.block.time) {
        return Err(ContractError::NotOpenYet {
            start: cfg.rules.trade_start.expect("a closed launch has a start time"),
            now: env.block.time,
        });
    }

    let inj_in = cw_utils::must_pay(&info, &cfg.quote_denom)?;

    /*
     * The opening premium is taken off the top, not folded into the curve's fee.
     *
     * Folding it in was the first attempt: set `curve.fee_bps` to the decayed figure
     * and quote with that. The maths crate refuses it, correctly, because its own
     * `MAX_FEE_BPS` is 1000 and an opening fee is meant to exceed that. Mutating a
     * validated config to get past its validation is the wrong shape of fix anyway.
     *
     * `SimulateBuy` goes through the same function, so the figure a caller sizes
     * against is the figure this handler will honour.
     */
    let (q, premium, carried_refund) =
        quote_buy_with_premium(&cfg, &state, inj_in, env.block.time)?;

    if q.tokens_out < min_tokens_out {
        return Err(ContractError::Slippage {
            got: q.tokens_out,
            min: min_tokens_out,
        });
    }

    /*
     * The premium is carved off BEFORE the split, so the creator and the platform are
     * paid exactly what the curve's own fee would have produced and not a unit more.
     * Splitting the whole fee instead would pay the creator for every sniper, giving
     * them a reason to want the thing the rule exists to discourage.
     *
     * Computed as the base fee on the same input rather than by scaling `q.fee`, since
     * the fee is linear in bps and the direct form has one rounding step instead of
     * two. Saturating, so a rounding difference can only ever shrink the premium.
     */
    /*
     * `q.fee` is the curve's own fee on what reached the curve, and it splits to
     * creator and platform exactly as it always did. The premium never enters this
     * sum: a creator who earns more when snipers win has a reason to want snipers,
     * which is the opposite of what the rule is for.
     *
     * Note the second-order effect, measured rather than assumed: because the premium
     * comes off the top, the curve's fee applies to what is left, so during an opening
     * window the creator earns slightly LESS than they would without the rule (1% of
     * 10%, at the fixture's numbers). That is the right direction and it is asserted
     * as an inequality rather than left as a surprise.
     */
    let (creator_cut, platform_cut) = split_fee(q.fee, cfg.creator_fee_share_bps);

    /*
     * The cap is checked against what the quote would actually deliver, not against
     * what was paid.
     *
     * Those differ: the curve refunds whatever the buy cannot absorb, so an order sized
     * in quote is not an order sized in tokens. Checking the payment would cap the wrong
     * quantity and would get it wrong by more the steeper the curve is, which is exactly
     * where the rule is supposed to bite.
     */
    if let Some(cap) = cfg.rules.max_per_wallet {
        /*
         * Charged to the recipient, because they are the address that ends up holding.
         * Keyed on the payer instead, a cap could be walked around by paying from a
         * fresh address every time and directing every purchase to one wallet, which
         * is the exact thing the rule exists to stop.
         */
        let held = PURCHASED.may_load(deps.storage, &buyer)?.unwrap_or_default();
        let after = held.checked_add(q.tokens_out)?;
        if cfg.rules.would_exceed_cap(held, q.tokens_out) {
            return Err(ContractError::WalletCapExceeded {
                cap,
                held,
                adding: q.tokens_out,
            });
        }
        PURCHASED.save(deps.storage, &buyer, &after)?;
    }

    // Effects before interactions: state is written before any funds move.
    state.inj_collected = state.inj_collected.checked_add(q.inj_in_after_fee)?;
    state.tokens_sold = state.tokens_sold.checked_add(q.tokens_out)?;
    apply_route(&mut state, cfg.reward_route, creator_cut)?;
    state.platform_owed = state.platform_owed.checked_add(platform_cut)?;
    state.lp_bonus = state.lp_bonus.checked_add(premium)?;
    let total_refund = q.refund.checked_add(carried_refund)?;
    // Graduation is atomic with the buy that reaches the target. There is no window
    // in which the curve is closed and the pool not yet open, and no second
    // transaction anyone has to remember to send.
    let mut seeded = None;
    if q.graduates {
        state.graduated = true;
        seeded = Some(seed_pool(&cfg, &mut state)?);
    }
    STATE.save(deps.storage, &state)?;

    let mut res = Response::new()
        .add_message(BankMsg::Send {
            to_address: buyer.to_string(),
            amount: coins(q.tokens_out.u128(), &cfg.denom),
        })
        .add_attribute("action", "buy")
        .add_attribute("buyer", buyer.as_str())
        // Was a second "buyer" attribute: two values under one key, so an indexer
        // reading the first saw the recipient and one reading the last saw the payer.
        .add_attribute("sender", info.sender.as_str())
        .add_attribute("inj_in", inj_in)
        .add_attribute("tokens_out", q.tokens_out)
        .add_attribute("fee", q.fee)
        .add_attribute("refund", total_refund)
        .add_attribute("early_fee_premium", premium)
        .add_attribute("graduated", q.graduates.to_string());
    if let Some((quote, tokens)) = seeded {
        res = res
            .add_attribute("pool_quote", quote)
            .add_attribute("pool_tokens", tokens);
    }

    // Partial fill: hand back whatever the curve could not absorb, including the part
    // the first quote already found unabsorbable. Reporting only `q.refund` would
    // leave the carried amount owed and unsent, which is a solvency hole rather than
    // a display bug.
    if !total_refund.is_zero() {
        res = res.add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: coins(total_refund.u128(), &cfg.quote_denom),
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
    if state.graduated && !state.migrated {
        seed_pool(&cfg, &mut state)?;
        STATE.save(deps.storage, &state)?;
    }
    if state.migrated {
        return exec_pool_sell(deps, info, cfg, state, min_inj_out);
    }

    let tokens_in = cw_utils::must_pay(&info, &cfg.denom)?;
    /*
     * THE SELL FEE, not the buy fee. The maths crate takes one `fee_bps`, so the sell
     * side swaps its own figure in rather than the crate growing a second field: the
     * curve arithmetic is identical either way and only the skim differs.
     */
    let mut sell_cfg = cfg.curve.clone();
    sell_cfg.fee_bps = cfg.curve.fee_sell_bps;
    let curve: CurveConfig = (&sell_cfg).into();
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
    /*
     * Selling frees allowance, and that choice is the whole semantics of the cap.
     *
     * Counted as buys minus sells, the cap limits what one address holds through the
     * curve AT ONCE, which is the quantity that competes with other buyers for the
     * opening price. Not decrementing would instead make it a lifetime quota, so anyone
     * who sold a single token could never buy back in, and a rule that punishes exiting
     * is a rule that traps people.
     *
     * Saturating rather than checked, deliberately: a seller can hold tokens this curve
     * never sold them, bought from someone else or received as a transfer, so selling
     * more than the recorded figure is ordinary and must not abort the trade. The floor
     * is zero.
     */
    if cfg.rules.max_per_wallet.is_some() {
        let held = PURCHASED
            .may_load(deps.storage, &info.sender)?
            .unwrap_or_default();
        PURCHASED.save(deps.storage, &info.sender, &held.saturating_sub(tokens_in))?;
    }

    state.tokens_sold = state.tokens_sold.checked_sub(tokens_in)?;
    apply_route(&mut state, cfg.reward_route, creator_cut)?;
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

/// Move the curve's reserve and every token it still holds into the locked pool.
///
/// Returns what was seeded, for the event. The quote side is the curve's reserve plus
/// the opening-fee premium; the token side is the held-back LP allocation plus
/// whatever the curve never sold. Fees owed are NOT part of it: they stay claimable.
///
/// Price continuity, measured on the fixed curve: the curve's last spot price is
/// about 4.11e-7 INJ per token and the pool opens at about 4.11e-7, because the
/// 1.073B virtual / 200M reserve split was chosen so the two meet.
fn seed_pool(cfg: &Config, state: &mut State) -> Result<(Uint128, Uint128), ContractError> {
    if state.migrated {
        return Err(ContractError::Graduated);
    }
    if !state.graduated && state.inj_collected < cfg.curve.graduation_target {
        return Err(ContractError::NotReady);
    }
    let quote = state.inj_collected.checked_add(state.lp_bonus)?;
    let unsold = cfg
        .curve
        .curve_supply
        .checked_sub(state.tokens_sold)
        .unwrap_or(Uint128::zero());
    let tokens = cfg.lp_reserve.checked_add(unsold)?;

    state.graduated = true;
    state.migrated = true;
    state.inj_collected = Uint128::zero();
    state.lp_bonus = Uint128::zero();
    state.tokens_sold = cfg.curve.curve_supply;
    state.pool_quote = quote;
    state.pool_tokens = tokens;
    Ok((quote, tokens))
}

fn exec_graduate(deps: DepsMut, _env: Env) -> Result<Response, ContractError> {
    let cfg = CONFIG.load(deps.storage)?;
    let mut state = STATE.load(deps.storage)?;
    // Captured first: `seed_pool` zeroes it, and an attribute that always reads zero
    // is indistinguishable from a feature that never ran.
    let premium = state.lp_bonus;
    let (quote, tokens) = seed_pool(&cfg, &mut state)?;
    STATE.save(deps.storage, &state)?;
    Ok(Response::new()
        .add_attribute("action", "graduate")
        .add_attribute("pool_quote", quote)
        .add_attribute("early_fee_premium", premium)
        .add_attribute("pool_tokens", tokens))
}

/// A buy against the locked pool. No wallet cap, start time or opening premium:
/// those are launch-window rules and, as on Pons, they expire with the curve.
fn exec_pool_buy(
    deps: DepsMut,
    info: MessageInfo,
    cfg: Config,
    mut state: State,
    buyer: cosmwasm_std::Addr,
    min_tokens_out: Uint128,
) -> Result<Response, ContractError> {
    let quote_in = cw_utils::must_pay(&info, &cfg.quote_denom)?;
    let q = pool_quote_buy(&state.pool(), cfg.curve.fee_bps, quote_in)?;
    if q.tokens_out < min_tokens_out {
        return Err(ContractError::Slippage { got: q.tokens_out, min: min_tokens_out });
    }
    let (creator_cut, platform_cut) = split_fee(q.fee, cfg.creator_fee_share_bps);
    state.pool_quote = state.pool_quote.checked_add(q.quote_in_after_fee)?;
    state.pool_tokens = state.pool_tokens.checked_sub(q.tokens_out)?;
    apply_route(&mut state, cfg.reward_route, creator_cut)?;
    state.platform_owed = state.platform_owed.checked_add(platform_cut)?;
    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: buyer.to_string(),
            amount: coins(q.tokens_out.u128(), &cfg.denom),
        })
        .add_attribute("action", "buy")
        .add_attribute("venue", "pool")
        .add_attribute("buyer", buyer.as_str())
        .add_attribute("sender", info.sender.as_str())
        .add_attribute("inj_in", quote_in)
        .add_attribute("tokens_out", q.tokens_out)
        .add_attribute("fee", q.fee)
        .add_attribute("refund", Uint128::zero())
        .add_attribute("graduated", "false"))
}

fn exec_pool_sell(
    deps: DepsMut,
    info: MessageInfo,
    cfg: Config,
    mut state: State,
    min_inj_out: Uint128,
) -> Result<Response, ContractError> {
    let tokens_in = cw_utils::must_pay(&info, &cfg.denom)?;
    let q = pool_quote_sell(&state.pool(), cfg.curve.fee_bps, tokens_in)?;
    if q.inj_out < min_inj_out {
        return Err(ContractError::Slippage { got: q.inj_out, min: min_inj_out });
    }
    let gross = q.inj_out.checked_add(q.fee)?;
    let (creator_cut, platform_cut) = split_fee(q.fee, cfg.creator_fee_share_bps);
    state.pool_quote = state.pool_quote.checked_sub(gross)?;
    state.pool_tokens = state.pool_tokens.checked_add(tokens_in)?;
    apply_route(&mut state, cfg.reward_route, creator_cut)?;
    state.platform_owed = state.platform_owed.checked_add(platform_cut)?;
    STATE.save(deps.storage, &state)?;

    Ok(Response::new()
        .add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: coins(q.inj_out.u128(), &cfg.quote_denom),
        })
        .add_attribute("action", "sell")
        .add_attribute("venue", "pool")
        .add_attribute("seller", info.sender.as_str())
        .add_attribute("tokens_in", tokens_in)
        .add_attribute("inj_out", q.inj_out)
        .add_attribute("fee", q.fee))
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
    // Counted as it is paid, not as it is earned: this is the figure a board adds up
    // to say what creators have actually been handed.
    state.creator_paid = state.creator_paid.checked_add(creator)?;
    state.platform_paid = state.platform_paid.checked_add(platform)?;
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
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::State {} => to_json_binary(&STATE.load(deps.storage)?),
        QueryMsg::SimulateBuy { inj_in } => {
            let cfg = CONFIG.load(deps.storage)?;
            let state = STATE.load(deps.storage)?;
            if state.migrated {
                let q = pool_quote_buy(&state.pool(), cfg.curve.fee_bps, inj_in)
                    .map_err(|e| cosmwasm_std::StdError::generic_err(e.to_string()))?;
                return to_json_binary(&SimulateBuyResponse {
                    tokens_out: q.tokens_out,
                    fee: q.fee,
                    refund: Uint128::zero(),
                    // The pool charges the base fee only: launch-window rules expire
                    // with the curve.
                    early_fee_premium: Uint128::zero(),
                    graduates: false,
                });
            }
            /*
             * THROUGH THE SAME FUNCTION THE HANDLER USES, including the block time it
             * needs to know the premium. This quoted the base curve and ignored the
             * opening fee entirely, so for the whole window it promised tokens
             * `exec_buy` would refuse to deliver.
             */
            let (q, premium, carried) =
                quote_buy_with_premium(&cfg, &state, inj_in, env.block.time)
                    .map_err(|e| cosmwasm_std::StdError::generic_err(e.to_string()))?;
            to_json_binary(&SimulateBuyResponse {
                tokens_out: q.tokens_out,
                fee: q.fee,
                // Both parts, as the handler sends them: a simulation reporting only
                // the second quote's refund leaves the payment unaccounted for.
                refund: q.refund.checked_add(carried)?,
                early_fee_premium: premium,
                graduates: q.graduates,
            })
        }
        QueryMsg::SimulateSell { tokens_in } => {
            let cfg = CONFIG.load(deps.storage)?;
            let state = STATE.load(deps.storage)?;
            if state.migrated {
                let q = pool_quote_sell(&state.pool(), cfg.curve.fee_bps, tokens_in)
                    .map_err(|e| cosmwasm_std::StdError::generic_err(e.to_string()))?;
                return to_json_binary(&SimulateSellResponse { inj_out: q.inj_out, fee: q.fee });
            }
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
            if state.migrated {
                let price = pool_spot_price(&state.pool(), one_token)
                    .map_err(|e| cosmwasm_std::StdError::generic_err(e.to_string()))?;
                return to_json_binary(&SpotPriceResponse { price });
            }
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
            fee_sell_bps: 100,
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
            // An open launch: no cap, no start time. The default path,
            // and the one every existing test was written against.
            rules: Default::default(),
            denom: TOKEN.to_string(),
            quote_denom: QUOTE.to_string(),
            creator: who.to_string(),
            platform: who.to_string(),
            lp_reserve: Uint128::new(LP_RESERVE),
            creator_fee_share_bps: 2_000,
            curve: curve_cfg(),
            reward_route: Default::default(),
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
            // An open launch: no cap, no start time. The default path,
            // and the one every existing test was written against.
            rules: Default::default(),
            denom: QUOTE.to_string(),
            quote_denom: QUOTE.to_string(),
            creator: who.to_string(),
            platform: who.to_string(),
            lp_reserve: Uint128::zero(),
            creator_fee_share_bps: 0,
            curve: curve_cfg(),
            reward_route: Default::default(),
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
            ExecuteMsg::Buy { min_tokens_out: Uint128::zero(), recipient: None },
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
            ExecuteMsg::Buy { min_tokens_out: Uint128::zero(), recipient: None },
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
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Buy { min_tokens_out: Uint128::zero(), recipient: None })
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
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Buy { min_tokens_out: Uint128::zero(), recipient: None })
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
        execute(deps.as_mut(), mock_env(), info, ExecuteMsg::Buy { min_tokens_out: Uint128::zero(), recipient: None })
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
