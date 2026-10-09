use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Uint128;

use crate::state::LaunchRules;
use crate::state::{Config, CurveConfigStored, State};

#[cw_serde]
pub struct InstantiateMsg {
    /// The launched token's native denom. The full `curve_supply` of it must
    /// be sent along with this message: that deposit is the one-sided side.
    pub denom: String,
    /// What buyers pay with. Normally "inj".
    pub quote_denom: String,
    pub creator: String,
    pub platform: String,
    pub migration_target: String,
    /// Tokens held back to pair against the collected INJ at migration.
    /// The seed deposit must cover `curve.curve_supply + lp_reserve`.
    pub lp_reserve: Uint128,
    pub creator_fee_share_bps: u16,
    pub curve: CurveConfigStored,
    /// Trading rules. Absent means an open launch with no cap and no start time,
    /// which is what a launch created before this field existed had.
    #[serde(default)]
    pub rules: LaunchRules,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Buy tokens with the attached quote denom. Any amount beyond what the
    /// curve can still absorb is refunded in the same transaction.
    Buy {
        min_tokens_out: Uint128,
        /// Who receives the tokens. Defaults to the sender.
        ///
        /// Exists for ONE caller: the factory, buying on a creator's behalf in the
        /// transaction that creates the launch. Without it the factory would be the
        /// buyer of record and would hold the tokens, because a curve pays whoever
        /// sent the message.
        ///
        /// It does not weaken anything. The funds still come from the sender, so
        /// naming someone else is a gift rather than a theft, and the wallet cap is
        /// charged to the RECIPIENT, since they are the address that ends up holding.
        #[serde(default)]
        recipient: Option<String>,
    },
    /// Sell tokens back to the curve by attaching them to the message.
    Sell { min_inj_out: Uint128 },
    /// Close the curve and move the reserve and leftover tokens to the
    /// migration target. Permissionless: once the target is hit, anyone may
    /// trigger it, so a launch cannot be held hostage by its creator.
    Graduate {},
    /// Pay out accrued fees to the platform and creator.
    ClaimFees {},
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(Config)]
    Config {},
    #[returns(State)]
    State {},
    /// What a buy of `inj_in` would return, without executing it.
    #[returns(SimulateBuyResponse)]
    SimulateBuy { inj_in: Uint128 },
    /// What a sell of `tokens_in` would return, without executing it.
    #[returns(SimulateSellResponse)]
    SimulateSell { tokens_in: Uint128 },
    /// Price of one whole token in the smallest quote unit. Display only.
    #[returns(SpotPriceResponse)]
    SpotPrice { one_token: Uint128 },
}

#[cw_serde]
pub struct SimulateBuyResponse {
    pub tokens_out: Uint128,
    pub fee: Uint128,
    pub refund: Uint128,
    pub graduates: bool,
}

#[cw_serde]
pub struct SimulateSellResponse {
    pub inj_out: Uint128,
    pub fee: Uint128,
}

#[cw_serde]
pub struct SpotPriceResponse {
    pub price: Uint128,
}
