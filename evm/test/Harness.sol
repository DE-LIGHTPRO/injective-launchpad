// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CurveMath} from "../src/CurveMath.sol";

/**
 * External wrapper around the library.
 *
 * Library functions are `internal` and therefore inlined, so a revert inside one
 * cannot be caught with try/catch from a test. Half the parity corpus is inputs the
 * Rust REFUSES, and "the port refuses it too" is as much a part of matching the spec
 * as any returned number, so those cases need a catchable boundary.
 */
contract Harness {
    function quoteBuy(CurveMath.Config memory cfg, CurveMath.State memory st, uint256 injIn)
        external
        pure
        returns (CurveMath.BuyQuote memory)
    {
        return CurveMath.quoteBuy(cfg, st, injIn);
    }

    function quoteSell(CurveMath.Config memory cfg, CurveMath.State memory st, uint256 tokensIn)
        external
        pure
        returns (CurveMath.SellQuote memory)
    {
        return CurveMath.quoteSell(cfg, st, tokensIn);
    }
}
