// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Factory} from "../src/Factory.sol";
import {Curve} from "../src/Curve.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {CurveMath} from "../src/CurveMath.sol";
import {EarlyFee} from "../src/PoolMath.sol";

/**
 * V-01: what an opening fee actually does, as opposed to what the form says.
 *
 * TWO CAPS THAT DO NOT AGREE, AND THE LAUNCH IS CAUGHT BETWEEN THEM.
 *
 *   `EarlyFee.MAX_EARLY_FEE_BPS` = 2,000   checked by the factory, at CREATION
 *   `CurveMath.MAX_FEE_BPS`      = 1,000   checked by `validate`, at every TRADE
 *
 * `Curve._cfg(currentFeeBps())` folds the opening premium into `feeBps` and hands it
 * to `CurveMath.quoteBuy`, which calls `validate`, which refuses anything over 1,000.
 * So the factory happily creates a launch whose opening fee is 10% to 20%, and every
 * buy and every sell on it reverts until the fee decays under 10%.
 *
 * The launch was unusable for exactly the window the opening fee exists for. Fixed by
 * giving the two questions two ceilings; the tests below now assert the fix, and the
 * last of them fails if the gap ever reopens.
 *
 * AND THE OPENING FEE APPLIES TO SELLS, which three places in the interface say it
 * does not. `currentSellFeeBps` builds the same `EarlyFee.Schedule` against
 * `_FEE_SELL_BPS`, so the premium is charged on the way out as well as on the way in.
 */
contract EarlyFeeTest is Test {
    Factory internal factory;
    address internal admin = address(0xA11CE);
    address internal platform = address(0xB0B);
    address internal creator = address(0xC0FFEE);
    address internal alice = address(0xA1);

    uint256 constant V_INJ = 30 ether;
    uint256 constant TARGET = 85 ether;

    function setUp() public {
        factory = new Factory(admin, platform, 0);
        vm.deal(creator, 100 ether);
        vm.deal(alice, 1_000 ether);
        // A non-zero start, so `block.timestamp - TRADE_START` is a real elapsed time.
        vm.warp(1_000_000);
    }

    function _create(uint256 startBps, uint256 secs, uint256 feeBps, uint256 feeSellBps)
        internal
        returns (Curve c, LaunchToken t)
    {
        vm.prank(creator);
        (, address curve, address token) = factory.createLaunch(
            Factory.CreateParams({
                name: "Opening",
                symbol: "OPEN",
                virtualInj: V_INJ,
                graduationTarget: TARGET,
                feeBps: feeBps,
                feeSellBps: feeSellBps,
                earlyFeeStartBps: startBps,
                earlyFeeSecs: secs,
                tradeStart: block.timestamp,
                maxPerWallet: 0,
                rewardRoute: Curve.RewardRoute.Creator
            })
        );
        return (Curve(payable(curve)), LaunchToken(token));
    }

    /**
     * V-01, FIXED: an opening fee the factory accepts is one the curve can price.
     *
     * THE DEFECT THIS REPLACES. `Curve._cfg(currentFeeBps())` folds the opening
     * premium into `feeBps` and hands it to `CurveMath.validate`, which checked it
     * against `MAX_FEE_BPS` of 1,000 - a ceiling meant for a launch's STANDING rate.
     * The factory accepts an opening fee up to 2,000, so a launch created with one
     * between 1,001 and 2,000 reverted every buy and every sell with
     * `FeeTooHigh(1500, 1000)` until the premium decayed under 10%. Unusable for
     * exactly the window the opening fee exists for, created without complaint, and
     * invisible until somebody tried to trade.
     *
     * Two ceilings for two questions now: what a launch may CHARGE as its standing
     * rate (a policy about rugs, 10%, enforced at creation) and what the arithmetic
     * may PRICE (2,000, checked at every trade).
     */
    function test_anOpeningFeeOverTenPercentNowTrades() public {
        (Curve c, LaunchToken t) = _create(1_500, 600, 100, 100);
        assertEq(c.currentFeeBps(), 1_500, "the opening fee is not in force");

        // Quoted, not refused.
        CurveMath.BuyQuote memory q = c.quoteBuy(1 ether);
        assertGt(q.tokensOut, 0, "the curve still cannot quote an elevated fee");

        vm.prank(alice);
        c.buy{value: 1 ether}(0, address(0));
        assertGt(t.balanceOf(alice), 0, "the buy did not land");

        // And the premium really was charged: 15% of the input, not the base 1%.
        assertApproxEqRel(q.fee, 0.15 ether, 0.01e18, "the elevated fee was not applied");
    }

    /// The whole range the factory permits is now priceable, not just the bottom half.
    function test_theEntireCreationRangeCanTrade() public {
        for (uint256 bps = 1_100; bps <= EarlyFee.MAX_EARLY_FEE_BPS; bps += 300) {
            (Curve c,) = _create(bps, 600, 100, 100);
            CurveMath.BuyQuote memory q = c.quoteBuy(1 ether);
            assertGt(q.tokensOut, 0, "a legal opening fee cannot be priced");
        }
    }

    /**
     * THE REGRESSION THAT RAISING THE CEILING NEARLY INTRODUCED.
     *
     * The base rates were capped only as a side effect of `CurveMath.validate`. Once
     * that function accepts the effective ceiling, a creator could have set a 20%
     * STANDING fee - "a launchpad taking more than 10% is a rug with extra steps", as
     * the constant's own comment puts it. So the policy is now stated at creation,
     * about the base rates, where it belongs.
     */
    function test_aBaseFeeOverTenPercentIsStillRefused() public {
        vm.expectRevert(abi.encodeWithSelector(CurveMath.FeeTooHigh.selector, 1_001, 1_000));
        _create(0, 0, 1_001, 100);

        vm.expectRevert(abi.encodeWithSelector(CurveMath.FeeTooHigh.selector, 1_500, 1_000));
        _create(0, 0, 100, 1_500);

        // And exactly at the cap is allowed, there and here.
        (Curve ok,) = _create(0, 0, 1_000, 1_000);
        assertEq(ok.currentFeeBps(), 1_000);
    }

    /**
     * The creation ceiling may never exceed the trade-time one again.
     *
     * THE SHAPE OF V-01, not an instance of it: a launch the factory permits and the
     * curve refuses. They are one reference now rather than two literals, and this
     * fails if anyone splits them.
     */
    function test_theCreationCeilingNeverExceedsTheTradeTimeCeiling() public pure {
        assertLe(
            EarlyFee.MAX_EARLY_FEE_BPS,
            CurveMath.MAX_EFFECTIVE_FEE_BPS,
            "the factory accepts an opening fee the curve cannot price - this is V-01"
        );
        // And the standing-rate policy is still the stricter of the two.
        assertLt(CurveMath.MAX_FEE_BPS, CurveMath.MAX_EFFECTIVE_FEE_BPS);
    }

    /**
     * THE OPENING FEE IS CHARGED ON SELLS, which the interface says three times it is
     * not: on the risks page, in the trade panel, and in `describeRules`.
     *
     * Not an edge case - it is the ordinary path. `currentSellFeeBps` builds the same
     * schedule against the sell fee, so an early buyer who changes their mind pays the
     * premium to leave.
     */
    function test_theOpeningFeeIsChargedOnSellsToo() public {
        // Base fees of 100 both ways, opening fee 900 so it stays under the trade cap.
        (Curve c, LaunchToken t) = _create(900, 600, 100, 100);

        assertEq(c.currentSellFeeBps(), 900, "the premium is not applied to sells");
        assertGt(c.currentSellFeeBps(), 100, "the sell fee is the base rate after all");

        vm.prank(alice);
        c.buy{value: 1 ether}(0, address(0));
        uint256 held = t.balanceOf(alice);

        // What the same sale returns now, against what it returns once the fee decays.
        CurveMath.SellQuote memory early = c.quoteSell(held);
        vm.warp(block.timestamp + 601);
        assertEq(c.currentSellFeeBps(), 100, "the premium never decayed");
        CurveMath.SellQuote memory late = c.quoteSell(held);

        assertGt(late.injOut, early.injOut, "selling early and late return the same, so sells are untouched");
        assertGt(early.fee, late.fee, "the early sell did not pay a bigger fee");
    }

    /**
     * And the premium on a sell goes nowhere special.
     *
     * The interface says the amount above the base rate "goes into the pool at
     * graduation, not to the creator". On the sell side the whole fee is split
     * creator/platform like any other, so that sentence is wrong twice over for sells.
     */
    function test_theSellPremiumIsSplitLikeAnyOtherFeeNotHeldForThePool() public {
        (Curve c, LaunchToken t) = _create(900, 600, 100, 100);

        vm.prank(alice);
        c.buy{value: 1 ether}(0, address(0));
        uint256 held = t.balanceOf(alice);

        uint256 creatorBefore = c.creatorOwed();
        uint256 platformBefore = c.platformOwed();

        vm.startPrank(alice);
        t.approve(address(c), held);
        c.sell(held, 0);
        vm.stopPrank();

        assertGt(c.creatorOwed(), creatorBefore, "the creator got none of the sell fee");
        assertGt(c.platformOwed(), platformBefore, "the platform got none of the sell fee");
    }
}
