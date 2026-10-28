// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolMath, EarlyFee} from "../src/PoolMath.sol";

/**
 * The locked pool and the opening fee decay, against Rust-generated vectors.
 *
 * Same discipline as Parity.t.sol: these numbers came out of
 * `packages/launchpad-math`, so a disagreement is a defect in the port.
 */
contract PoolParityTest is Test {
    string internal json;

    function setUp() public {
        json = vm.readFile("test/poolvectors.json");
    }

    function test_poolBuysMatchTheRust() public view {
        uint256[] memory q = vm.parseJsonUintArray(json, ".pbQ");
        uint256[] memory t = vm.parseJsonUintArray(json, ".pbT");
        uint256[] memory f = vm.parseJsonUintArray(json, ".pbFee");
        uint256[] memory a = vm.parseJsonUintArray(json, ".pbAmt");
        uint256[] memory eFee = vm.parseJsonUintArray(json, ".pbEFee");
        uint256[] memory eNet = vm.parseJsonUintArray(json, ".pbENet");
        uint256[] memory eOut = vm.parseJsonUintArray(json, ".pbEOut");

        assertGt(q.length, 40, "the pool buy corpus is too small to measure anything");
        for (uint256 i = 0; i < q.length; i++) {
            PoolMath.BuyQuote memory r =
                PoolMath.quoteBuy(PoolMath.Reserves({quote: q[i], tokens: t[i]}), f[i], a[i]);
            assertEq(r.fee, eFee[i], string.concat("pool buy fee ", vm.toString(i)));
            assertEq(r.quoteInAfterFee, eNet[i], string.concat("pool buy net ", vm.toString(i)));
            assertEq(r.tokensOut, eOut[i], string.concat("pool buy out ", vm.toString(i)));
        }
    }

    function test_poolSellsMatchTheRust() public view {
        uint256[] memory q = vm.parseJsonUintArray(json, ".psQ");
        uint256[] memory t = vm.parseJsonUintArray(json, ".psT");
        uint256[] memory f = vm.parseJsonUintArray(json, ".psFee");
        uint256[] memory a = vm.parseJsonUintArray(json, ".psAmt");
        uint256[] memory eFee = vm.parseJsonUintArray(json, ".psEFee");
        uint256[] memory eOut = vm.parseJsonUintArray(json, ".psEOut");

        assertGt(q.length, 25, "the pool sell corpus is too small to measure anything");
        for (uint256 i = 0; i < q.length; i++) {
            PoolMath.SellQuote memory r =
                PoolMath.quoteSell(PoolMath.Reserves({quote: q[i], tokens: t[i]}), f[i], a[i]);
            assertEq(r.fee, eFee[i], string.concat("pool sell fee ", vm.toString(i)));
            assertEq(r.quoteOut, eOut[i], string.concat("pool sell out ", vm.toString(i)));
        }
    }

    /**
     * The pool's reserve product can only grow.
     *
     * This is what "locked" means arithmetically. There is no withdraw function, so
     * the only way value leaves is a trader taking more than they gave, which is a
     * rounding direction reversed.
     */
    function testFuzz_poolKNeverShrinks(uint256 quoteIn, uint96 q, uint96 t) public view {
        PoolMath.Reserves memory p =
            PoolMath.Reserves({quote: bound(q, 1e6, type(uint96).max), tokens: bound(t, 1e6, type(uint96).max)});
        quoteIn = bound(quoteIn, 1, 1e24);
        uint256 before = PoolMath.k(p);
        try this.buy(p, 100, quoteIn) returns (PoolMath.BuyQuote memory r) {
            uint256 after_ = (p.quote + r.quoteInAfterFee) * (p.tokens - r.tokensOut);
            assertGe(after_, before, "a pool buy shrank k");
        } catch {}
    }

    function buy(PoolMath.Reserves memory p, uint256 f, uint256 amt)
        external
        pure
        returns (PoolMath.BuyQuote memory)
    {
        return PoolMath.quoteBuy(p, f, amt);
    }

    // ------------------------------------------------------- the fee decay --

    function test_earlyFeeDecaysLinearlyAndRoundsDown() public pure {
        // 500 bps opening, decaying to 100 over 3600s.
        EarlyFee.Schedule memory s = EarlyFee.Schedule({startBps: 500, secs: 3600});

        assertEq(EarlyFee.bpsAt(s, 100, 0), 500, "opens at the start fee");
        assertEq(EarlyFee.bpsAt(s, 100, 3600), 100, "ends at the base fee");
        assertEq(EarlyFee.bpsAt(s, 100, 100_000), 100, "stays at the base fee after");
        assertEq(EarlyFee.bpsAt(s, 100, 1800), 300, "halfway is halfway");

        // Rounded DOWN, so an error favours the trader and not the pool.
        // premium 400, remaining 3599 -> 400*3599/3600 = 399.88 -> 399
        assertEq(EarlyFee.bpsAt(s, 100, 1), 499);
    }

    function test_aDecayWithNoDurationIsJustTheBaseFee() public pure {
        EarlyFee.Schedule memory s = EarlyFee.Schedule({startBps: 500, secs: 0});
        assertEq(EarlyFee.bpsAt(s, 100, 0), 100);
    }

    function test_aStartBelowTheBaseHasNoPremium() public pure {
        // `saturating_sub` in the Rust. Without it this underflows and reverts, or
        // worse, wraps to an enormous fee.
        EarlyFee.Schedule memory s = EarlyFee.Schedule({startBps: 50, secs: 3600});
        assertEq(EarlyFee.bpsAt(s, 100, 0), 100);
    }

    function testFuzz_earlyFeeIsNeverBelowBaseNorAboveStart(
        uint16 startBps,
        uint32 secs,
        uint32 elapsed,
        uint16 baseBps
    ) public pure {
        baseBps = uint16(bound(baseBps, 0, 1000));
        startBps = uint16(bound(startBps, 0, EarlyFee.MAX_EARLY_FEE_BPS));
        EarlyFee.Schedule memory s = EarlyFee.Schedule({startBps: startBps, secs: secs});
        uint256 got = EarlyFee.bpsAt(s, baseBps, elapsed);
        assertGe(got, baseBps, "the decayed fee fell below the base fee");
        if (startBps > baseBps) assertLe(got, startBps, "the decayed fee exceeded the opening fee");
    }
}
