// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {Test} from "forge-std/Test.sol";
import {Factory} from "../src/Factory.sol";
import {Curve} from "../src/Curve.sol";

/**
 * The new per-side payout cannot be re-entered.
 *
 * V-03 split `claimFees` into two sends, and each one zeroes its side's accounting
 * BEFORE calling out and restores it only on failure. That ordering is what makes a
 * re-entrant claim find nothing to take - but the external call is now made twice
 * where it was made twice before under one guard, so it is worth proving rather than
 * assuming that the guard still covers it.
 *
 * `ReentrancyGuard` is one lock for the whole contract, so a creator's `receive`
 * cannot buy, sell, graduate or claim while a payout is in flight. Asserted by
 * actually trying it, because "the modifier is on the function" is a claim about
 * source and this is a claim about behaviour.
 */

/// A creator that tries to trade from inside its own fee payout.
contract Reenterer {
    Curve public c;
    bool public tried;
    bool public succeeded;
    function set(Curve _c) external { c = _c; }
    receive() external payable {
        if (address(c) == address(0) || tried) return;
        tried = true;
        try c.buy{value: 0.01 ether}(0, address(0)) { succeeded = true; } catch { succeeded = false; }
    }
}

contract ReenterTest is Test {
    function test_reentryFromAFeePayoutIsBlocked() public {
        Reenterer r = new Reenterer();
        Factory f = new Factory(address(0xA11CE), address(0xB0B), 0);
        vm.deal(address(r), 10 ether);
        vm.prank(address(r));
        (, address curve,) = f.createLaunch(Factory.CreateParams({
            name:"R", symbol:"R", virtualInj:30 ether, graduationTarget:85 ether,
            feeBps:100, feeSellBps:100, earlyFeeStartBps:0, earlyFeeSecs:0,
            tradeStart:0, maxPerWallet:0, rewardRoute:Curve.RewardRoute.Creator}));
        Curve c = Curve(payable(curve));
        r.set(c);
        vm.deal(address(0xA1), 100 ether);
        vm.prank(address(0xA1));
        c.buy{value: 10 ether}(0, address(0));

        c.claimFees();
        assertTrue(r.tried(), "the creator never got a chance to re-enter");
        assertFalse(r.succeeded(), "a re-entrant buy succeeded from inside a fee payout");
    }
}
