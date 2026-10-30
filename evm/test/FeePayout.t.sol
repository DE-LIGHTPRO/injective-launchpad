// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Factory} from "../src/Factory.sol";
import {Curve} from "../src/Curve.sol";
import {LaunchToken} from "../src/LaunchToken.sol";

/// A recipient that cannot receive INJ, which is the whole of V-03.
contract Rejector {
    bool public accepting;

    function accept() external {
        accepting = true;
    }

    receive() external payable {
        if (!accepting) revert("cannot receive");
    }
}

/**
 * V-03 and V-04: who can be paid, and what happens to INJ sent by hand.
 *
 * V-03. `claimFees` paid the creator and the platform in one transaction, and the
 * send reverts on failure, so a recipient that cannot receive took the whole claim
 * down with it. Both destinations are fixed at creation and cannot be changed, so the
 * other party had no recourse whatever: their fees sat in the contract for good,
 * because of an address they did not choose and could not change.
 *
 * Not hypothetical. A platform address that is a multisig without a payable fallback,
 * a creator who later deploys a contract at that address, or a fallback that runs out
 * of the gas a `call` leaves it - any of those freezes the other side's money.
 *
 * V-04. The curve accepted a bare transfer and called it a donation. Nobody donates to
 * a bonding curve; what happens is somebody pastes the curve address - the one the
 * launch page shows beside a Copy button - into a wallet's send screen. It arrived,
 * was credited to nothing, and no function existed that could move it out again.
 */
contract FeePayoutTest is Test {
    Factory internal factory;
    address internal admin = address(0xA11CE);
    address internal creator = address(0xC0FFEE);
    address internal alice = address(0xA1);

    function _launch(address platform)
        internal
        returns (Curve c, LaunchToken t)
    {
        Factory f = new Factory(admin, platform, 0);
        vm.deal(creator, 10 ether);
        vm.deal(alice, 1_000 ether);
        vm.prank(creator);
        (, address curve, address token) = f.createLaunch(
            Factory.CreateParams({
                name: "Payout",
                symbol: "PAY",
                virtualInj: 30 ether,
                graduationTarget: 85 ether,
                feeBps: 100,
                feeSellBps: 100,
                earlyFeeStartBps: 0,
                earlyFeeSecs: 0,
                tradeStart: 0,
                maxPerWallet: 0,
                rewardRoute: Curve.RewardRoute.Creator
            })
        );
        factory = f;
        c = Curve(payable(curve));
        t = LaunchToken(token);
        // One buy, so there is a fee on both sides to argue about.
        vm.prank(alice);
        c.buy{value: 10 ether}(0, address(0));
    }

    // ------------------------------------------------------------- V-03 --

    function test_aPlatformThatCannotReceiveDoesNotBlockTheCreator() public {
        Rejector platform = new Rejector();
        (Curve c,) = _launch(address(platform));

        uint256 creatorOwed = c.creatorOwed();
        uint256 platformOwed = c.platformOwed();
        assertGt(creatorOwed, 0);
        assertGt(platformOwed, 0);

        uint256 before = creator.balance;
        c.claimFees();

        // The creator is paid in full.
        assertEq(creator.balance - before, creatorOwed, "the creator was not paid");
        assertEq(c.creatorOwed(), 0, "the creator's owed did not clear");

        /*
         * And the platform's is untouched, not lost: the send failed, so its
         * accounting was put back exactly as it was. The money never left.
         */
        assertEq(c.platformOwed(), platformOwed, "the platform's fees were lost");
        assertEq(c.platformPaid(), 0, "the platform was recorded as paid when it was not");
    }

    function test_aCreatorThatCannotReceiveDoesNotBlockThePlatform() public {
        Rejector badCreator = new Rejector();
        Factory f = new Factory(admin, address(0xB0B), 0);
        vm.deal(address(badCreator), 10 ether);
        vm.deal(alice, 1_000 ether);
        vm.prank(address(badCreator));
        (, address curve,) = f.createLaunch(
            Factory.CreateParams({
                name: "Payout",
                symbol: "PAY",
                virtualInj: 30 ether,
                graduationTarget: 85 ether,
                feeBps: 100,
                feeSellBps: 100,
                earlyFeeStartBps: 0,
                earlyFeeSecs: 0,
                tradeStart: 0,
                maxPerWallet: 0,
                rewardRoute: Curve.RewardRoute.Creator
            })
        );
        Curve c = Curve(payable(curve));
        vm.prank(alice);
        c.buy{value: 10 ether}(0, address(0));

        uint256 platformOwed = c.platformOwed();
        uint256 creatorOwed = c.creatorOwed();
        uint256 before = address(0xB0B).balance;

        c.claimFees();

        assertEq(address(0xB0B).balance - before, platformOwed, "the platform was not paid");
        assertEq(c.creatorOwed(), creatorOwed, "the creator's fees were lost");
    }

    /**
     * The blocked side can still be paid later, once it can receive.
     *
     * Which is what makes this a delay rather than a loss, and is the half that would
     * be missing if the fix merely swallowed the failure.
     */
    function test_theBlockedSideCanClaimOnceItCanReceive() public {
        Rejector platform = new Rejector();
        (Curve c,) = _launch(address(platform));

        uint256 owed = c.platformOwed();
        c.claimFees(); // creator paid, platform refused
        assertEq(c.platformOwed(), owed);

        platform.accept();
        c.claimFees();

        assertEq(address(platform).balance, owed, "the platform could not be paid after all");
        assertEq(c.platformOwed(), 0);
        assertEq(c.platformPaid(), owed, "the paid counter does not match what was sent");
    }

    /**
     * Both sides failing is a refusal, not a transaction that succeeds having moved
     * nothing.
     *
     * The claim page zeroes its rows on a confirmation. A claim that confirms and pays
     * nobody would show a creator their money had moved when it had not.
     */
    function test_bothSidesFailingRevertsRatherThanConfirmingNothing() public {
        Rejector platform = new Rejector();
        Rejector badCreator = new Rejector();
        Factory f = new Factory(admin, address(platform), 0);
        vm.deal(address(badCreator), 10 ether);
        vm.deal(alice, 1_000 ether);
        vm.prank(address(badCreator));
        (, address curve,) = f.createLaunch(
            Factory.CreateParams({
                name: "Payout",
                symbol: "PAY",
                virtualInj: 30 ether,
                graduationTarget: 85 ether,
                feeBps: 100,
                feeSellBps: 100,
                earlyFeeStartBps: 0,
                earlyFeeSecs: 0,
                tradeStart: 0,
                maxPerWallet: 0,
                rewardRoute: Curve.RewardRoute.Creator
            })
        );
        Curve c = Curve(payable(curve));
        vm.prank(alice);
        c.buy{value: 10 ether}(0, address(0));

        vm.expectRevert(Curve.TransferFailed.selector);
        c.claimFees();
    }

    /// Nothing owed is still nothing to claim, and says so.
    function test_nothingOwedStillReverts() public {
        (Curve c,) = _launch(address(0xB0B));
        c.claimFees();
        vm.expectRevert(Curve.NothingToClaim.selector);
        c.claimFees();
    }

    /**
     * The contract can still pay everything it says it owes, after a partial claim.
     *
     * The invariant that matters most, checked at the moment the new code is most
     * likely to have broken it: one side paid, one side restored.
     */
    function test_solventAfterAPartialClaim() public {
        Rejector platform = new Rejector();
        (Curve c,) = _launch(address(platform));
        c.claimFees();
        assertGe(
            address(c).balance,
            c.injCollected() + c.creatorOwed() + c.platformOwed(),
            "the curve cannot pay what it owes after a partial claim"
        );
    }

    // ------------------------------------------------------------- V-04 --

    function test_plainInjSentToACurveIsRefused() public {
        (Curve c,) = _launch(address(0xB0B));
        uint256 before = address(c).balance;

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(c).call{value: 1 ether}("");

        assertFalse(ok, "a plain transfer was accepted and the INJ is unrecoverable");
        assertEq(address(c).balance, before, "the curve's balance moved");
        assertEq(alice.balance, 1 ether, "the sender lost their INJ");
    }

    /// And a buy is unaffected: it is `payable` and carries a call behind it.
    function test_buyingStillWorks() public {
        (Curve c, LaunchToken t) = _launch(address(0xB0B));
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        c.buy{value: 1 ether}(0, address(0));
        assertGt(t.balanceOf(alice), 0, "refusing plain transfers broke buying");
    }

    /**
     * A refund still reaches a buyer who cannot receive? No - and that is deliberate.
     *
     * `_pay` still reverts for refunds and sell payouts, because there the money is
     * the caller's own and failing the whole trade is right: the alternative is taking
     * their INJ and owing them a refund they cannot collect. V-03 is specifically
     * about one party's failure costing ANOTHER party, which is a different thing.
     */
    function test_aTradeStillFailsWholeIfTheTraderCannotBePaid() public {
        (Curve c, LaunchToken t) = _launch(address(0xB0B));
        Rejector trader = new Rejector();
        vm.deal(address(trader), 10 ether);

        vm.prank(address(trader));
        c.buy{value: 1 ether}(0, address(0));
        uint256 held = t.balanceOf(address(trader));

        vm.startPrank(address(trader));
        t.approve(address(c), held);
        vm.expectRevert(Curve.TransferFailed.selector);
        c.sell(held, 0);
        vm.stopPrank();
    }
}
