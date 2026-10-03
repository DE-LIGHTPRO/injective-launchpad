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

    #[error("trading has closed; this launch has graduated")]
    Graduated,

    #[error("the curve has not reached its graduation target yet")]
    NotReady,

    #[error("would receive {got} but asked for at least {min}")]
    Slippage { got: Uint128, min: Uint128 },

    #[error("nothing to claim")]
    NothingToClaim,
}
