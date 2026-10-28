// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {CurveMath} from "./CurveMath.sol";
import {PoolMath, EarlyFee} from "./PoolMath.sol";

/**
 * @title Curve
 * @notice One launch: a bonding curve that graduates into a locked pool.
 *         Ported from `contracts/curve`.
 *
 * NO OWNER, NO UPGRADE PATH, NO WITHDRAW. Everything this contract will ever do is
 * in this file. That is the whole product promise: "liquidity locked at graduation"
 * is true because there is no function that could move it, not because a key was
 * handed somewhere safe.
 *
 * The quote asset is native INJ, which on Injective's EVM is the gas token at 18
 * decimals. Sells and pool trades pay out with `call`, guarded by nonReentrant and
 * ordered so state is written before value moves.
 *
 * TWO PHASES, AND THEY ARE NOT THE SAME MARKET.
 *
 *  Curve phase. Buyers pay INJ, the price follows a constant product over VIRTUAL
 *  reserves so the first buy has a sane price with nobody having deposited, and the
 *  creator supplies only tokens. Sells are paid out of `injCollected`, never out of
 *  fees: a fee claim can never eat the INJ backing outstanding tokens.
 *
 *  Pool phase. At graduation the collected INJ and the untouched LP reserve become a
 *  constant-product pool over REAL reserves, in this contract, with no withdrawal
 *  path. `graduated` and `migrated` are separate flags so seeding can never run
 *  twice.
 */
contract Curve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------ config --

    IERC20 public immutable TOKEN;
    address public immutable CREATOR;
    address public immutable PLATFORM;
    address public immutable FACTORY;

    /// Tokens held back from the curve, reserved to pair against collected INJ.
    uint256 public immutable LP_RESERVE;

    /// Share of each fee going to the creator, in bps of the fee itself.
    uint256 public immutable CREATOR_FEE_SHARE_BPS;

    /// Where the creator's share goes. Immutable: a route flipped mid-flight would
    /// divert fees buyers were told went to the pool.
    enum RewardRoute {
        Creator,
        Pool
    }

    RewardRoute public immutable REWARD_ROUTE;

    /// When buying became possible. The early-fee decay is measured from here.
    uint256 public immutable TRADE_START;

    uint256 private immutable _VIRTUAL_INJ;
    uint256 private immutable _VIRTUAL_TOKENS;
    uint256 private immutable _CURVE_SUPPLY;
    uint256 private immutable _GRADUATION_TARGET;
    uint256 private immutable _FEE_BPS;
    uint256 private immutable _EARLY_FEE_START_BPS;
    uint256 private immutable _EARLY_FEE_SECS;

    // ------------------------------------------------------------- state --

    /// INJ held as curve reserve. Sells are paid out of this, never out of fees.
    uint256 public injCollected;
    uint256 public tokensSold;
    bool public graduated;
    /// Separate from `graduated` so seeding can never run twice.
    bool public migrated;

    /// Locked pool reserves, zero until `migrated`. Nothing can withdraw these.
    uint256 public poolQuote;
    uint256 public poolTokens;

    /// Accrued, unclaimed. Kept apart from the reserve on purpose.
    uint256 public platformOwed;
    uint256 public creatorOwed;

    /// Lifetime totals actually PAID OUT, which `*Owed` cannot answer after a claim.
    uint256 public platformPaid;
    uint256 public creatorPaid;

    /// The opening-fee premium and Pool-routed creator fees, held for the pool.
    /// Deliberately NOT in `injCollected`: adding quote without issuing tokens would
    /// move every later price on the curve.
    uint256 public lpBonus;

    // ------------------------------------------------------------ events --

    event Bought(address indexed buyer, uint256 injIn, uint256 tokensOut, uint256 fee, uint256 refund);
    event Sold(address indexed seller, uint256 tokensIn, uint256 injOut, uint256 fee);
    event Graduated(uint256 poolQuote, uint256 poolTokens, uint256 earlyFeePremium);
    event PoolBought(address indexed buyer, uint256 injIn, uint256 tokensOut, uint256 fee);
    event PoolSold(address indexed seller, uint256 tokensIn, uint256 injOut, uint256 fee);
    event FeesClaimed(uint256 toCreator, uint256 toPlatform);

    // ------------------------------------------------------------ errors --

    error NotReady();
    error AlreadyGraduated();
    error NotStarted();
    error SlippageExceeded(uint256 got, uint256 wanted);
    error NothingToClaim();
    error TransferFailed();
    error ZeroAmount();

    struct Params {
        address token;
        address creator;
        address platform;
        uint256 lpReserve;
        uint256 creatorFeeShareBps;
        RewardRoute rewardRoute;
        uint256 tradeStart;
        uint256 virtualInj;
        uint256 virtualTokens;
        uint256 curveSupply;
        uint256 graduationTarget;
        uint256 feeBps;
        uint256 earlyFeeStartBps;
        uint256 earlyFeeSecs;
    }

    constructor(Params memory p) {
        FACTORY = msg.sender;
        TOKEN = IERC20(p.token);
        CREATOR = p.creator;
        PLATFORM = p.platform;
        LP_RESERVE = p.lpReserve;
        CREATOR_FEE_SHARE_BPS = p.creatorFeeShareBps;
        REWARD_ROUTE = p.rewardRoute;
        TRADE_START = p.tradeStart;

        _VIRTUAL_INJ = p.virtualInj;
        _VIRTUAL_TOKENS = p.virtualTokens;
        _CURVE_SUPPLY = p.curveSupply;
        _GRADUATION_TARGET = p.graduationTarget;
        _FEE_BPS = p.feeBps;
        _EARLY_FEE_START_BPS = p.earlyFeeStartBps;
        _EARLY_FEE_SECS = p.earlyFeeSecs;

        // Rejects an unreachable graduation target and a curve supply at or above the
        // virtual reserve, among others. Done here so a bad launch cannot exist.
        CurveMath.validate(_cfg(p.feeBps));
    }

    // ----------------------------------------------------------- reading --

    function _cfg(uint256 feeBps) private view returns (CurveMath.Config memory) {
        return CurveMath.Config({
            virtualInj: _VIRTUAL_INJ,
            virtualTokens: _VIRTUAL_TOKENS,
            curveSupply: _CURVE_SUPPLY,
            graduationTarget: _GRADUATION_TARGET,
            feeBps: feeBps
        });
    }

    function _state() private view returns (CurveMath.State memory) {
        return CurveMath.State({injCollected: injCollected, tokensSold: tokensSold, graduated: graduated});
    }

    /**
     * The fee in bps right now, including any opening premium still decaying.
     *
     * Separate from the handlers so the decay is reachable at its own boundaries. A
     * test cannot easily land a trade on an exact second of it otherwise.
     */
    function currentFeeBps() public view returns (uint256) {
        if (_EARLY_FEE_SECS == 0) return _FEE_BPS;
        uint256 elapsed = block.timestamp > TRADE_START ? block.timestamp - TRADE_START : 0;
        return EarlyFee.bpsAt(
            EarlyFee.Schedule({startBps: _EARLY_FEE_START_BPS, secs: _EARLY_FEE_SECS}), _FEE_BPS, elapsed
        );
    }

    function quoteBuy(uint256 injIn) external view returns (CurveMath.BuyQuote memory) {
        return CurveMath.quoteBuy(_cfg(currentFeeBps()), _state(), injIn);
    }

    function quoteSell(uint256 tokensIn) external view returns (CurveMath.SellQuote memory) {
        return CurveMath.quoteSell(_cfg(currentFeeBps()), _state(), tokensIn);
    }

    function poolReserves() public view returns (PoolMath.Reserves memory) {
        return PoolMath.Reserves({quote: poolQuote, tokens: poolTokens});
    }

    // ------------------------------------------------------- fee routing --

    /**
     * Split a fee and route the creator's share.
     *
     * The platform's share is never routed: it is the launchpad's and the creator
     * does not get to redirect it. Only the creator's portion follows the route they
     * chose at launch, which is the point of offering the choice.
     */
    function _takeFee(uint256 fee) private {
        if (fee == 0) return;
        uint256 creatorCut = (fee * CREATOR_FEE_SHARE_BPS) / CurveMath.BPS_DENOM;
        uint256 platformCut = fee - creatorCut;
        platformOwed += platformCut;

        if (REWARD_ROUTE == RewardRoute.Creator) {
            creatorOwed += creatorCut;
        } else if (migrated) {
            /*
             * WHERE "THE POOL" IS DEPENDS ON WHETHER IT EXISTS YET.
             *
             * After graduation there is no later pairing to wait for, and `lpBonus`
             * has exactly one consumer which runs once and refuses to run again. The
             * CosmWasm version left post-graduation Pool-routed fees in that bucket
             * where nothing could ever move them: not claimable, not part of any
             * reserve, just quote sitting against a counter that only goes up.
             *
             * So it goes into the pool's reserve directly, a one-sided quote add that
             * deepens the market and raises the token's price, which is what the
             * route promises. k only grows and the pool has no withdraw path, so it
             * is locked exactly as the rest of it is.
             */
            poolQuote += creatorCut;
        } else {
            lpBonus += creatorCut;
        }
    }

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // -------------------------------------------------------------- buy --

    function buy(uint256 minTokensOut, address recipient) external payable nonReentrant {
        if (block.timestamp < TRADE_START) revert NotStarted();
        if (msg.value == 0) revert ZeroAmount();
        address to = recipient == address(0) ? msg.sender : recipient;

        if (migrated) {
            _poolBuy(to, minTokensOut);
            return;
        }

        uint256 feeBps = currentFeeBps();
        CurveMath.BuyQuote memory q = CurveMath.quoteBuy(_cfg(feeBps), _state(), msg.value);
        if (q.tokensOut < minTokensOut) revert SlippageExceeded(q.tokensOut, minTokensOut);

        /*
         * THE OPENING PREMIUM IS HELD FOR THE POOL, NOT TAKEN AS A FEE.
         *
         * The fee actually charged may exceed the curve's base fee while the decay
         * runs. Only the base-rate portion is split between creator and platform;
         * the premium above it goes to `lpBonus` and is paired into the liquidity at
         * graduation. Folding it into the split would make an early buyer's extra
         * cost someone's income, which is not what the premium is for.
         */
        uint256 baseFee = CurveMath.feeOn(msg.value, _FEE_BPS);
        if (baseFee > q.fee) baseFee = q.fee;
        uint256 premium = q.fee - baseFee;

        injCollected += q.injInAfterFee;
        tokensSold += q.tokensOut;
        lpBonus += premium;
        _takeFee(baseFee);

        bool nowGraduates = q.graduates;
        if (nowGraduates) {
            graduated = true;
            _seedPool();
        }

        TOKEN.safeTransfer(to, q.tokensOut);
        if (q.refund > 0) _pay(msg.sender, q.refund);

        emit Bought(to, msg.value - q.refund, q.tokensOut, q.fee, q.refund);
    }

    // ------------------------------------------------------------- sell --

    function sell(uint256 tokensIn, uint256 minInjOut) external nonReentrant {
        if (tokensIn == 0) revert ZeroAmount();

        if (migrated) {
            _poolSell(tokensIn, minInjOut);
            return;
        }

        uint256 feeBps = currentFeeBps();
        CurveMath.SellQuote memory q = CurveMath.quoteSell(_cfg(feeBps), _state(), tokensIn);
        if (q.injOut < minInjOut) revert SlippageExceeded(q.injOut, minInjOut);

        uint256 gross = q.injOut + q.fee;
        uint256 baseFee = CurveMath.feeOn(gross, _FEE_BPS);
        if (baseFee > q.fee) baseFee = q.fee;

        injCollected -= gross;
        tokensSold -= tokensIn;
        lpBonus += q.fee - baseFee;
        _takeFee(baseFee);

        // Pulled before paying out: state is settled, then value moves.
        TOKEN.safeTransferFrom(msg.sender, address(this), tokensIn);
        _pay(msg.sender, q.injOut);

        emit Sold(msg.sender, tokensIn, q.injOut, q.fee);
    }

    // -------------------------------------------------------- graduation --

    /**
     * Seed the locked pool. Permissionless, like `claimFees`.
     *
     * Normally runs inside the buy that reaches the target. Exposed as well because a
     * curve that sold out without anyone's buy tripping the flag would otherwise sit
     * un-migrated, and nobody should need permission to finish it.
     */
    function graduate() external nonReentrant {
        _seedPool();
    }

    function _seedPool() private {
        if (migrated) revert AlreadyGraduated();
        if (!graduated && injCollected < _GRADUATION_TARGET) revert NotReady();

        uint256 quote = injCollected + lpBonus;
        uint256 unsold = _CURVE_SUPPLY > tokensSold ? _CURVE_SUPPLY - tokensSold : 0;
        uint256 tokens = LP_RESERVE + unsold;

        uint256 premium = lpBonus;

        graduated = true;
        migrated = true;
        injCollected = 0;
        lpBonus = 0;
        tokensSold = _CURVE_SUPPLY;
        poolQuote = quote;
        poolTokens = tokens;

        emit Graduated(quote, tokens, premium);
    }

    // ------------------------------------------------------ pool trading --

    /**
     * A buy against the locked pool. No wallet cap, no start time, no opening
     * premium: those are launch-window rules and they expire with the curve.
     */
    function _poolBuy(address to, uint256 minTokensOut) private {
        PoolMath.BuyQuote memory q = PoolMath.quoteBuy(poolReserves(), _FEE_BPS, msg.value);
        if (q.tokensOut < minTokensOut) revert SlippageExceeded(q.tokensOut, minTokensOut);

        poolQuote += q.quoteInAfterFee;
        poolTokens -= q.tokensOut;
        _takeFee(q.fee);

        TOKEN.safeTransfer(to, q.tokensOut);
        emit PoolBought(to, msg.value, q.tokensOut, q.fee);
    }

    function _poolSell(uint256 tokensIn, uint256 minInjOut) private {
        PoolMath.SellQuote memory q = PoolMath.quoteSell(poolReserves(), _FEE_BPS, tokensIn);
        if (q.quoteOut < minInjOut) revert SlippageExceeded(q.quoteOut, minInjOut);

        poolQuote -= (q.quoteOut + q.fee);
        poolTokens += tokensIn;
        _takeFee(q.fee);

        TOKEN.safeTransferFrom(msg.sender, address(this), tokensIn);
        _pay(msg.sender, q.quoteOut);
        emit PoolSold(msg.sender, tokensIn, q.quoteOut, q.fee);
    }

    // ------------------------------------------------------------ claims --

    /**
     * Pay out accrued fees. Checks no sender, deliberately.
     *
     * The recipients are fixed at construction and this cannot redirect a unit of it,
     * so the worst an unattended caller does is spend their own gas. That is what
     * makes a keeper safe to run, and it means a creator is never dependent on the
     * platform to be paid.
     */
    function claimFees() external nonReentrant {
        uint256 toCreator = creatorOwed;
        uint256 toPlatform = platformOwed;
        if (toCreator == 0 && toPlatform == 0) revert NothingToClaim();

        creatorOwed = 0;
        platformOwed = 0;
        creatorPaid += toCreator;
        platformPaid += toPlatform;

        _pay(CREATOR, toCreator);
        _pay(PLATFORM, toPlatform);
        emit FeesClaimed(toCreator, toPlatform);
    }

    /**
     * Accepts INJ sent directly, which is a donation and nothing else.
     *
     * It is not credited to any reserve or to anyone's balance, because crediting it
     * would let someone move the curve's price with a plain transfer. It simply
     * raises the contract balance above what the accounting owes, which
     * `scripts/verify-solvency` reports as a surplus rather than a defect.
     */
    receive() external payable {}
}
