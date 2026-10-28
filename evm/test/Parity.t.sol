// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CurveMath} from "../src/CurveMath.sol";
import {Harness} from "./Harness.sol";

/**
 * The Solidity port against vectors produced BY THE RUST.
 *
 * This is the test that makes the rewrite a port rather than a reimplementation.
 * Everything else here could be written to agree with whatever the Solidity happens
 * to do; these numbers came out of `packages/launchpad-math`, which has 153 tests and
 * has been exercised on chain, so a disagreement is a defect in the port by
 * definition.
 *
 * Regenerate with:
 *   cargo run -p launchpad-math --example vectors > evm/test/vectors.json
 *   (then re-flatten, see docs/EVM-MIGRATION.md)
 *
 * THE REFUSALS ARE HALF THE CORPUS AND THE MORE IMPORTANT HALF. A port that returns
 * the right numbers for valid inputs and quietly returns something for invalid ones
 * is worse than one that is wrong everywhere, because it only fails in the cases
 * nobody tries by hand.
 */
contract ParityTest is Test {
    Harness internal h;

    // The shape a real launch uses, matching the vector generator exactly.
    uint256 constant ONE = 1e18;
    uint256 constant V_INJ = 30 * ONE;
    uint256 constant V_TOK = 1_073_000_000 * ONE;
    uint256 constant SUPPLY = 800_000_000 * ONE;
    uint256 constant TARGET = 85 * ONE;

    string internal json;

    function setUp() public {
        h = new Harness();
        json = vm.readFile("test/vectors.json");
    }

    function _cfg(uint256 feeBps) internal pure returns (CurveMath.Config memory) {
        return CurveMath.Config({
            virtualInj: V_INJ,
            virtualTokens: V_TOK,
            curveSupply: SUPPLY,
            graduationTarget: TARGET,
            feeBps: feeBps
        });
    }

    function _st(uint256 collected, uint256 sold) internal pure returns (CurveMath.State memory) {
        return CurveMath.State({injCollected: collected, tokensSold: sold, graduated: false});
    }

    function test_buysMatchTheRust() public view {
        uint256[] memory feeBps = vm.parseJsonUintArray(json, ".bFeeBps");
        uint256[] memory sold = vm.parseJsonUintArray(json, ".bSold");
        uint256[] memory collected = vm.parseJsonUintArray(json, ".bCollected");
        uint256[] memory amount = vm.parseJsonUintArray(json, ".bAmount");
        uint256[] memory eFee = vm.parseJsonUintArray(json, ".bFee");
        uint256[] memory eNet = vm.parseJsonUintArray(json, ".bNet");
        uint256[] memory eOut = vm.parseJsonUintArray(json, ".bOut");
        uint256[] memory eRefund = vm.parseJsonUintArray(json, ".bRefund");
        bool[] memory eGrad = vm.parseJsonBoolArray(json, ".bGraduates");

        // Anti-vacuity: an empty corpus would make every assertion below pass.
        assertGt(feeBps.length, 100, "the buy corpus is too small to be measuring anything");

        for (uint256 i = 0; i < feeBps.length; i++) {
            CurveMath.BuyQuote memory q =
                h.quoteBuy(_cfg(feeBps[i]), _st(collected[i], sold[i]), amount[i]);

            assertEq(q.fee, eFee[i], string.concat("fee at vector ", vm.toString(i)));
            assertEq(q.injInAfterFee, eNet[i], string.concat("net at vector ", vm.toString(i)));
            assertEq(q.tokensOut, eOut[i], string.concat("tokensOut at vector ", vm.toString(i)));
            assertEq(q.refund, eRefund[i], string.concat("refund at vector ", vm.toString(i)));
            assertEq(q.graduates, eGrad[i], string.concat("graduates at vector ", vm.toString(i)));
        }
    }

    function test_sellsMatchTheRust() public view {
        uint256[] memory feeBps = vm.parseJsonUintArray(json, ".sFeeBps");
        uint256[] memory sold = vm.parseJsonUintArray(json, ".sSold");
        uint256[] memory collected = vm.parseJsonUintArray(json, ".sCollected");
        uint256[] memory amount = vm.parseJsonUintArray(json, ".sAmount");
        uint256[] memory eFee = vm.parseJsonUintArray(json, ".sFee");
        uint256[] memory eOut = vm.parseJsonUintArray(json, ".sOut");

        assertGt(feeBps.length, 20, "the sell corpus is too small to be measuring anything");

        for (uint256 i = 0; i < feeBps.length; i++) {
            CurveMath.SellQuote memory q =
                h.quoteSell(_cfg(feeBps[i]), _st(collected[i], sold[i]), amount[i]);
            assertEq(q.fee, eFee[i], string.concat("sell fee at vector ", vm.toString(i)));
            assertEq(q.injOut, eOut[i], string.concat("sell out at vector ", vm.toString(i)));
        }
    }

    function test_whatTheRustRefusesThePortRefuses() public view {
        bool[] memory isBuy = vm.parseJsonBoolArray(json, ".xKindBuy");
        uint256[] memory feeBps = vm.parseJsonUintArray(json, ".xFeeBps");
        uint256[] memory sold = vm.parseJsonUintArray(json, ".xSold");
        uint256[] memory collected = vm.parseJsonUintArray(json, ".xCollected");
        uint256[] memory amount = vm.parseJsonUintArray(json, ".xAmount");

        assertGt(isBuy.length, 100, "the refusal corpus is too small");

        for (uint256 i = 0; i < isBuy.length; i++) {
            CurveMath.Config memory cfg = _cfg(feeBps[i]);
            CurveMath.State memory st = _st(collected[i], sold[i]);

            bool reverted;
            if (isBuy[i]) {
                try h.quoteBuy(cfg, st, amount[i]) {
                    reverted = false;
                } catch {
                    reverted = true;
                }
            } else {
                try h.quoteSell(cfg, st, amount[i]) {
                    reverted = false;
                } catch {
                    reverted = true;
                }
            }
            assertTrue(
                reverted,
                string.concat("the Rust refused vector ", vm.toString(i), " and the port did not")
            );
        }
    }

    // ------------------------------------------------- the invariant itself --

    /**
     * `injReserve * tokenReserve >= k` after every buy, for any input.
     *
     * The vectors prove the port agrees with the Rust on the points it sampled.
     * This proves the property the whole curve rests on holds everywhere, including
     * inputs neither implementation was ever run with. A rounding direction reversed
     * in the port would pass a sparse vector set and fail here.
     */
    function testFuzz_buyNeverMinesValueFromTheCurve(uint256 injIn, uint256 sold, uint96 collected)
        public
        view
    {
        sold = bound(sold, 0, SUPPLY - 1);
        injIn = bound(injIn, 1, 10_000 * ONE);
        CurveMath.Config memory cfg = _cfg(100);
        CurveMath.State memory st = _st(uint256(collected), sold);

        try h.quoteBuy(cfg, st, injIn) returns (CurveMath.BuyQuote memory q) {
            uint256 newInj = cfg.virtualInj + st.injCollected + q.injInAfterFee;
            uint256 newTok = cfg.virtualTokens - st.tokensSold - q.tokensOut;
            assertGe(newInj * newTok, cfg.virtualInj * cfg.virtualTokens, "a buy mined value out");
        } catch {
            // A refused quote is a valid outcome; it moves no reserves.
        }
    }

    function testFuzz_sellNeverMinesValueFromTheCurve(uint256 tokensIn, uint256 sold, uint96 collected)
        public
        view
    {
        sold = bound(sold, 1, SUPPLY - 1);
        tokensIn = bound(tokensIn, 1, sold);
        CurveMath.Config memory cfg = _cfg(100);
        CurveMath.State memory st = _st(uint256(collected), sold);

        try h.quoteSell(cfg, st, tokensIn) returns (CurveMath.SellQuote memory q) {
            uint256 gross = q.injOut + q.fee;
            uint256 newInj = cfg.virtualInj + st.injCollected - gross;
            uint256 newTok = cfg.virtualTokens - st.tokensSold + tokensIn;
            assertGe(newInj * newTok, cfg.virtualInj * cfg.virtualTokens, "a sell mined value out");
        } catch {}
    }

    /// Ceiling division, which is where every rounding decision in the port lives.
    function testFuzz_ceilDivRoundsUp(uint256 num, uint256 den) public pure {
        den = bound(den, 1, type(uint128).max);
        num = bound(num, 0, type(uint200).max);
        uint256 q = CurveMath.ceilDiv(num, den);
        assertGe(q * den, num, "ceilDiv rounded down");
        if (q > 0) assertLt((q - 1) * den, num, "ceilDiv rounded up too far");
    }

    // ------------------------------------- two guards that can never fire --

    /*
     * MUTATION TESTING FOUND TWO SURVIVORS AND BOTH ARE DEAD CODE IN THE SPEC, not
     * holes in the corpus. Deleting either from CurveMath.sol leaves every test
     * passing. The tests below say why, so the next person to run a mutation sweep
     * does not spend the afternoon I spent, and so the claim is checked rather than
     * asserted in a comment.
     *
     * Both are kept in the port. They cost nothing, they match the Rust line for
     * line, and a defensive guard whose precondition is proved elsewhere is cheap
     * insurance against that proof being invalidated by a later change.
     */

    /**
     * `if (gross > st.injCollected) gross = st.injCollected` can never bind.
     *
     * gross = (virtualInj + collected) - ceilDiv(k, tokRes + tokensIn), so
     * gross > collected requires virtualInj > ceilDiv(k, tokRes + tokensIn), i.e.
     * tokRes + tokensIn > virtualTokens, i.e. tokensIn > tokensSold. And quoteSell
     * rejects tokensIn > tokensSold several lines earlier.
     */
    function testFuzz_sellPayoutNeverExceedsCollected(uint256 tokensIn, uint256 sold, uint96 collected)
        public
        view
    {
        sold = bound(sold, 1, SUPPLY - 1);
        tokensIn = bound(tokensIn, 1, sold);
        CurveMath.State memory st = _st(uint256(collected), sold);

        try h.quoteSell(_cfg(100), st, tokensIn) returns (CurveMath.SellQuote memory q) {
            assertLe(
                q.injOut + q.fee,
                st.injCollected,
                "the cap bound, so it is reachable after all and this comment is wrong"
            );
        } catch {}
    }

    /**
     * `|| q.tokensOut == remaining` is redundant whenever the partial fill ran.
     *
     * Exhausting the curve collects exactly `maxCollectable`, independently of what
     * was collected before: the injCollected terms cancel. `validate` guarantees
     * graduationTarget <= maxCollectable, so the target condition is already true
     * whenever supply runs out, and the second clause adds nothing.
     *
     * It is reachable in principle in the non-partial path, where `wanted` happens
     * to equal `remaining` exactly. That is a measure-zero case and is why the
     * clause stays.
     */
    function testFuzz_exhaustingTheCurveAlwaysMeetsTheTarget(uint256 sold, uint96 collected)
        public
        view
    {
        sold = bound(sold, SUPPLY / 2, SUPPLY - 1);
        CurveMath.Config memory cfg = _cfg(100);
        CurveMath.State memory st = _st(uint256(collected), sold);

        // Far more than enough to clear whatever is left, forcing the partial fill.
        try h.quoteBuy(cfg, st, 1_000_000 * ONE) returns (CurveMath.BuyQuote memory q) {
            if (q.tokensOut != cfg.curveSupply - st.tokensSold) return; // not exhausted
            assertGe(
                st.injCollected + q.injInAfterFee,
                cfg.graduationTarget,
                "supply ran out below the graduation target, so the clause is load bearing"
            );
            assertTrue(q.graduates);
        } catch {}
    }

    /// And the equality that makes the argument above true.
    function test_exhaustingTheCurveCollectsExactlyMaxCollectable() public view {
        CurveMath.Config memory cfg = _cfg(100);
        uint256 reachable = CurveMath.maxCollectable(cfg);
        assertGe(reachable, cfg.graduationTarget, "validate would have rejected this config");

        for (uint256 collected = 0; collected <= 80 * ONE; collected += 40 * ONE) {
            CurveMath.BuyQuote memory q =
                h.quoteBuy(cfg, _st(collected, SUPPLY - 1000 * ONE), 1_000_000 * ONE);
            assertEq(
                collected + q.injInAfterFee,
                reachable,
                "the injCollected terms did not cancel, so the redundancy argument fails"
            );
        }
    }
}
