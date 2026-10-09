use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Timestamp, Uint128};
use cw_storage_plus::{Item, Map};
use launchpad_math::{CurveConfig, CurveState};

/// Why a launch rule was refused.
///
/// Its own type rather than the curve's `ContractError`, because the factory validates
/// the same rules before it instantiates anything and cannot convert that. Both crates
/// convert from this one, so a creator sees the identical sentence whichever contract
/// refused them: the same rule rejected with two different wordings is the sort of thing
/// that makes a refusal look like a bug.
#[derive(thiserror::Error, Debug, PartialEq)]
pub enum RuleError {
    #[error("launch rule is invalid: {reason}")]
    Invalid { reason: String },
}

/// Everything fixed at launch time. None of it can be changed afterwards,
/// which is the point: a launch whose parameters can be edited mid-flight is
/// not a fair launch.
#[cw_serde]
pub struct Config {
    /// The launched token's native denom (an Injective tokenfactory denom).
    pub denom: String,
    /// What buyers pay with. Normally "inj".
    pub quote_denom: String,
    /// Who created the launch. Receives their share of fees.
    pub creator: Addr,
    /// Platform fee recipient.
    pub platform: Addr,
    /// Where the INJ and the LP tokens go once the curve graduates.
    pub migration_target: Addr,
    /// Tokens held back from the curve entirely, reserved to pair against the
    /// collected INJ at migration. Without this the curve can sell out and
    /// graduate with INJ but no token side for the pool.
    pub lp_reserve: Uint128,
    /// Share of the trading fee that goes to the creator, in bps of the fee
    /// itself. The remainder goes to the platform.
    pub creator_fee_share_bps: u16,
    /// Curve shape, supply and graduation target.
    pub curve: CurveConfigStored,
    /// Trading rules, enforced on this curve and only until graduation.
    #[serde(default)]
    pub rules: LaunchRules,
}

/// `launchpad_math::CurveConfig` is not serde-serialisable by itself, so it is
/// mirrored here and converted on the way in and out.
#[cw_serde]
pub struct CurveConfigStored {
    pub virtual_inj: Uint128,
    pub virtual_tokens: Uint128,
    pub curve_supply: Uint128,
    pub graduation_target: Uint128,
    pub fee_bps: u16,
}

impl From<&CurveConfigStored> for CurveConfig {
    fn from(c: &CurveConfigStored) -> Self {
        CurveConfig {
            virtual_inj: c.virtual_inj,
            virtual_tokens: c.virtual_tokens,
            curve_supply: c.curve_supply,
            graduation_target: c.graduation_target,
            fee_bps: c.fee_bps,
        }
    }
}

/// Where the launch currently sits on its curve, plus fees owed.
#[cw_serde]
#[derive(Default)]
pub struct State {
    /// INJ held as curve reserve. Sells are paid out of this, never out of fees.
    pub inj_collected: Uint128,
    /// Tokens handed to buyers so far.
    pub tokens_sold: Uint128,
    /// Trading has closed. Set by the buy that reaches the target.
    pub graduated: bool,
    /// Liquidity has actually been moved out. Separate from `graduated` so
    /// migration can never run twice.
    pub migrated: bool,
    /// Fees accrued but not yet withdrawn. Kept separate from the reserve so
    /// a fee claim can never eat the INJ that backs outstanding tokens.
    pub platform_owed: Uint128,
    pub creator_owed: Uint128,
}

impl State {
    pub fn curve_state(&self) -> CurveState {
        CurveState {
            inj_collected: self.inj_collected,
            tokens_sold: self.tokens_sold,
            graduated: self.graduated,
        }
    }
}

/// Rules the curve enforces on trading, set once at launch.
///
/// WHAT THESE ARE AND ARE NOT. Every buy and sell before graduation goes through this
/// contract, so a rule here binds every trade for the whole fair-launch window, which is
/// when launch rules are worth anything. At graduation liquidity moves to a DEX and
/// these stop applying completely. That is a property of the chain, not a choice:
/// Injective tokenfactory denoms are bank denoms and a bank send executes no contract
/// code, so there is no way to attach a rule to a transfer the way a Solana transfer
/// hook does. The UI must say "on the curve", never "on the token".
#[cw_serde]
#[derive(Default)]
pub struct LaunchRules {
    /// Most a single address may hold THROUGH THIS CURVE, in token base units.
    ///
    /// Counted as buys minus sells, not as a balance. The contract cannot see transfers,
    /// so a true balance cap is not enforceable here: someone could buy to the cap, send
    /// the tokens elsewhere and buy again, and nothing on chain would tell us. What this
    /// does cap is concurrent exposure acquired from the curve, which is the part that
    /// actually competes with other buyers for the early price.
    ///
    /// It does not stop a determined sniper, and claiming otherwise would be the lie.
    /// One person with twenty addresses gets twenty times the cap, and no on-chain rule
    /// fixes that. It raises the cost and the effort of taking the opening cheaply.
    pub max_per_wallet: Option<Uint128>,

    /// No buys before this time. `None` means open the moment the launch is created.
    ///
    /// The point is to make the opening a known moment rather than a race to see whose
    /// transaction lands in the block the launch was created in. Sells are never gated:
    /// nobody can hold tokens before the first buy, so there is nothing to gate, and a
    /// rule that could trap someone's funds is not one worth having.
    pub trade_start: Option<Timestamp>,
}

impl LaunchRules {
    pub fn validate(&self, curve_supply: Uint128) -> Result<(), RuleError> {
        if let Some(cap) = self.max_per_wallet {
            if cap.is_zero() {
                // A zero cap means nobody may buy anything, which is not a launch.
                return Err(RuleError::Invalid {
                    reason: "max per wallet is zero, so no one could buy".into(),
                });
            }
            if cap >= curve_supply {
                /*
                 * Refused rather than stored, because a cap at or above the whole
                 * sellable supply can never bind. Stored, it would be displayed as a
                 * protection the launch does not have, which is worse than no rule at
                 * all: a buyer reads "max 1,000,000,000 per wallet" and takes it as a
                 * guarantee about distribution.
                 */
                return Err(RuleError::Invalid {
                    reason: "max per wallet is at least the whole curve supply, so it can never bind"
                        .into(),
                });
            }
        }
        Ok(())
    }

    /// Whether a buy would put this address over the cap.
    ///
    /// Extracted from the handler so the boundary itself is testable. It was inline, and
    /// mutation testing could loosen `>` to `> cap + 1` without failing anything: an
    /// integration test cannot size a buy to land exactly one base unit over the cap,
    /// because the quantity comes out of the curve rather than being chosen. The
    /// integration tests still prove this is REACHED; these prove it is right.
    ///
    /// `None` for the cap means no rule, which is not the same as a cap of zero.
    pub fn would_exceed_cap(&self, held: Uint128, adding: Uint128) -> bool {
        match self.max_per_wallet {
            // Saturating: an overflow here is "definitely over the cap", and a checked
            // add would turn an absurd order into an arithmetic error rather than a
            // refusal naming the rule.
            Some(cap) => held.saturating_add(adding) > cap,
            None => false,
        }
    }

    /// Whether buying is open yet, given the current block time.
    pub fn buying_open_at(&self, now: Timestamp) -> bool {
        match self.trade_start {
            // `>=` so a launch whose start is exactly this block is open. Blocks are the
            // only clock here and refusing the boundary would push every start one block
            // later than the creator asked for.
            Some(start) => now >= start,
            None => true,
        }
    }
}

pub const CONFIG: Item<Config> = Item::new("config");

/// Tokens each address currently holds through the curve: buys minus sells.
///
/// Only written when `max_per_wallet` is set, so a launch without the rule pays no
/// storage for it.
pub const PURCHASED: Map<&Addr, Uint128> = Map::new("purchased");
pub const STATE: Item<State> = Item::new("state");

#[cfg(test)]
mod rule_tests {
    use super::*;

    fn capped(cap: u128) -> LaunchRules {
        LaunchRules { max_per_wallet: Some(Uint128::new(cap)), trade_start: None }
    }

    #[test]
    fn the_cap_is_inclusive_at_its_exact_value() {
        /*
         * Both directions of the off-by-one, which no integration test can reach: the
         * quantity bought comes out of the curve, so a buy cannot be sized to land one
         * base unit over a cap on demand.
         *
         * A cap of 100 must permit reaching exactly 100 and refuse 101. Reading it as
         * exclusive silently tightens every launch's advertised cap by one unit; reading
         * it as `> cap + 1` loosens it in the direction the rule exists to prevent.
         */
        let r = capped(100);
        assert!(!r.would_exceed_cap(Uint128::new(0), Uint128::new(100)), "exactly the cap was refused");
        assert!(!r.would_exceed_cap(Uint128::new(99), Uint128::new(1)), "reaching the cap was refused");
        assert!(r.would_exceed_cap(Uint128::new(100), Uint128::new(1)), "one over the cap was allowed");
        assert!(r.would_exceed_cap(Uint128::new(0), Uint128::new(101)), "one over in a single buy was allowed");
    }

    #[test]
    fn no_cap_is_not_a_cap_of_zero() {
        // `None` means the launch has no rule. Treated as zero it would refuse every
        // buy, which is the failure mode that turns an open launch into a dead one.
        let open = LaunchRules::default();
        assert!(!open.would_exceed_cap(Uint128::zero(), Uint128::MAX));
    }

    #[test]
    fn an_absurd_order_is_refused_rather_than_overflowing() {
        // Saturating, so a buy that would overflow u128 reports the rule instead of an
        // arithmetic error. The user is over the cap either way; only the message differs.
        let r = capped(100);
        assert!(r.would_exceed_cap(Uint128::MAX, Uint128::MAX));
    }

    #[test]
    fn a_start_time_is_inclusive_of_its_own_second() {
        // Blocks are the only clock, so refusing the boundary pushes every launch one
        // block later than the creator asked for.
        let t = Timestamp::from_seconds(1_000);
        let r = LaunchRules { max_per_wallet: None, trade_start: Some(t) };
        assert!(!r.buying_open_at(t.minus_seconds(1)), "open before the start");
        assert!(r.buying_open_at(t), "closed at exactly the start");
        assert!(r.buying_open_at(t.plus_seconds(1)));
        // No start time means open from the first block.
        assert!(LaunchRules::default().buying_open_at(Timestamp::from_seconds(0)));
    }
}
