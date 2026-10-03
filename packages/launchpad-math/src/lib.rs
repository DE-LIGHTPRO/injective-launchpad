//! Bonding curve maths for the launchpad.
//!
//! Constant-product curve over *virtual* reserves. The pool is seeded with
//! virtual INJ and virtual token reserves so that the very first buy has a
//! sane price without anyone having to deposit INJ. That is what makes the
//! launch one-sided: the creator supplies only tokens.
//!
//!   k                = virtual_inj_start * virtual_token_start
//!   inj_reserve      = virtual_inj_start + inj_collected
//!   token_reserve    = virtual_token_start - tokens_sold
//!
//! Every quote keeps `inj_reserve * token_reserve >= k`. Rounding is always
//! resolved in favour of the pool, never the trader, so repeated trades can
//! never mine value out of the curve.
//!
//! All intermediate arithmetic is done in `Uint256`: with 18-decimal INJ and a
//! billion-token supply, `k` is around 3e46, which overflows `u128` (max ~3.4e38).

use cosmwasm_std::{Uint128, Uint256};
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum CurveError {
    #[error("curve is not configured with non-zero virtual reserves")]
    ZeroVirtualReserve,

    #[error("amount must be greater than zero")]
    ZeroAmount,

    #[error("curve has graduated; trading has moved to the spot market")]
    Graduated,

    #[error("only {available} tokens remain on the curve, {requested} requested")]
    InsufficientCurveSupply {
        requested: Uint128,
        available: Uint128,
    },

    #[error("cannot sell {requested}, only {sold} tokens have been sold")]
    InsufficientSold { requested: Uint128, sold: Uint128 },

    #[error("arithmetic overflow in curve maths")]
    Overflow,

    #[error("fee must be under 100% (max {max} bps), got {got} bps")]
    FeeTooHigh { got: u16, max: u16 },

    #[error("graduation target {target} can never be reached; the curve runs out of tokens at {reachable}")]
    UnreachableGraduation { target: Uint128, reachable: Uint128 },
}

/// Fee denominated in basis points. 100 bps = 1%.
pub const BPS_DENOM: u16 = 10_000;
/// Refuse to configure a fee above 10%. A launchpad taking more than this is
/// a rug with extra steps.
pub const MAX_FEE_BPS: u16 = 1_000;

/// Immutable parameters chosen when a launch is created.
#[derive(Clone, Debug, PartialEq)]
pub struct CurveConfig {
    /// Virtual INJ reserve the curve starts with. Sets the opening price.
    pub virtual_inj: Uint128,
    /// Virtual token reserve the curve starts with.
    pub virtual_tokens: Uint128,
    /// How many real tokens are actually available to be sold on the curve.
    /// Must be <= virtual_tokens, and is normally a little under it so the
    /// curve graduates before the maths approaches the asymptote.
    pub curve_supply: Uint128,
    /// INJ collected at which the curve closes and liquidity migrates.
    pub graduation_target: Uint128,
    /// Trading fee in bps, taken from the input amount.
    pub fee_bps: u16,
}

impl CurveConfig {
    pub fn validate(&self) -> Result<(), CurveError> {
        if self.virtual_inj.is_zero() || self.virtual_tokens.is_zero() {
            return Err(CurveError::ZeroVirtualReserve);
        }
        if self.fee_bps > MAX_FEE_BPS {
            return Err(CurveError::FeeTooHigh {
                got: self.fee_bps,
                max: MAX_FEE_BPS,
            });
        }
        // Strictly less: at curve_supply == virtual_tokens the reserve hits
        // zero and the curve divides by zero at the asymptote.
        if self.curve_supply >= self.virtual_tokens {
            return Err(CurveError::InsufficientCurveSupply {
                requested: self.curve_supply,
                available: self.virtual_tokens,
            });
        }
        if self.graduation_target.is_zero() {
            return Err(CurveError::ZeroAmount);
        }
        // The graduation target must actually be reachable before the curve
        // runs out of tokens to sell, or the launch can never finish.
        let reachable = self.max_collectable()?;
        if self.graduation_target > reachable {
            return Err(CurveError::UnreachableGraduation {
                target: self.graduation_target,
                reachable,
            });
        }
        Ok(())
    }

    /// Total INJ the curve can take in before its sellable supply is gone.
    pub fn max_collectable(&self) -> Result<Uint128, CurveError> {
        let tok_left = Uint256::from(self.virtual_tokens)
            .checked_sub(Uint256::from(self.curve_supply))
            .map_err(|_| CurveError::Overflow)?;
        if tok_left.is_zero() {
            return Err(CurveError::Overflow);
        }
        let inj_total = ceil_div(self.k(), tok_left)?;
        let collected = inj_total
            .checked_sub(Uint256::from(self.virtual_inj))
            .unwrap_or(Uint256::zero());
        to_u128(collected)
    }

    /// k = virtual_inj * virtual_tokens, in 256-bit space.
    fn k(&self) -> Uint256 {
        Uint256::from(self.virtual_inj) * Uint256::from(self.virtual_tokens)
    }
}

/// Mutable position of a single launch along its curve.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CurveState {
    /// Real INJ taken in from buyers, net of fees.
    pub inj_collected: Uint128,
    /// Real tokens handed out to buyers.
    pub tokens_sold: Uint128,
    /// Set once the graduation target is hit; trading stops.
    pub graduated: bool,
}

/// What a buy would do, before it is executed.
#[derive(Clone, Debug, PartialEq)]
pub struct BuyQuote {
    /// Fee skimmed from the INJ actually spent.
    pub fee: Uint128,
    /// INJ that actually moves along the curve.
    pub inj_in_after_fee: Uint128,
    /// Tokens the buyer receives.
    pub tokens_out: Uint128,
    /// INJ handed straight back. Non-zero only on the buy that empties the
    /// curve: it is filled up to the remaining supply and the rest returned,
    /// rather than rejected. Without this the curve can stall one buy short
    /// of graduating, with no way for anyone to finish it.
    pub refund: Uint128,
    /// True if this buy takes the curve to its graduation target.
    pub graduates: bool,
}

/// What a sell would do, before it is executed.
#[derive(Clone, Debug, PartialEq)]
pub struct SellQuote {
    /// Fee skimmed from the INJ owed to the seller.
    pub fee: Uint128,
    /// INJ the seller receives, after fee.
    pub inj_out: Uint128,
}

/// Ceiling division in 256-bit space. Used wherever rounding must favour the
/// pool: a larger remaining reserve means a smaller payout to the trader.
fn ceil_div(num: Uint256, den: Uint256) -> Result<Uint256, CurveError> {
    if den.is_zero() {
        return Err(CurveError::Overflow);
    }
    let q = num / den;
    if q * den == num {
        Ok(q)
    } else {
        q.checked_add(Uint256::one()).map_err(|_| CurveError::Overflow)
    }
}

fn to_u128(v: Uint256) -> Result<Uint128, CurveError> {
    Uint128::try_from(v).map_err(|_| CurveError::Overflow)
}

/// Fee taken off an input amount, rounded up so the pool is never short.
fn fee_on(amount: Uint128, bps: u16) -> Result<Uint128, CurveError> {
    if bps == 0 {
        return Ok(Uint128::zero());
    }
    let num = Uint256::from(amount) * Uint256::from(bps as u128);
    let fee = ceil_div(num, Uint256::from(BPS_DENOM as u128))?;
    to_u128(fee)
}

/// Inverse of `fee_on`: the gross input whose net, after fee, covers `net`.
/// Rounded up so the pool is never underpaid by a unit.
fn gross_up(net: Uint128, bps: u16) -> Result<Uint128, CurveError> {
    if bps == 0 {
        return Ok(net);
    }
    let den = BPS_DENOM
        .checked_sub(bps)
        .ok_or(CurveError::FeeTooHigh { got: bps, max: MAX_FEE_BPS })?;
    if den == 0 {
        return Err(CurveError::FeeTooHigh { got: bps, max: MAX_FEE_BPS });
    }
    let num = Uint256::from(net) * Uint256::from(BPS_DENOM as u128);
    to_u128(ceil_div(num, Uint256::from(den as u128))?)
}

/// Current reserves implied by the config and state.
fn reserves(cfg: &CurveConfig, st: &CurveState) -> Result<(Uint256, Uint256), CurveError> {
    let inj = Uint256::from(cfg.virtual_inj)
        .checked_add(Uint256::from(st.inj_collected))
        .map_err(|_| CurveError::Overflow)?;
    let tok = Uint256::from(cfg.virtual_tokens)
        .checked_sub(Uint256::from(st.tokens_sold))
        .map_err(|_| CurveError::Overflow)?;
    Ok((inj, tok))
}

/// Quote a buy of `inj_in` INJ.
pub fn quote_buy(
    cfg: &CurveConfig,
    st: &CurveState,
    inj_in: Uint128,
) -> Result<BuyQuote, CurveError> {
    cfg.validate()?;
    if st.graduated {
        return Err(CurveError::Graduated);
    }
    if inj_in.is_zero() {
        return Err(CurveError::ZeroAmount);
    }

    let remaining = cfg
        .curve_supply
        .checked_sub(st.tokens_sold)
        .map_err(|_| CurveError::Overflow)?;
    if remaining.is_zero() {
        return Err(CurveError::InsufficientCurveSupply {
            requested: Uint128::one(),
            available: Uint128::zero(),
        });
    }

    let fee_full = fee_on(inj_in, cfg.fee_bps)?;
    let net_full = inj_in.checked_sub(fee_full).map_err(|_| CurveError::Overflow)?;
    if net_full.is_zero() {
        return Err(CurveError::ZeroAmount);
    }

    let (inj_res, tok_res) = reserves(cfg, st)?;
    let new_inj = inj_res
        .checked_add(Uint256::from(net_full))
        .map_err(|_| CurveError::Overflow)?;

    // Round the remaining token reserve UP, so tokens_out comes out smaller.
    let new_tok = ceil_div(cfg.k(), new_inj)?;
    let wanted = to_u128(tok_res.checked_sub(new_tok).unwrap_or(Uint256::zero()))?;

    let (fee, net, tokens_out, refund) = if wanted <= remaining {
        (fee_full, net_full, wanted, Uint128::zero())
    } else {
        // Partial fill: take exactly the INJ needed to clear the remaining
        // supply and give the rest back.
        let tok_after = tok_res
            .checked_sub(Uint256::from(remaining))
            .map_err(|_| CurveError::Overflow)?;
        if tok_after.is_zero() {
            return Err(CurveError::Overflow);
        }
        // Round the required INJ UP, so the pool is never underpaid.
        let inj_needed_total = ceil_div(cfg.k(), tok_after)?;
        let net_used = to_u128(
            inj_needed_total
                .checked_sub(inj_res)
                .unwrap_or(Uint256::zero()),
        )?;
        if net_used.is_zero() {
            return Err(CurveError::ZeroAmount);
        }
        // Gross the net back up so the fee is charged only on what was spent.
        let gross_used = gross_up(net_used, cfg.fee_bps)?;
        let gross_used = gross_used.min(inj_in);
        let fee_used = gross_used.checked_sub(net_used).unwrap_or(Uint128::zero());
        let refund = inj_in.checked_sub(gross_used).unwrap_or(Uint128::zero());
        (fee_used, net_used, remaining, refund)
    };

    if tokens_out.is_zero() {
        return Err(CurveError::ZeroAmount);
    }

    let collected_after = st
        .inj_collected
        .checked_add(net)
        .map_err(|_| CurveError::Overflow)?;

    Ok(BuyQuote {
        fee,
        inj_in_after_fee: net,
        tokens_out,
        refund,
        graduates: collected_after >= cfg.graduation_target
            || tokens_out == remaining,
    })
}

/// Quote a sell of `tokens_in` tokens back to the curve.
pub fn quote_sell(
    cfg: &CurveConfig,
    st: &CurveState,
    tokens_in: Uint128,
) -> Result<SellQuote, CurveError> {
    cfg.validate()?;
    if st.graduated {
        return Err(CurveError::Graduated);
    }
    if tokens_in.is_zero() {
        return Err(CurveError::ZeroAmount);
    }
    if tokens_in > st.tokens_sold {
        return Err(CurveError::InsufficientSold {
            requested: tokens_in,
            sold: st.tokens_sold,
        });
    }

    let (inj_res, tok_res) = reserves(cfg, st)?;
    let new_tok = tok_res
        .checked_add(Uint256::from(tokens_in))
        .map_err(|_| CurveError::Overflow)?;

    // Round the remaining INJ reserve UP, so the payout comes out smaller.
    let new_inj = ceil_div(cfg.k(), new_tok)?;
    let gross_256 = inj_res.checked_sub(new_inj).unwrap_or(Uint256::zero());
    let gross = to_u128(gross_256)?;

    // Can never pay out more than has actually been collected.
    let gross = gross.min(st.inj_collected);
    if gross.is_zero() {
        return Err(CurveError::ZeroAmount);
    }

    let fee = fee_on(gross, cfg.fee_bps)?;
    let inj_out = gross.checked_sub(fee).map_err(|_| CurveError::Overflow)?;

    Ok(SellQuote { fee, inj_out })
}

/// Spot price of one whole token, scaled by `one_token` (10^decimals),
/// expressed in the smallest INJ unit. For display only: quoting a trade
/// must always go through `quote_buy` / `quote_sell`.
pub fn spot_price(
    cfg: &CurveConfig,
    st: &CurveState,
    one_token: Uint128,
) -> Result<Uint128, CurveError> {
    cfg.validate()?;
    let (inj_res, tok_res) = reserves(cfg, st)?;
    if tok_res.is_zero() {
        return Err(CurveError::Overflow);
    }
    let p = inj_res
        .checked_mul(Uint256::from(one_token))
        .map_err(|_| CurveError::Overflow)?
        / tok_res;
    to_u128(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 18 decimals, as INJ and most Injective tokenfactory denoms use.
    fn one() -> Uint128 {
        Uint128::new(1_000_000_000_000_000_000)
    }

    fn inj(n: u128) -> Uint128 {
        Uint128::new(n) * one()
    }

    /// Roughly pump.fun's shape, denominated in INJ.
    fn cfg() -> CurveConfig {
        CurveConfig {
            virtual_inj: inj(30),
            virtual_tokens: inj(1_073_000_000),
            curve_supply: inj(800_000_000),
            graduation_target: inj(85),
            fee_bps: 100, // 1%
        }
    }

    #[test]
    fn config_validates() {
        assert!(cfg().validate().is_ok());

        let mut bad = cfg();
        bad.virtual_inj = Uint128::zero();
        assert_eq!(bad.validate(), Err(CurveError::ZeroVirtualReserve));

        let mut bad = cfg();
        bad.fee_bps = 2_000;
        assert_eq!(
            bad.validate(),
            Err(CurveError::FeeTooHigh { got: 2_000, max: 1_000 })
        );
    }

    #[test]
    fn first_buy_returns_tokens() {
        let q = quote_buy(&cfg(), &CurveState::default(), inj(1)).unwrap();
        assert_eq!(q.fee, inj(1).multiply_ratio(1u128, 100u128));
        assert!(!q.tokens_out.is_zero());
        assert!(!q.graduates);
    }

    /// Each successive buy of the same size must get fewer tokens.
    #[test]
    fn price_rises_monotonically() {
        let c = cfg();
        let mut st = CurveState::default();
        let mut last = Uint128::MAX;

        for _ in 0..40 {
            let q = quote_buy(&c, &st, inj(1)).unwrap();
            assert!(q.tokens_out < last, "price did not rise");
            last = q.tokens_out;
            st.inj_collected += q.inj_in_after_fee;
            st.tokens_sold += q.tokens_out;
        }
    }

    /// Buy then immediately sell back must never return more INJ than went in.
    /// This is the single most important property: if it fails, the curve is
    /// a faucet.
    #[test]
    fn round_trip_never_profits() {
        let c = cfg();
        // Amounts within the curve's actual working range, up to the
        // graduation target.
        for amount in [1u128, 7, 40, 85] {
            let sent = Uint128::new(amount) * one();
            let mut st = CurveState::default();

            let b = quote_buy(&c, &st, sent).unwrap();
            st.inj_collected += b.inj_in_after_fee;
            st.tokens_sold += b.tokens_out;

            // What the buyer actually parted with.
            let spent = sent - b.refund;

            let s = quote_sell(&c, &st, b.tokens_out).unwrap();
            assert!(
                s.inj_out <= spent,
                "round trip profited: spent {spent}, got back {}",
                s.inj_out
            );
        }
    }

    /// Same, but from a curve that is already part way along.
    #[test]
    fn round_trip_never_profits_mid_curve() {
        let c = cfg();
        let mut st = CurveState::default();
        let warm = quote_buy(&c, &st, inj(20)).unwrap();
        st.inj_collected += warm.inj_in_after_fee;
        st.tokens_sold += warm.tokens_out;

        for amount in [1u128, 3, 20, 60] {
            let sent = Uint128::new(amount) * one();
            let mut probe = st.clone();

            let b = quote_buy(&c, &probe, sent).unwrap();
            probe.inj_collected += b.inj_in_after_fee;
            probe.tokens_sold += b.tokens_out;

            let spent = sent - b.refund;
            let s = quote_sell(&c, &probe, b.tokens_out).unwrap();
            assert!(s.inj_out <= spent, "mid-curve round trip profited");
        }
    }

    /// Many tiny round trips must not drain the pool either. Rounding dust
    /// has to fall on the pool's side every single time.
    #[test]
    fn dust_round_trips_do_not_drain() {
        let c = CurveConfig { fee_bps: 0, ..cfg() };
        let mut st = CurveState::default();

        let seed = quote_buy(&c, &st, inj(10)).unwrap();
        st.inj_collected += seed.inj_in_after_fee;
        st.tokens_sold += seed.tokens_out;
        let start = st.inj_collected;

        for _ in 0..500 {
            let tiny = Uint128::new(1_000);
            let b = quote_buy(&c, &st, tiny).unwrap();
            st.inj_collected += b.inj_in_after_fee;
            st.tokens_sold += b.tokens_out;

            let s = quote_sell(&c, &st, b.tokens_out).unwrap();
            st.inj_collected -= s.inj_out;
            st.tokens_sold -= b.tokens_out;
        }

        assert!(
            st.inj_collected >= start,
            "500 dust round trips drained the pool: {start} -> {}",
            st.inj_collected
        );
    }

    /// Drive the curve with real buys until its sellable supply is gone,
    /// rather than hand-constructing an off-curve state.
    fn drive_to_exhaustion(c: &CurveConfig) -> CurveState {
        let mut st = CurveState::default();
        for _ in 0..500 {
            match quote_buy(c, &st, inj(10)) {
                Ok(q) => {
                    st.inj_collected += q.inj_in_after_fee;
                    st.tokens_sold += q.tokens_out;
                    if st.tokens_sold >= c.curve_supply {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        st
    }

    #[test]
    fn cannot_buy_once_supply_is_gone() {
        let c = cfg();
        let st = drive_to_exhaustion(&c);
        assert_eq!(st.tokens_sold, c.curve_supply, "curve did not sell out");

        let err = quote_buy(&c, &st, inj(1)).unwrap_err();
        assert!(
            matches!(err, CurveError::InsufficientCurveSupply { .. }),
            "expected sold-out error, got {err:?}"
        );
    }

    /// The buy that empties the curve must fill partially and refund the
    /// rest, never reject. A rejection here strands the launch forever.
    #[test]
    fn final_buy_fills_partially_and_refunds() {
        let c = cfg();
        let mut st = CurveState::default();

        // Walk up to near the end without emptying it.
        loop {
            let q = quote_buy(&c, &st, inj(10)).unwrap();
            if q.refund.is_zero() {
                st.inj_collected += q.inj_in_after_fee;
                st.tokens_sold += q.tokens_out;
            } else {
                // This is the final, partially filled buy.
                assert_eq!(
                    q.tokens_out,
                    c.curve_supply - st.tokens_sold,
                    "partial fill did not take exactly the remaining supply"
                );
                assert!(q.refund < inj(10), "refunded more than was sent");
                assert_eq!(
                    q.fee + q.inj_in_after_fee + q.refund,
                    inj(10),
                    "fee + spent + refund must equal what was sent"
                );
                assert!(q.graduates, "emptying the curve must graduate it");
                return;
            }
        }
    }

    #[test]
    fn unreachable_graduation_target_is_rejected() {
        let bad = CurveConfig {
            graduation_target: inj(10_000), // far beyond what the supply can raise
            ..cfg()
        };
        assert!(matches!(
            bad.validate(),
            Err(CurveError::UnreachableGraduation { .. })
        ));
    }

    #[test]
    fn cannot_sell_more_than_sold() {
        let c = cfg();
        let st = CurveState {
            inj_collected: inj(5),
            tokens_sold: inj(1_000),
            ..Default::default()
        };
        let err = quote_sell(&c, &st, inj(2_000)).unwrap_err();
        assert_eq!(
            err,
            CurveError::InsufficientSold {
                requested: inj(2_000),
                sold: inj(1_000)
            }
        );
    }

    #[test]
    fn graduation_flags_at_target() {
        let c = cfg();
        let mut st = CurveState::default();
        let mut graduated = false;

        for _ in 0..200 {
            match quote_buy(&c, &st, inj(5)) {
                Ok(q) => {
                    st.inj_collected += q.inj_in_after_fee;
                    st.tokens_sold += q.tokens_out;
                    if q.graduates {
                        graduated = true;
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        assert!(graduated, "curve never reached its graduation target");
        assert!(st.inj_collected >= c.graduation_target);
    }

    #[test]
    fn trading_stops_after_graduation() {
        let c = cfg();
        let st = CurveState {
            inj_collected: inj(85),
            tokens_sold: inj(500_000_000),
            graduated: true,
        };
        assert_eq!(quote_buy(&c, &st, inj(1)), Err(CurveError::Graduated));
        assert_eq!(quote_sell(&c, &st, inj(1)), Err(CurveError::Graduated));
    }

    /// A buy far larger than the curve can absorb must be capped and
    /// conserved exactly, never wrapped. Every unit sent in has to come back
    /// as fee, spend, or refund.
    #[test]
    fn absurd_amount_is_capped_and_conserved() {
        let c = cfg();
        let st = CurveState::default();
        let q = quote_buy(&c, &st, Uint128::MAX).expect("huge buy should fill partially");

        assert_eq!(q.tokens_out, c.curve_supply, "should take the whole curve");
        assert!(q.graduates);

        let total = q
            .fee
            .checked_add(q.inj_in_after_fee)
            .and_then(|v| v.checked_add(q.refund))
            .expect("conservation sum overflowed");
        assert_eq!(total, Uint128::MAX, "value was created or destroyed");

        // And the INJ actually taken is bounded by what the curve can hold.
        assert!(q.inj_in_after_fee <= c.max_collectable().unwrap());
    }

    /// Overflow in the maths must surface as an error, never a wrapped value.
    #[test]
    fn overflowing_config_errors() {
        let c = CurveConfig {
            virtual_inj: Uint128::MAX,
            virtual_tokens: Uint128::MAX,
            curve_supply: Uint128::MAX - Uint128::one(),
            graduation_target: Uint128::one(),
            fee_bps: 100,
        };
        // k = MAX^2 overflows 256-bit reasoning about u128 conversion.
        let r = quote_buy(&c, &CurveState::default(), Uint128::new(1_000));
        assert!(r.is_err(), "expected overflow error, got {r:?}");
    }

    #[test]
    fn zero_amounts_rejected() {
        let c = cfg();
        let st = CurveState::default();
        assert_eq!(quote_buy(&c, &st, Uint128::zero()), Err(CurveError::ZeroAmount));
        assert_eq!(quote_sell(&c, &st, Uint128::zero()), Err(CurveError::ZeroAmount));
    }

    #[test]
    fn fee_rounds_up_toward_the_pool() {
        // 1 unit at 1% should round the fee up to 1, not down to 0.
        assert_eq!(fee_on(Uint128::new(1), 100).unwrap(), Uint128::new(1));
        assert_eq!(fee_on(Uint128::new(0), 100).unwrap(), Uint128::zero());
        assert_eq!(fee_on(Uint128::new(10_000), 100).unwrap(), Uint128::new(100));
    }

    #[test]
    fn spot_price_increases_along_the_curve() {
        let c = cfg();
        let early = spot_price(&c, &CurveState::default(), one()).unwrap();
        let later = spot_price(
            &c,
            &CurveState {
                inj_collected: inj(50),
                tokens_sold: inj(400_000_000),
                graduated: false,
            },
            one(),
        )
        .unwrap();
        assert!(later > early, "spot price did not rise: {early} -> {later}");
    }
}
