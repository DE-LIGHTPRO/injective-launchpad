use cosmwasm_std::{OverflowError, StdError, Uint128};
use launchpad_math::CurveError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    /// Balance arithmetic went out of range. Surfacing this rather than
    /// saturating matters: a silently clamped reserve is an exploitable one.
    #[error("{0}")]
    Overflow(#[from] OverflowError),

    #[error("{0}")]
    Payment(#[from] cw_utils::PaymentError),

    #[error("{0}")]
    Curve(#[from] CurveError),

    #[error("unauthorised")]
    Unauthorised,

    #[error("the curve must be funded with exactly {expected} of {denom}, received {got}")]
    BadSeed {
        denom: String,
        expected: Uint128,
        got: Uint128,
    },

    #[error("the launch token denom and the quote denom must differ")]
    SameDenom,

    #[error("creator fee share is {got} bps, maximum is 10000")]
    BadFeeShare { got: u16 },

    #[error("{0}")]
    Rule(#[from] crate::state::RuleError),

    /// Names the cap and what the buyer already holds, because "too much" without the
    /// two numbers leaves them guessing how much smaller to make the order.
    #[error("this launch caps a wallet at {cap} tokens from the curve; you hold {held} and this buy would add {adding}")]
    WalletCapExceeded {
        cap: cosmwasm_std::Uint128,
        held: cosmwasm_std::Uint128,
        adding: cosmwasm_std::Uint128,
    },

    #[error("trading opens at {start}; the current block time is {now}")]
    NotOpenYet {
        start: cosmwasm_std::Timestamp,
        now: cosmwasm_std::Timestamp,
    },

    #[error("this launch has graduated and its liquidity is already in the locked pool")]
    Graduated,

    #[error("the curve has not reached its graduation target yet")]
    NotReady,

    #[error("would receive {got} but asked for at least {min}")]
    Slippage { got: Uint128, min: Uint128 },

    #[error("nothing to claim")]
    NothingToClaim,
}
