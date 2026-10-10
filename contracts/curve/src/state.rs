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
    /// When buying became possible: `trade_start` if one was set, else the block that
    /// created the launch. The early-fee decay is measured from here rather than from
    /// instantiate, so a launch announced in advance does not spend its whole opening
    /// premium before anyone is allowed to trade.
    #[serde(default = "epoch")]
    pub opened_at: Timestamp,
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

    /// Lifetime totals actually PAID OUT, which `*_owed` cannot answer.
    ///
    /// A claim zeroes `creator_owed`, so the only figure the chain keeps is what is
    /// currently unclaimed. "This launch has earned its creator X" is therefore
    /// unanswerable from state after the first claim, and reconstructing it means
    /// replaying every `claim_fees` event: possible for one launch, not for a board.
    ///
    /// nearly.trade puts "$146.6K PAID TO CREATORS" on its homepage, which is the
    /// number that makes a creator want to launch somewhere. It has to be measured
    /// rather than estimated, so it is counted here as it is paid.
    ///
    /// `#[serde(default)]` so a curve stored before this field existed still
    /// deserialises, reading zero rather than failing every query against it.
    #[serde(default)]
    pub platform_paid: Uint128,
    #[serde(default)]
    pub creator_paid: Uint128,

    /// The opening-fee premium, held for the pool rather than for anyone.
    ///
    /// Kept out of `inj_collected` on purpose. That figure is one side of the curve's
    /// own invariant: the price of every sell is derived from it against `tokens_sold`,
    /// so adding quote to it without issuing tokens would move the curve off its
    /// formula and quietly change what every later trade costs. This is a separate
    /// balance that rides along to the migration target at graduation and becomes
    /// liquidity for everyone who trades afterwards.
    ///
    /// Deliberately NOT paid to the creator. A creator who earns more when snipers win
    /// has a reason to want snipers, and the whole point of the rule is the opposite.
    #[serde(default)]
    pub lp_bonus: Uint128,
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

/// Ceiling on the opening fee.
///
/// Higher than the curve's own `MAX_FEE_BPS` of 1000, because the point of an opening
/// fee is to be steep enough that being first is not free, and the base cap is sized
/// for a fee every trade pays forever. Capped all the same: the premium does not reach
/// the creator, so there is no incentive to set it absurdly, but a launch advertising
/// a 90% opening fee would be a trap whoever benefits.
pub const MAX_EARLY_FEE_BPS: u16 = 2_000;

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

    /// A higher fee at the opening, decaying to the curve's own fee.
    ///
    /// Sniping the first blocks of a launch is profitable because the curve is cheapest
    /// there and a bot can be first. This does not stop that and nothing on chain can:
    /// what it does is make the cheapest tokens carry the highest fee, so the advantage
    /// of being first is paid for rather than taken.
    ///
    /// BUYS ONLY. Applying it to sells would be an exit tax, which is a different rule
    /// with different ethics: it would punish an early buyer for changing their mind
    /// rather than charging a sniper for the position.
    pub early_fee: Option<EarlyFee>,
}

/// The opening fee and how long it takes to decay to the curve's own.
///
/// One struct rather than two `Option` fields, because two options permit three
/// nonsense states (a start with no duration, a duration with no start) and the type
/// should not be able to express them.
#[cw_serde]
pub struct EarlyFee {
    /// Fee in bps at the moment the launch opens. Must exceed the curve's `fee_bps`,
    /// or there is nothing to decay and the rule is advertising something it does not do.
    pub start_bps: u16,
    /// Seconds over which it falls linearly to the curve's own fee.
    pub seconds: u64,
}

impl EarlyFee {
    /// The fee in bps this many seconds after the launch opened.
    ///
    /// Linear, and ROUNDED DOWN, so a rounding error favours the trader rather than
    /// the pool. The pool cannot complain and the trader can.
    pub fn bps_at(&self, base_bps: u16, elapsed_secs: u64) -> u16 {
        if elapsed_secs >= self.seconds || self.seconds == 0 {
            return base_bps;
        }
        let premium = self.start_bps.saturating_sub(base_bps) as u128;
        let remaining = (self.seconds - elapsed_secs) as u128;
        // u128 throughout: `premium * remaining` overflows u64 for a long decay, and
        // the overflow would silently wrap into a small fee rather than a large one,
        // which is the direction that costs the pool.
        let extra = premium * remaining / self.seconds as u128;
        base_bps.saturating_add(extra as u16)
    }
}

impl LaunchRules {
    pub fn validate(&self, curve_supply: Uint128, base_fee_bps: u16) -> Result<(), RuleError> {
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

        if let Some(ef) = &self.early_fee {
            if ef.seconds == 0 {
                // A decay with no duration is the base fee with extra steps, and it
                // would display as an opening fee that never applies.
                return Err(RuleError::Invalid {
                    reason: "the early fee decays over zero seconds, so it never applies".into(),
                });
            }
            if ef.start_bps <= base_fee_bps {
                /*
                 * Refused rather than clamped. An opening fee at or below the curve's
                 * own decays to nothing and changes no trade, and stored it would be
                 * displayed to buyers as a protection against snipers that does not
                 * exist. Same reasoning as a wallet cap above the whole supply.
                 */
                return Err(RuleError::Invalid {
                    reason: format!(
                        "the opening fee of {} bps is not above the curve's own {base_fee_bps} bps, so it would never apply",
                        ef.start_bps
                    ),
                });
            }
            if ef.start_bps > MAX_EARLY_FEE_BPS {
                return Err(RuleError::Invalid {
                    reason: format!(
                        "the opening fee is {} bps; the maximum is {MAX_EARLY_FEE_BPS}",
                        ef.start_bps
                    ),
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

/// Default for `opened_at` on a launch stored before the field existed: the epoch,
/// which reads as "opened long ago" and so applies no premium. The safe direction.
fn epoch() -> Timestamp {
    Timestamp::from_seconds(0)
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
        LaunchRules { max_per_wallet: Some(Uint128::new(cap)), trade_start: None, early_fee: None }
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
        let r = LaunchRules { max_per_wallet: None, trade_start: Some(t), early_fee: None };
        assert!(!r.buying_open_at(t.minus_seconds(1)), "open before the start");
        assert!(r.buying_open_at(t), "closed at exactly the start");
        assert!(r.buying_open_at(t.plus_seconds(1)));
        // No start time means open from the first block.
        assert!(LaunchRules::default().buying_open_at(Timestamp::from_seconds(0)));
    }
}

#[cfg(test)]
mod early_fee_tests {
    use super::*;

    const BASE: u16 = 100; // 1%, the curve's own fee in the fixtures.

    fn ef(start: u16, secs: u64) -> EarlyFee {
        EarlyFee { start_bps: start, seconds: secs }
    }

    #[test]
    fn the_opening_second_charges_the_full_opening_fee() {
        // At t=0 nothing has decayed, so the first buyer in the first block pays the
        // whole premium. If this rounded down to the base, the rule would do nothing
        // in exactly the block it exists for.
        assert_eq!(ef(1_000, 600).bps_at(BASE, 0), 1_000);
    }

    #[test]
    fn it_reaches_the_base_fee_exactly_at_the_end_and_stays_there() {
        /*
         * Both sides of the boundary. One second early must still carry something, or
         * the decay has a dead zone at its end; at and after the end it must be the
         * base fee exactly, or a launch pays a premium forever and nobody notices
         * because it is small.
         */
        let e = ef(1_100, 1_000);
        assert!(e.bps_at(BASE, 999) > BASE, "the last second charged nothing extra");
        assert_eq!(e.bps_at(BASE, 1_000), BASE, "the decay did not finish on time");
        assert_eq!(e.bps_at(BASE, 1_001), BASE);
        assert_eq!(e.bps_at(BASE, u64::MAX), BASE, "a long-lived launch still pays a premium");
    }

    #[test]
    fn it_decays_linearly_and_rounds_down() {
        /*
         * Halfway through a 900 bps premium is 450 over the base. Rounding is DOWN so
         * any rounding error favours the trader: the pool cannot complain about a unit
         * and the person paying can.
         */
        let e = ef(1_000, 100);
        assert_eq!(e.bps_at(BASE, 50), BASE + 450);
        assert_eq!(e.bps_at(BASE, 25), BASE + 675);
        assert_eq!(e.bps_at(BASE, 75), BASE + 225);

        // A premium that does not divide evenly rounds down rather than up.
        let odd = ef(BASE + 10, 3);
        assert_eq!(odd.bps_at(BASE, 1), BASE + 6, "10 * 2 / 3 should floor to 6");
    }

    #[test]
    fn a_long_decay_does_not_overflow_into_a_small_fee() {
        /*
         * `premium * remaining` is the product that overflows, and in u64 it would
         * WRAP, turning a large fee into a small one: the direction that silently
         * costs the pool rather than failing loudly. Computed in u128 for that reason,
         * and this is the case that would catch a revert to narrower arithmetic.
         */
        let e = ef(2_000, u64::MAX);
        let got = e.bps_at(BASE, 0);
        assert!(got >= BASE, "overflow produced a fee below the base: {got}");
        assert_eq!(got, 2_000, "the opening fee was not charged at t=0");
    }

    #[test]
    fn no_early_fee_configured_is_simply_the_base_fee() {
        // The default path, and the one every launch without the rule takes.
        let r = LaunchRules::default();
        assert!(r.early_fee.is_none());
    }

    #[test]
    fn an_opening_fee_that_could_never_apply_is_refused() {
        /*
         * Same reasoning as a wallet cap above the whole supply: stored, it displays
         * to buyers as protection against snipers that does not exist.
         */
        let supply = Uint128::new(1_000);
        for bad in [BASE, BASE - 1, 0] {
            let r = LaunchRules { max_per_wallet: None, trade_start: None, early_fee: Some(ef(bad, 60)) };
            assert!(r.validate(supply, BASE).is_err(), "an opening fee of {bad} was accepted");
        }
        // Zero duration is the base fee with extra steps.
        let r = LaunchRules { max_per_wallet: None, trade_start: None, early_fee: Some(ef(500, 0)) };
        assert!(r.validate(supply, BASE).is_err(), "a zero-second decay was accepted");

        // And above the cap, which exists even though the premium never reaches the
        // creator: a launch advertising a 90% opening fee is a trap whoever benefits.
        let r = LaunchRules {
            max_per_wallet: None,
            trade_start: None,
            early_fee: Some(ef(MAX_EARLY_FEE_BPS + 1, 60)),
        };
        assert!(r.validate(supply, BASE).is_err(), "an opening fee above the cap was accepted");

        // A sane one passes.
        let ok = LaunchRules { max_per_wallet: None, trade_start: None, early_fee: Some(ef(1_000, 600)) };
        assert!(ok.validate(supply, BASE).is_ok());
    }
}
