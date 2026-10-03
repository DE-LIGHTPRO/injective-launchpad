use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Uint128};
use cw_storage_plus::Item;
use launchpad_math::{CurveConfig, CurveState};

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

pub const CONFIG: Item<Config> = Item::new("config");
pub const STATE: Item<State> = Item::new("state");
