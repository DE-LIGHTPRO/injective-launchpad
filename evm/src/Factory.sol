// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LaunchToken} from "./LaunchToken.sol";
import {Curve} from "./Curve.sol";
import {CurveMath} from "./CurveMath.sol";
import {EarlyFee} from "./PoolMath.sol";

/**
 * @title Factory
 * @notice Creates launches: one token and one curve per launch, atomically.
 *         Ported from `contracts/factory`.
 *
 * WHAT THE ADMIN CAN AND CANNOT DO. It sets what FUTURE launches look like: the
 * launch fee and the platform fee recipient. It cannot touch a launch that already
 * exists. Every curve is constructed with its parameters immutable and has no owner,
 * so a launch created yesterday is out of reach of anything decided today. That is
 * the same boundary the CosmWasm factory draws and it is the one that matters: a
 * creator and a buyer are agreeing to the terms in force at creation, not to whatever
 * the platform later prefers.
 *
 * THE CIRCULAR DEPENDENCY, AND HOW IT IS RESOLVED. The curve needs the token's
 * address to trade it; the token needs the curve's address to be minted to it. The
 * first version of this passed `address(0)` to the curve with a comment saying it was
 * replaced below, and nothing replaced it: `TOKEN` is immutable, so every launch
 * would have been born pointing at the zero address, and it compiled without a
 * warning.
 *
 * Resolved by minting to the factory and transferring in the same call. The factory
 * therefore does hold the supply, for three statements inside one atomic
 * transaction: nothing can interleave, and if the transfer failed the whole launch
 * would revert. That is weaker than "never holds it" and it is what actually
 * happens, which is the version worth writing down.
 */
contract Factory {
    /// Fixed supply for every launch. 1,000,000,000 tokens at 18 decimals.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// Sellable on the curve. The remainder is the LP reserve.
    uint256 public constant CURVE_SUPPLY = 800_000_000e18;
    uint256 public constant LP_RESERVE = TOTAL_SUPPLY - CURVE_SUPPLY;

    /// Curve shape. Chosen so the graduation target is reachable before supply runs out.
    uint256 public constant VIRTUAL_TOKENS = 1_073_000_000e18;

    /// Share of each fee to the creator. The remainder is the platform's.
    uint256 public constant CREATOR_FEE_SHARE_BPS = 7_000;

    /// Refused above this, matching the CosmWasm cap.
    uint256 public constant MAX_LAUNCH_FEE = 5 ether;

    address public admin;
    address public pendingAdmin;
    address public platform;
    /// What a creator pays to open a launch, forwarded to `platform` in the same call.
    uint256 public launchFee;

    struct Launch {
        address curve;
        address token;
        address creator;
        uint64 createdAt;
    }

    Launch[] public launches;
    /// So a token address resolves to its launch without scanning.
    mapping(address => uint256) public launchIdByToken;

    event LaunchCreated(
        uint256 indexed id,
        address indexed curve,
        address indexed token,
        address creator,
        string name,
        string symbol
    );
    event LaunchFeeSet(uint256 oldFee, uint256 newFee);
    event PlatformSet(address oldPlatform, address newPlatform);
    event AdminTransferStarted(address from, address to);
    event AdminTransferred(address from, address to);

    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAddress();
    error LaunchFeeTooHigh(uint256 got, uint256 max);
    error WrongLaunchFee(uint256 sent, uint256 required);
    error FeeForwardFailed();
    error InvalidParams();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address admin_, address platform_, uint256 launchFee_) {
        if (admin_ == address(0) || platform_ == address(0)) revert ZeroAddress();
        if (launchFee_ > MAX_LAUNCH_FEE) revert LaunchFeeTooHigh(launchFee_, MAX_LAUNCH_FEE);
        admin = admin_;
        platform = platform_;
        launchFee = launchFee_;
    }

    function launchCount() external view returns (uint256) {
        return launches.length;
    }

    struct CreateParams {
        string name;
        string symbol;
        /// Virtual INJ reserve. Sets the opening price.
        uint256 virtualInj;
        /// INJ collected at which the curve graduates.
        uint256 graduationTarget;
        /// Trading fee in bps.
        uint256 feeBps;
        /// Opening fee premium, decaying to `feeBps`. Zero seconds disables it.
        uint256 earlyFeeStartBps;
        uint256 earlyFeeSecs;
        /// When buying opens. Zero means now.
        uint256 tradeStart;
        Curve.RewardRoute rewardRoute;
    }

    /**
     * Create a launch. The caller is the creator and receives the creator fee share.
     *
     * `msg.value` must equal `launchFee` exactly. Not "at least": accepting more and
     * keeping the difference is a way to overcharge by accident, and refunding the
     * difference is a second value transfer in a function that does not otherwise
     * need one.
     */
    function createLaunch(CreateParams calldata p) external payable returns (uint256 id, address curve, address token) {
        if (msg.value != launchFee) revert WrongLaunchFee(msg.value, launchFee);
        if (bytes(p.name).length == 0 || bytes(p.symbol).length == 0) revert InvalidParams();
        if (p.earlyFeeSecs > 0 && p.earlyFeeStartBps > EarlyFee.MAX_EARLY_FEE_BPS) {
            revert InvalidParams();
        }

        uint256 start = p.tradeStart == 0 ? block.timestamp : p.tradeStart;

        // Minted to the factory, because the curve does not exist yet to receive it.
        LaunchToken t = new LaunchToken(p.name, p.symbol, TOTAL_SUPPLY, address(this));
        token = address(t);

        Curve c = new Curve(
            Curve.Params({
                token: token,
                creator: msg.sender,
                platform: platform,
                lpReserve: LP_RESERVE,
                creatorFeeShareBps: CREATOR_FEE_SHARE_BPS,
                rewardRoute: p.rewardRoute,
                tradeStart: start,
                virtualInj: p.virtualInj,
                virtualTokens: VIRTUAL_TOKENS,
                curveSupply: CURVE_SUPPLY,
                graduationTarget: p.graduationTarget,
                feeBps: p.feeBps,
                earlyFeeStartBps: p.earlyFeeStartBps,
                earlyFeeSecs: p.earlyFeeSecs
            })
        );
        curve = address(c);

        /*
         * Handed over immediately. A failure here reverts the launch rather than
         * leaving a curve with no tokens to sell, which would look like a live
         * launch and quote prices for a supply it does not hold.
         */
        t.transfer(curve, TOTAL_SUPPLY);

        id = launches.length;
        launches.push(Launch({curve: curve, token: token, creator: msg.sender, createdAt: uint64(block.timestamp)}));
        launchIdByToken[token] = id;

        if (msg.value > 0) {
            (bool ok,) = platform.call{value: msg.value}("");
            if (!ok) revert FeeForwardFailed();
        }

        emit LaunchCreated(id, curve, token, msg.sender, p.name, p.symbol);
    }

    // ------------------------------------------------------------- admin --

    function setLaunchFee(uint256 fee) external onlyAdmin {
        if (fee > MAX_LAUNCH_FEE) revert LaunchFeeTooHigh(fee, MAX_LAUNCH_FEE);
        emit LaunchFeeSet(launchFee, fee);
        launchFee = fee;
    }

    function setPlatform(address p) external onlyAdmin {
        if (p == address(0)) revert ZeroAddress();
        emit PlatformSet(platform, p);
        platform = p;
    }

    /**
     * Two-step admin handover.
     *
     * One step hands the whole factory to a typo. The second step proves the new
     * address exists and can transact, which a bech32-shaped or hex-shaped string
     * does not.
     */
    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        pendingAdmin = to;
        emit AdminTransferStarted(admin, to);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }
}
