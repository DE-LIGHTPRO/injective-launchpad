//! The pool a launch becomes once its curve graduates.
//!
//! WHY THIS EXISTS. Graduation used to `BankMsg::Send` the whole reserve and every
//! leftover token to a single `migration_target` address. That is custody, not
//! migration: whoever held that key held every graduated launch's liquidity, and a
//! buyer had no way to tell a pool from a wallet. Both launchpads this project is
//! measured against lock graduated liquidity where no one can withdraw it:
//!
//!   ponsdotdev/pons-labs: the full-range V4 position is held by
//!   `PonsV2LaunchLocker`, "permanently locked" with "no withdrawal path".
//!   nearly.trade: graduates into a Rhea pool, the fee on which is split 70/30.
//!
//! Injective has no Uniswap-style AMM whose testnet address this repository can
//! verify, and this codebase does not infer contract addresses. So the curve
//! contract becomes the pool itself: a plain `x * y = k` market over REAL reserves
//! (no virtual liquidity), with no withdraw message at all. The liquidity is locked
//! because there is no code path that moves it anywhere but to a trader in exchange
//! for the other side.
//!
//! Same rounding rule as the curve: every division resolves in favour of the pool,
//! so `quote * tokens` never decreases across a trade.
//!
//! Fees are taken on the QUOTE leg only, in and out, as Pons does: "fees are charged
//! on the quote leg, never in the memecoin", which keeps creator and platform revenue
//! out of illiquid memecoin dust.

use cosmwasm_std::{Uint128, Uint256};

use crate::{ceil_div, fee_on, to_u128, CurveError, BPS_DENOM, MAX_FEE_BPS};

/// Real reserves of a graduated launch.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PoolReserves {
    pub quote: Uint128,
    pub tokens: Uint128,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PoolBuyQuote {
    /// Fee skimmed off the quote paid in. Not added to the reserve.
    pub fee: Uint128,
    /// Quote that actually enters the reserve.
    pub quote_in_after_fee: Uint128,
    pub tokens_out: Uint128,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PoolSellQuote {
    /// Fee skimmed off the quote leaving the reserve.
    pub fee: Uint128,
    /// Quote the seller receives, after fee. The reserve gives up `inj_out + fee`.
    pub inj_out: Uint128,
}

impl PoolReserves {
    fn check(&self, fee_bps: u16) -> Result<(), CurveError> {
        if self.quote.is_zero() || self.tokens.is_zero() {
            return Err(CurveError::ZeroVirtualReserve);
        }
        if fee_bps > MAX_FEE_BPS {
            return Err(CurveError::FeeTooHigh { got: fee_bps, max: MAX_FEE_BPS });
        }
        Ok(())
    }

    fn k(&self) -> Uint256 {
        Uint256::from(self.quote) * Uint256::from(self.tokens)
    }
}

/// Quote a buy of `quote_in` against the pool.
pub fn pool_quote_buy(
    pool: &PoolReserves,
    fee_bps: u16,
    quote_in: Uint128,
) -> Result<PoolBuyQuote, CurveError> {
    pool.check(fee_bps)?;
    if quote_in.is_zero() {
        return Err(CurveError::ZeroAmount);
    }
    let fee = fee_on(quote_in, fee_bps)?;
    let net = quote_in.checked_sub(fee).map_err(|_| CurveError::Overflow)?;
    if net.is_zero() {
        return Err(CurveError::ZeroAmount);
    }
    let new_quote = Uint256::from(pool.quote)
        .checked_add(Uint256::from(net))
        .map_err(|_| CurveError::Overflow)?;
    // Remaining token reserve rounded UP, so tokens_out comes out smaller. Never
    // below one, because `k > 0` and the ceiling of a positive ratio is positive:
    // the pool cannot be emptied of its token side by any buy.
    let new_tokens = ceil_div(pool.k(), new_quote)?;
    let out = Uint256::from(pool.tokens)
        .checked_sub(new_tokens)
        .unwrap_or(Uint256::zero());
    let tokens_out = to_u128(out)?;
    if tokens_out.is_zero() {
        return Err(CurveError::ZeroAmount);
    }
    Ok(PoolBuyQuote { fee, quote_in_after_fee: net, tokens_out })
}

/// Quote a sell of `tokens_in` into the pool.
pub fn pool_quote_sell(
    pool: &PoolReserves,
    fee_bps: u16,
    tokens_in: Uint128,
) -> Result<PoolSellQuote, CurveError> {
    pool.check(fee_bps)?;
    if tokens_in.is_zero() {
        return Err(CurveError::ZeroAmount);
    }
    let new_tokens = Uint256::from(pool.tokens)
        .checked_add(Uint256::from(tokens_in))
        .map_err(|_| CurveError::Overflow)?;
    // Remaining quote reserve rounded UP, so the payout comes out smaller.
    let new_quote = ceil_div(pool.k(), new_tokens)?;
    let gross = to_u128(
        Uint256::from(pool.quote)
            .checked_sub(new_quote)
            .unwrap_or(Uint256::zero()),
    )?;
    if gross.is_zero() {
        return Err(CurveError::ZeroAmount);
    }
    let fee = fee_on(gross, fee_bps)?;
    let inj_out = gross.checked_sub(fee).map_err(|_| CurveError::Overflow)?;
    if inj_out.is_zero() {
        return Err(CurveError::ZeroAmount);
    }
    Ok(PoolSellQuote { fee, inj_out })
}

/// Spot price of one whole token (`one_token` base units) in quote base units.
pub fn pool_spot_price(pool: &PoolReserves, one_token: Uint128) -> Result<Uint128, CurveError> {
    if pool.tokens.is_zero() {
        return Err(CurveError::ZeroVirtualReserve);
    }
    let p = Uint256::from(pool.quote)
        .checked_mul(Uint256::from(one_token))
        .map_err(|_| CurveError::Overflow)?
        / Uint256::from(pool.tokens);
    to_u128(p)
}

fn bps_u32(v: Uint256) -> u32 {
    u32::try_from(v.to_string().parse::<u128>().unwrap_or(u128::MAX)).unwrap_or(u32::MAX)
}

/// Buy impact against the spot price before the trade, fee excluded. Same definition
/// as `price_impact_bps` on the curve, so one warning threshold means one thing.
pub fn pool_buy_impact_bps(
    pool: &PoolReserves,
    fee_bps: u16,
    quote_in: Uint128,
) -> Result<u32, CurveError> {
    let q = pool_quote_buy(pool, fee_bps, quote_in)?;
    let num = Uint256::from(q.quote_in_after_fee) * Uint256::from(pool.tokens);
    let den = Uint256::from(q.tokens_out) * Uint256::from(pool.quote);
    if num <= den {
        return Ok(0);
    }
    let scaled = (num - den)
        .checked_mul(Uint256::from(BPS_DENOM as u128))
        .map_err(|_| CurveError::Overflow)?;
    Ok(bps_u32(scaled / den))
}

/// Sell shortfall below the spot price before the trade, fee excluded.
pub fn pool_sell_impact_bps(
    pool: &PoolReserves,
    fee_bps: u16,
    tokens_in: Uint128,
) -> Result<u32, CurveError> {
    let q = pool_quote_sell(pool, fee_bps, tokens_in)?;
    let gross = q.inj_out.checked_add(q.fee).map_err(|_| CurveError::Overflow)?;
    let at_spot = Uint256::from(tokens_in) * Uint256::from(pool.quote);
    let actual = Uint256::from(gross) * Uint256::from(pool.tokens);
    if actual >= at_spot {
        return Ok(0);
    }
    let scaled = (at_spot - actual)
        .checked_mul(Uint256::from(BPS_DENOM as u128))
        .map_err(|_| CurveError::Overflow)?;
    Ok(bps_u32(scaled / at_spot))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE: u128 = 1_000_000_000_000_000_000;

    fn pool() -> PoolReserves {
        // A synthetic pool, NOT the shipped curve's graduation pool, which is 1915 INJ
        // against ~206.95M tokens. The token side is close; the quote side is 22.5x
        // smaller, so a 1 INJ trade here is 1.2% of the reserve where on a real
        // graduated pool it is 0.05%. These tests are about the x*y=k arithmetic and
        // its rounding direction, which hold at any ratio, so the fixture stays - but
        // a price-impact figure read off it is not a figure about a real launch. This
        // comment claimed it was the real pool, through two rescalings of the curve.
        PoolReserves {
            quote: Uint128::new(85 * ONE),
            tokens: Uint128::new(207_000_000 * ONE),
        }
    }

    fn k(p: &PoolReserves) -> Uint256 {
        Uint256::from(p.quote) * Uint256::from(p.tokens)
    }

    #[test]
    fn a_buy_then_a_sell_of_what_it_bought_never_profits() {
        let mut p = pool();
        for n in [1u128, 7, 50, 400] {
            let spent = Uint128::new(n * ONE / 10);
            let b = pool_quote_buy(&p, 100, spent).unwrap();
            let mut after = p.clone();
            after.quote += b.quote_in_after_fee;
            after.tokens -= b.tokens_out;
            let s = pool_quote_sell(&after, 100, b.tokens_out).unwrap();
            assert!(s.inj_out < spent, "round trip of {n} paid {} for {}", s.inj_out, spent);
            // And with a zero fee too: rounding alone must not leak.
            let b0 = pool_quote_buy(&p, 0, spent).unwrap();
            let mut a0 = p.clone();
            a0.quote += b0.quote_in_after_fee;
            a0.tokens -= b0.tokens_out;
            let s0 = pool_quote_sell(&a0, 0, b0.tokens_out).unwrap();
            assert!(s0.inj_out <= spent);
            p = after;
        }
    }

    #[test]
    fn k_never_decreases_across_trades() {
        let mut p = pool();
        let before = k(&p);
        for i in 1..50u128 {
            if i % 3 == 0 {
                let t = Uint128::new(i * 1_000_003 * ONE / 7);
                if let Ok(s) = pool_quote_sell(&p, 100, t) {
                    p.tokens += t;
                    p.quote -= s.inj_out + s.fee;
                }
            } else {
                let b = pool_quote_buy(&p, 100, Uint128::new(i * ONE / 3)).unwrap();
                p.quote += b.quote_in_after_fee;
                p.tokens -= b.tokens_out;
            }
            assert!(k(&p) >= before);
        }
    }

    #[test]
    fn an_absurd_buy_cannot_empty_the_token_side() {
        let p = pool();
        let b = pool_quote_buy(&p, 100, Uint128::new(u128::MAX / 2)).unwrap();
        assert!(b.tokens_out < p.tokens);
    }

    #[test]
    fn dust_is_refused_rather_than_filled_for_nothing() {
        let p = pool();
        assert_eq!(pool_quote_buy(&p, 100, Uint128::new(1)), Err(CurveError::ZeroAmount));
        assert_eq!(pool_quote_sell(&p, 100, Uint128::zero()), Err(CurveError::ZeroAmount));
    }

    #[test]
    fn an_empty_pool_refuses_rather_than_dividing_by_zero() {
        let p = PoolReserves::default();
        assert!(pool_quote_buy(&p, 100, Uint128::new(ONE)).is_err());
        assert!(pool_quote_sell(&p, 100, Uint128::new(ONE)).is_err());
    }

    #[test]
    fn impact_rises_with_size_and_excludes_the_fee() {
        let p = pool();
        let small = pool_buy_impact_bps(&p, 100, Uint128::new(ONE / 100)).unwrap();
        let big = pool_buy_impact_bps(&p, 100, Uint128::new(20 * ONE)).unwrap();
        assert!(small < big);
        // 20 INJ net of fee into 85: (85+19.8)/85 - 1 = 23.3%.
        assert!((2_300..2_340).contains(&big), "impact {big}");
        let s = pool_sell_impact_bps(&p, 100, Uint128::new(50_000_000 * ONE)).unwrap();
        assert!((1_900..2_000).contains(&s), "sell impact {s}");
    }
}
