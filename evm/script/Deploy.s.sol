// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Factory} from "../src/Factory.sol";

/**
 * Deploy the factory to Injective EVM.
 *
 *   forge script script/Deploy.s.sol --rpc-url injective --broadcast
 *
 * Reads INJ_ADMIN, INJ_PLATFORM and INJ_LAUNCH_FEE_WEI from the environment, and the
 * key from --private-key or --ledger. The key is never read from a variable here: a
 * key in the environment is a key in the shell's history and in every child process.
 *
 * WHAT THIS DOES NOT NEED, and it is worth stating because the CosmWasm side needs
 * all of it: no governance proposal, no 100 INJ deposit, no four day vote, no
 * whitelisting. Injective's x/evm has `permissioned: false`, so deployment is
 * permissionless. The whole cost is about 0.001 INJ of gas at 0.16 gwei.
 */
contract Deploy is Script {
    function run() external {
        address admin = vm.envAddress("INJ_ADMIN");
        address platform = vm.envAddress("INJ_PLATFORM");
        uint256 launchFee = vm.envOr("INJ_LAUNCH_FEE_WEI", uint256(0.2 ether));

        /*
         * Checked here rather than left to the constructor's revert, because a
         * reverted broadcast still costs gas and the message it gives is a selector.
         * These are the two values that cannot be changed for an existing launch.
         */
        require(admin != address(0), "INJ_ADMIN is the zero address");
        require(platform != address(0), "INJ_PLATFORM is the zero address");
        require(launchFee <= 5 ether, "INJ_LAUNCH_FEE_WEI is above the 5 INJ cap");

        console.log("chain id       ", block.chainid);
        console.log("admin          ", admin);
        console.log("platform       ", platform);
        console.log("launch fee wei ", launchFee);

        vm.startBroadcast();
        Factory factory = new Factory(admin, platform, launchFee);
        vm.stopBroadcast();

        console.log("");
        console.log("factory        ", address(factory));
        console.log("");
        console.log("Set this in the app:");
        console.log("  NEXT_PUBLIC_EVM_FACTORY_ADDRESS=%s", address(factory));
        console.log("  NEXT_PUBLIC_EVM_CHAIN_ID=%s", block.chainid);
    }
}
