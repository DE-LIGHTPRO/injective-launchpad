// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CurveMath} from "./CurveMath.sol";

/**
 * @title PoolMath
 * @notice The locked pool a launch graduates into. Ported from
 *         `packages/launchpad-math/src/pool.rs`.
 *
 * Constant product over REAL reserves, unlike the curve, which uses virtual ones.
 * Seeded once at graduation with the collected quote and the LP reserve, and it has
 * no withdrawal path: reserves move only to a trader, in exchange for the other side.
 * That is what "liquidity locked at graduation" means here, and it is a property of
 * there being no function to call rather than of a key being thrown away.
 *
 * Same rounding discipline as the curve: every remaining reserve is rounded UP so the
 * trader receives less, never more, and `k` can only grow.
 */
library PoolMath {
    error ZeroAmount();
    error PoolEmpty();
    error FeeTooHigh(uint256 got, uint256 max);

    struct Reserves {
        uint256 quote;
        uint256 tokens;
    }

    struct BuyQuote {
        uint256 fee;
        uint256 quoteInAfterFee;
        uint256 tokensOut;
    }

    struct SellQuote {
        uint256 fee;
        uint256 quoteOut;
    }

    function k(Reserves memory p) internal pure returns (uint256) {
        return p.quote * p.tokens;
    }

    function _check(Reserves memory p, uint256 feeBps) private pure {
        if (p.quote == 0 || p.tokens == 0) revert PoolEmpty();
        if (feeBps > CurveMath.MAX_FEE_BPS) revert FeeTooHigh(feeBps, CurveMath.MAX_FEE_BPS);
    }

    function quoteBuy(Reserves memory p, uint256 feeBps, uint256 quoteIn)
        internal
        pure
        returns (BuyQuote memory q)
    {
        _check(p, feeBps);
        if (quoteIn == 0) revert ZeroAmount();

        q.fee = CurveMath.feeOn(quoteIn, feeBps);
        q.quoteInAfterFee = quoteIn - q.fee;
        if (q.quoteInAfterFee == 0) revert ZeroAmount();

        uint256 newQuote = p.quote + q.quoteInAfterFee;
        /*
         * Remaining token reserve rounded UP, so tokensOut comes out smaller. Never
         * below one, because k > 0 and the ceiling of a positive ratio is positive:
         * no buy can empty the pool of its token side.
         */
        uint256 newTokens = CurveMath.ceilDiv(k(p), newQuote);
        q.tokensOut = p.tokens > newTokens ? p.tokens - newTokens : 0;
        if (q.tokensOut == 0) revert ZeroAmount();
    }

    function quoteSell(Reserves memory p, uint256 feeBps, uint256 tokensIn)
        internal
        pure
        returns (SellQuote memory q)
    {
        _check(p, feeBps);
        if (tokensIn == 0) revert ZeroAmount();

        uint256 newTokens = p.tokens + tokensIn;
        // Remaining quote reserve rounded UP, so the payout comes out smaller.
        uint256 newQuote = CurveMath.ceilDiv(k(p), newTokens);
        uint256 gross = p.quote > newQuote ? p.quote - newQuote : 0;
        if (gross == 0) revert ZeroAmount();

        q.fee = CurveMath.feeOn(gross, feeBps);
        q.quoteOut = gross - q.fee;
        if (q.quoteOut == 0) revert ZeroAmount();
    }
}

/**
 * @title EarlyFee
 * @notice A higher fee at the opening, decaying linearly to the curve's own.
 *
 * Ported from `EarlyFee::bps_at`. ROUNDED DOWN, deliberately: a rounding error should
 * favour the trader rather than the pool, because the pool cannot complain and the
 * trader can.
 */
library EarlyFee {
    struct Schedule {
        /// Fee in bps when the launch opens. Must exceed the curve's own fee.
        uint256 startBps;
        /// Seconds over which it falls to the curve's fee.
        uint256 secs;
    }

    /// Mirrors `MAX_EARLY_FEE_BPS` in the Rust.
    uint256 internal constant MAX_EARLY_FEE_BPS = 2_000;

    function bpsAt(Schedule memory s, uint256 baseBps, uint256 elapsedSecs)
        internal
        pure
        returns (uint256)
    {
        if (s.secs == 0 || elapsedSecs >= s.secs) return baseBps;
        // `saturating_sub` in the Rust: a start below the base has no premium.
        uint256 premium = s.startBps > baseBps ? s.startBps - baseBps : 0;
        uint256 remaining = s.secs - elapsedSecs;
        // Truncating division is the round-down the spec asks for.
        return baseBps + (premium * remaining) / s.secs;
    }
}
