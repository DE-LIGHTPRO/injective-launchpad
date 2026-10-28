// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Factory} from "../src/Factory.sol";
import {Curve} from "../src/Curve.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {CurveMath} from "../src/CurveMath.sol";

/**
 * A launch end to end: create, buy, sell, graduate, trade the pool, claim.
 *
 * The parity tests prove the arithmetic matches the Rust. These prove the CONTRACT
 * does what the arithmetic says, which is the half a math port cannot cover: who
 * holds the tokens, whether the fee split lands where it should, whether the pool is
 * actually seeded, and whether the contract can pay what it says it owes.
 */
contract LifecycleTest is Test {
    Factory internal factory;
    address internal admin = address(0xA11CE);
    address internal platform = address(0xB0B);
    address internal creator = address(0xC0FFEE);
    address internal alice = address(0xA1);
    address internal bob = address(0xB2);

    uint256 constant ONE = 1e18;
    uint256 constant V_INJ = 30 ether;
    uint256 constant TARGET = 85 ether;

    function setUp() public {
        factory = new Factory(admin, platform, 0.2 ether);
        vm.deal(creator, 100 ether);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
    }

    function _create(Curve.RewardRoute route) internal returns (Curve c, LaunchToken t) {
        vm.prank(creator);
        (, address curve, address token) = factory.createLaunch{value: 0.2 ether}(
            Factory.CreateParams({
                name: "Test Token",
                symbol: "TEST",
                virtualInj: V_INJ,
                graduationTarget: TARGET,
                feeBps: 100,
                earlyFeeStartBps: 0,
                earlyFeeSecs: 0,
                tradeStart: 0,
                rewardRoute: route
            })
        );
        return (Curve(payable(curve)), LaunchToken(token));
    }

    // ------------------------------------------------------------ create --

    function test_createMintsEverythingToTheCurveAndForwardsTheFee() public {
        uint256 platformBefore = platform.balance;
        (Curve c, LaunchToken t) = _create(Curve.RewardRoute.Creator);

        assertEq(t.totalSupply(), factory.TOTAL_SUPPLY());
        assertEq(t.balanceOf(address(c)), factory.TOTAL_SUPPLY(), "the curve does not hold the supply");
        assertEq(t.balanceOf(address(factory)), 0, "the factory kept tokens");
        assertEq(address(c.TOKEN()), address(t), "the curve points at the wrong token");
        assertEq(platform.balance - platformBefore, 0.2 ether, "the launch fee was not forwarded");
        assertEq(c.CREATOR(), creator);
    }

    function test_theTokenCanNeverBeMintedAgain() public {
        (, LaunchToken t) = _create(Curve.RewardRoute.Creator);
        uint256 supply = t.totalSupply();

        // There is no mint, no owner, no role. The only evidence that matters is
        // that the supply cannot move after construction.
        vm.prank(admin);
        vm.expectRevert();
        (bool ok,) = address(t).call(abi.encodeWithSignature("mint(address,uint256)", admin, 1));
        ok;
        assertEq(t.totalSupply(), supply);
    }

    function test_theWrongLaunchFeeIsRefusedRatherThanKept() public {
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Factory.WrongLaunchFee.selector, 1 ether, 0.2 ether));
        factory.createLaunch{value: 1 ether}(
            Factory.CreateParams("n", "S", V_INJ, TARGET, 100, 0, 0, 0, Curve.RewardRoute.Creator)
        );
    }

    // --------------------------------------------------------------- buy --

    function test_buyMovesTokensAndSplitsTheFeeSeventyThirty() public {
        (Curve c, LaunchToken t) = _create(Curve.RewardRoute.Creator);

        CurveMath.BuyQuote memory q = c.quoteBuy(10 ether);
        vm.prank(alice);
        c.buy{value: 10 ether}(0, address(0));

        assertEq(t.balanceOf(alice), q.tokensOut, "the buyer did not get the quoted tokens");
        assertEq(c.injCollected(), q.injInAfterFee, "the reserve does not match the quote");

        uint256 expectedCreator = (q.fee * 7_000) / 10_000;
        assertEq(c.creatorOwed(), expectedCreator, "creator share is not 70%");
        assertEq(c.platformOwed(), q.fee - expectedCreator, "platform share is not the remainder");
        assertEq(c.creatorOwed() + c.platformOwed(), q.fee, "the split lost a unit");
    }

    function test_slippageIsEnforced() public {
        (Curve c,) = _create(Curve.RewardRoute.Creator);
        CurveMath.BuyQuote memory q = c.quoteBuy(1 ether);
        vm.prank(alice);
        vm.expectRevert();
        c.buy{value: 1 ether}(q.tokensOut + 1, address(0));
    }

    // -------------------------------------------------------------- sell --

    function test_sellReturnsInjAndIsPaidFromTheReserveNotFromFees() public {
        (Curve c, LaunchToken t) = _create(Curve.RewardRoute.Creator);
        vm.prank(alice);
        c.buy{value: 20 ether}(0, address(0));

        uint256 held = t.balanceOf(alice);
        uint256 feesBefore = c.creatorOwed() + c.platformOwed();
        uint256 balBefore = alice.balance;

        CurveMath.SellQuote memory q = c.quoteSell(held / 2);
        vm.startPrank(alice);
        t.approve(address(c), held / 2);
        c.sell(held / 2, 0);
        vm.stopPrank();

        assertEq(alice.balance - balBefore, q.injOut, "the seller was not paid the quote");
        assertGt(c.creatorOwed() + c.platformOwed(), feesBefore, "the sell took no fee");
        // The reserve covers the payout; fees are untouched by it.
        assertGe(
            address(c).balance,
            c.injCollected() + c.creatorOwed() + c.platformOwed() + c.lpBonus(),
            "the contract cannot pay what it owes"
        );
    }

    // -------------------------------------------------------- graduation --

    function test_graduationSeedsTheLockedPoolAtomically() public {
        (Curve c, LaunchToken t) = _create(Curve.RewardRoute.Creator);

        vm.prank(alice);
        c.buy{value: 200 ether}(0, address(0)); // far past the target

        assertTrue(c.graduated(), "did not graduate");
        assertTrue(c.migrated(), "graduated without seeding the pool");
        assertEq(c.injCollected(), 0, "the reserve was not moved into the pool");
        assertGt(c.poolQuote(), 0, "the pool has no quote side");
        assertGt(c.poolTokens(), 0, "the pool has no token side");
        assertEq(c.tokensSold(), factory.CURVE_SUPPLY(), "supply was not marked sold");

        // The pool's token side is really here, not merely accounted for.
        assertGe(t.balanceOf(address(c)), c.poolTokens(), "the pool tokens are not held");
    }

    function test_graduationCannotRunTwice() public {
        (Curve c,) = _create(Curve.RewardRoute.Creator);
        vm.prank(alice);
        c.buy{value: 200 ether}(0, address(0));
        vm.expectRevert(Curve.AlreadyGraduated.selector);
        c.graduate();
    }

    function test_tradingContinuesAgainstThePoolAfterGraduation() public {
        (Curve c, LaunchToken t) = _create(Curve.RewardRoute.Creator);
        vm.prank(alice);
        c.buy{value: 200 ether}(0, address(0));

        uint256 qBefore = c.poolQuote();
        uint256 tBefore = c.poolTokens();

        vm.prank(bob);
        c.buy{value: 5 ether}(0, address(0));

        assertGt(t.balanceOf(bob), 0, "the pool buy gave no tokens");
        assertGt(c.poolQuote(), qBefore, "the pool quote side did not grow");
        assertLt(c.poolTokens(), tBefore, "the pool token side did not shrink");
        // k can only grow.
        assertGe(c.poolQuote() * c.poolTokens(), qBefore * tBefore, "a pool buy shrank k");
    }

    // --------------------------------------------------------- the route --

    function test_poolRouteSendsTheCreatorShareIntoTheLiquidity() public {
        /*
         * The defect the CosmWasm version had: post-graduation, Pool-routed creator
         * fees went into a bucket nothing could move. Here they go into the pool's
         * reserve directly.
         */
        (Curve c,) = _create(Curve.RewardRoute.Pool);

        // Before graduation the creator's share waits in lpBonus, deliberately kept
        // out of injCollected: quote added without tokens issued would move every
        // later price on the curve.
        vm.prank(alice);
        c.buy{value: 10 ether}(0, address(0));
        assertGt(c.lpBonus(), 0, "the pre-graduation share did not reach lpBonus");
        assertEq(c.creatorOwed(), 0, "a Pool-routed launch accrued to the creator");

        uint256 bonusAtGraduation = c.lpBonus();
        vm.prank(alice);
        c.buy{value: 300 ether}(0, address(0));
        assertTrue(c.migrated());
        // Folded into the pool, not stranded. lpBonus is spent, which is why it is 0.
        assertEq(c.lpBonus(), 0, "lpBonus survived graduation, so it was not paired in");
        assertGe(c.poolQuote(), bonusAtGraduation, "the held share did not reach the pool");

        uint256 poolBefore = c.poolQuote();
        uint256 creatorOwedBefore = c.creatorOwed();

        vm.prank(bob);
        c.buy{value: 10 ether}(0, address(0));

        /*
         * THE DEFECT THE COSMWASM VERSION HAD. Post-graduation, Pool-routed creator
         * fees went into lpBonus, whose only consumer had already run and refuses to
         * run again: not claimable, not part of any reserve, just quote against a
         * counter that only goes up. Here they go into the pool reserve directly.
         */
        assertEq(c.creatorOwed(), creatorOwedBefore, "a Pool-routed launch accrued to the creator");
        assertEq(c.lpBonus(), 0, "a post-graduation fee was stranded in lpBonus");
        assertGt(c.poolQuote() - poolBefore, 0, "nothing reached the pool");
    }

    // ------------------------------------------------------------ claims --

    function test_anyoneMayClaimAndTheMoneyGoesToTheRecordedAddresses() public {
        (Curve c,) = _create(Curve.RewardRoute.Creator);
        vm.prank(alice);
        c.buy{value: 20 ether}(0, address(0));

        uint256 owedCreator = c.creatorOwed();
        uint256 owedPlatform = c.platformOwed();
        assertGt(owedCreator, 0);

        uint256 cBefore = creator.balance;
        uint256 pBefore = platform.balance;

        // A stranger calls it. That is what makes the keeper safe to run unattended.
        vm.prank(bob);
        c.claimFees();

        assertEq(creator.balance - cBefore, owedCreator, "the creator was not paid");
        assertEq(platform.balance - pBefore, owedPlatform, "the platform was not paid");
        assertEq(c.creatorOwed(), 0);
        assertEq(c.creatorPaid(), owedCreator, "lifetime paid was not recorded");

        vm.expectRevert(Curve.NothingToClaim.selector);
        c.claimFees();
    }

    // -------------------------------------------------------- solvency --

    /**
     * The invariant the whole product rests on, asserted after a real sequence.
     *
     * This is the EVM equivalent of `scripts/verify-solvency.mjs`, which found zero
     * drift across twelve comparisons on the CosmWasm side.
     */
    function test_theContractCanAlwaysPayWhatItOwes() public {
        (Curve c, LaunchToken t) = _create(Curve.RewardRoute.Creator);

        vm.prank(alice);
        c.buy{value: 30 ether}(0, address(0));
        vm.prank(bob);
        c.buy{value: 15 ether}(0, address(0));

        uint256 held = t.balanceOf(alice);
        vm.startPrank(alice);
        t.approve(address(c), held / 3);
        c.sell(held / 3, 0);
        vm.stopPrank();

        _assertSolvent(c, t);

        vm.prank(bob);
        c.buy{value: 300 ether}(0, address(0)); // graduates
        _assertSolvent(c, t);

        vm.prank(alice);
        c.buy{value: 5 ether}(0, address(0)); // pool trade
        _assertSolvent(c, t);

        c.claimFees();
        _assertSolvent(c, t);
    }

    function _assertSolvent(Curve c, LaunchToken t) internal view {
        uint256 owedQuote = c.injCollected() + c.lpBonus() + c.poolQuote() + c.creatorOwed() + c.platformOwed();
        assertGe(address(c).balance, owedQuote, "the contract cannot cover its quote obligations");

        uint256 owedTokens =
            c.migrated() ? c.poolTokens() : factory.CURVE_SUPPLY() + factory.LP_RESERVE() - c.tokensSold();
        assertGe(t.balanceOf(address(c)), owedTokens, "the contract cannot cover its token obligations");
    }
}
