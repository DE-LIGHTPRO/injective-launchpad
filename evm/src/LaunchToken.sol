// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title LaunchToken
 * @notice A launched token. Fixed supply, no mint, no owner, forever.
 *
 * THIS IS THE PIECE THAT GOT SIMPLER IN THE PORT, and it is worth saying why.
 *
 * On Injective's native side a token is a tokenfactory denom, and a denom has an
 * admin who can mint without limit. The CosmWasm design therefore has to MOVE that
 * admin somewhere no code can use it: the launch transaction transfers it to the
 * curve contract, which has no message that mints and no wasm admin through which
 * one could be added, and the whole launch reverts if the creator did not hand it
 * over. That is a careful piece of work to make a guarantee out of a capability that
 * exists by default.
 *
 * Here the capability simply does not exist. The entire supply is minted once in the
 * constructor and there is no other path to `_mint` anywhere in the contract. No
 * owner, no minter role, no pause, no blocklist, no upgrade, no `_update` override.
 * The supply is fixed because there is no function that could change it, which is a
 * stronger statement than an admin having been transferred somewhere harmless.
 *
 * Deliberately NOT inherited: Ownable, AccessControl, ERC20Burnable, ERC20Pausable,
 * ERC20Permit. Each is a reason for a holder to have to read the code before
 * trusting the supply. Burnable is arguably harmless and is still absent, because
 * "nobody can change the supply" is a simpler promise than "nobody can increase it".
 */
contract LaunchToken is ERC20 {
    /// Every token that will ever exist, minted to `recipient` at construction.
    uint256 public immutable TOTAL_SUPPLY;

    error ZeroSupply();
    error ZeroRecipient();

    /**
     * @param name_ Token name.
     * @param symbol_ Token symbol.
     * @param supply The entire supply. Minted once, here, and never again.
     * @param recipient Receives all of it. The factory, which forwards it to the
     *        curve in the same transaction. Deliberately not recorded: a `CURVE`
     *        field set here would name the factory and read as though the factory
     *        were the curve, which is worse than having no field at all.
     */
    constructor(string memory name_, string memory symbol_, uint256 supply, address recipient)
        ERC20(name_, symbol_)
    {
        if (supply == 0) revert ZeroSupply();
        // A zero recipient would burn the entire supply at construction and leave a
        // token nobody can ever trade, which looks like a successful launch.
        if (recipient == address(0)) revert ZeroRecipient();

        TOTAL_SUPPLY = supply;
        _mint(recipient, supply);
    }
}
