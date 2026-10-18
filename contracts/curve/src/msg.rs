use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Uint128;

use crate::state::LaunchRules;
use crate::state::{RewardRoute, Config, CurveConfigStored, State};

#[cw_serde]
pub struct InstantiateMsg {
    /// The launched token's native denom. The full `curve_supply` of it must
    /// be sent along with this message: that deposit is the one-sided side.
    pub denom: String,
    /// What buyers pay with. Normally "inj".
    pub quote_denom: String,
    pub creator: String,
    pub platform: String,
    /// Tokens held back to pair against the collected INJ in the locked pool.
    /// The seed deposit must cover `curve.curve_supply + lp_reserve`.
    pub lp_reserve: Uint128,
    pub creator_fee_share_bps: u16,
    pub curve: CurveConfigStored,
    /// Trading rules. Absent means an open launch with no cap and no start time,
    /// which is what a launch created before this field existed had.
    #[serde(default)]
    pub rules: LaunchRules,
    /// Where the creator's share of each fee goes.
    #[serde(default)]
    pub reward_route: RewardRoute,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Buy tokens with the attached quote denom. On the curve, any amount beyond what
    /// it can still absorb is refunded in the same transaction. After graduation the
    /// same message trades against the locked pool.
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
    /// Sell tokens by attaching them: to the curve, or after graduation to the pool.
    Sell { min_inj_out: Uint128 },
    /// Seed the locked pool from the curve's reserve and leftover tokens.
    ///
    /// The buy that reaches the target already does this in the same transaction, so
    /// this exists only as a permissionless fallback: if the target is met and the pool
    /// is not yet seeded, anyone may finish it, and a launch can never be stranded
    /// between phases (Pons keeps its `createGraduatedPool` retryable for the same
    /// reason). Nothing is sent anywhere: the liquidity stays in this contract.
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
    /// The opening premium, taken off the top before the curve is quoted.
    ///
    /// Reported because without it the payment does not add up: `inj_in` is the sum of
    /// `refund`, this, `fee` and what reached the curve, and a caller given only three
    /// of those can reconcile none of them. It is also the only part of what a buyer
    /// pays that nobody is paid: it accrues to the pool the launch graduates into.
    pub early_fee_premium: Uint128,
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
