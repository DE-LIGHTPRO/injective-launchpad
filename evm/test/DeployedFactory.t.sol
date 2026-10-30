// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Factory} from "../src/Factory.sol";
import {Curve} from "../src/Curve.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {CurveMath} from "../src/CurveMath.sol";

contract Rejector {
    receive() external payable { revert("cannot receive"); }
}

/**
 * The three fixes are in the bytecode actually deployed, not just in `src/`.
 *
 * A compile proves what the source says. This asks the contract at
 * `0xe24adc45…` on Injective mainnet, through a fork, which is the only way to know
 * that what was deployed is what was written - a different compile, a stale artifact
 * or the wrong constructor argument all look identical until something is run.
 *
 *   forge test --match-contract DeployedFactory \
 *     --fork-url https://injectiveevm-rpc.polkachu.com --evm-version cancun
 *
 * CANCUN, AND THAT IS NOT THE SAME ANSWER AS FOR ANVIL. Injective's block headers are
 * pre-Shanghai - `baseFeePerGas` is there, `withdrawalsRoot` and the blob fields are
 * not - so `anvil --fork-url` must be pinned to `--hardfork shanghai` or every
 * `eth_call` fails with "Excess blob gas not set". Its EVM nevertheless EXECUTES
 * Cancun opcodes, which is how the deployed contracts work at all: solc 0.8.28
 * defaults to cancun and emits MCOPY.
 *
 * Run at shanghai, these four tests failed consuming the whole block's gas - the
 * signature of an invalid opcode, not of a contract bug. Header support and opcode
 * support are two different questions about a chain, and this one answers them
 * differently.
 *
 * Polkachu rather than the public sentry: that hostname is a load balancer whose
 * nodes prune differently, measured and non-monotonically, so a fork from it fails
 * part way through on state it served a moment earlier.
 */
contract DeployedFactoryTest is Test {
    Factory constant FACTORY = Factory(0xe24adc45439a787e38b10bFD4AD4f51B636a1B50);
    address internal creator = address(0xC0FFEE);
    address internal alice = address(0xA1);

    function setUp() public {
        /*
         * SKIPPED, NOT FAILED, when this is not a fork. A plain `forge test` has no
         * chain behind it, and a fork-only suite that `require`s its way out takes the
         * whole run red for everybody - which is why the last fork test written here
         * was deleted rather than kept. `vm.skip` is the difference between "not
         * applicable" and "broken".
         */
        if (block.chainid != 1776 || address(FACTORY).code.length == 0) {
            vm.skip(true);
            return;
        }
        vm.deal(creator, 100 ether);
        vm.deal(alice, 1_000 ether);
    }

    function _create(uint256 earlyBps, address asCreator) internal returns (Curve c, LaunchToken t) {
        vm.prank(asCreator);
        (, address curve, address token) = FACTORY.createLaunch{value: 0.2 ether}(
            Factory.CreateParams({
                name: "Fixed", symbol: "FIX",
                virtualInj: 30 ether, graduationTarget: 85 ether,
                feeBps: 100, feeSellBps: 100,
                earlyFeeStartBps: earlyBps, earlyFeeSecs: earlyBps == 0 ? 0 : 600,
                tradeStart: block.timestamp, maxPerWallet: 0,
                rewardRoute: Curve.RewardRoute.Creator
            })
        );
        return (Curve(payable(curve)), LaunchToken(token));
    }

    function test_theDeployedFactoryIsConfiguredAsAsked() public view {
        assertEq(FACTORY.launchFee(), 0.2 ether, "the launch fee is not 0.2 INJ");
        assertEq(FACTORY.platform(), 0xd35EAA1b1161F47e5dBf607DE8E306501c1e3BD6);
        assertEq(FACTORY.admin(), 0x7fCc735e0e473932C1F75ec163B98226E4Bcf1Bb);
    }

    /// V-01, against the deployed bytecode: a 15% opening fee trades.
    function test_v01_anOpeningFeeOverTenPercentTrades() public {
        (Curve c, LaunchToken t) = _create(1_500, creator);
        assertEq(c.currentFeeBps(), 1_500, "the opening fee is not in force");

        CurveMath.BuyQuote memory q = c.quoteBuy(1 ether);
        assertGt(q.tokensOut, 0, "the deployed curve still cannot price an elevated fee");

        vm.prank(alice);
        c.buy{value: 1 ether}(0, address(0));
        assertGt(t.balanceOf(alice), 0, "the buy did not land on the deployed factory");
    }

    /// And the standing-rate policy survived the change.
    function test_v01_aTwentyPercentStandingFeeIsStillRefused() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(CurveMath.FeeTooHigh.selector, 2_000, 1_000));
        FACTORY.createLaunch{value: 0.2 ether}(
            Factory.CreateParams({
                name: "Rug", symbol: "RUG",
                virtualInj: 30 ether, graduationTarget: 85 ether,
                feeBps: 2_000, feeSellBps: 100,
                earlyFeeStartBps: 0, earlyFeeSecs: 0,
                tradeStart: block.timestamp, maxPerWallet: 0,
                rewardRoute: Curve.RewardRoute.Creator
            })
        );
    }

    /// V-03: a creator that cannot receive does not block the platform.
    function test_v03_oneSideCannotBlockTheOther() public {
        Rejector badCreator = new Rejector();
        vm.deal(address(badCreator), 10 ether);
        (Curve c,) = _create(0, address(badCreator));

        vm.prank(alice);
        c.buy{value: 10 ether}(0, address(0));

        uint256 platformOwed = c.platformOwed();
        uint256 creatorOwed = c.creatorOwed();
        assertGt(platformOwed, 0);
        uint256 before = FACTORY.platform().balance;

        c.claimFees();

        assertEq(FACTORY.platform().balance - before, platformOwed, "the platform was blocked");
        assertEq(c.creatorOwed(), creatorOwed, "the blocked side lost its fees");
    }

    /// V-04: plain INJ is refused rather than swallowed.
    function test_v04_plainInjIsRefused() public {
        (Curve c,) = _create(0, creator);
        uint256 before = address(c).balance;

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(c).call{value: 1 ether}("");

        assertFalse(ok, "the deployed curve still accepts unrecoverable transfers");
        assertEq(address(c).balance, before);
        assertEq(alice.balance, 1 ether, "the sender lost their INJ");
    }
}
