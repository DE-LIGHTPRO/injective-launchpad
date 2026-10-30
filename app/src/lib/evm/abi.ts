/**
 * ABIs for the EVM contracts, written out rather than imported from Foundry's output.
 *
 * `evm/out` is a build artifact and is gitignored, so importing from it would make the
 * app's build depend on someone having run `forge build` first. These are the exact
 * signatures in `evm/src`, and `abi-matches-contracts.test.ts` reads those sources and
 * fails if a signature here names a function they do not have.
 *
 * THE ERROR ENTRIES ARE NOT DECORATION, and leaving them out was a defect with no
 * symptom in any test. A Solidity custom error reaches the client as four bytes of
 * selector plus its arguments, and viem can only turn that into a NAME if the ABI
 * declares it. With functions alone, every revert came back as a bare "execution
 * reverted" with raw hex, so all seven branches in `errors.ts` that name a rule the
 * curve enforces - slippage, the wallet cap, trading not open, nothing to claim - were
 * dead the day they were written, and a trader got a generic sentence for a refusal
 * the contract had explained precisely. That is the same defect the CosmWasm slippage
 * branch had, one backend over.
 *
 * Measured, not assumed: `eth_call` of a buy with an impossible floor against the live
 * curve returned
 *
 *     0x71c4efed 0000…077ef4acfd79a0cb73a6 0000…0c9f2c9cd04674edea40000000
 *
 * and `keccak256("SlippageExceeded(uint256,uint256)")[0:4]` is `0x71c4efed`. The chain
 * sends what it says it sends; the ABI was the half that could not read it.
 *
 * Errors from the LIBRARIES are declared here too. `CurveMath` and `PoolMath` revert
 * through the curve, so their selectors arrive on a call to `buy` or `sell` and have
 * to be declared on the ABI the call was made with.
 */
export const FACTORY_ABI = [
  { type: 'function', name: 'launchCount', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'launches',
    inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'curve', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'creator', type: 'address' },
      { name: 'createdAt', type: 'uint64' },
    ],
    stateMutability: 'view',
  },
  { type: 'function', name: 'launchFee', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'platform', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'CURVE_SUPPLY', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'LP_RESERVE', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'VIRTUAL_TOKENS', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'createLaunch',
    inputs: [
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
          { name: 'virtualInj', type: 'uint256' },
          { name: 'graduationTarget', type: 'uint256' },
          { name: 'feeBps', type: 'uint256' },
          { name: 'feeSellBps', type: 'uint256' },
          { name: 'earlyFeeStartBps', type: 'uint256' },
          { name: 'earlyFeeSecs', type: 'uint256' },
          { name: 'tradeStart', type: 'uint256' },
          { name: 'maxPerWallet', type: 'uint256' },
          { name: 'rewardRoute', type: 'uint8' },
        ],
      },
    ],
    outputs: [
      { name: 'id', type: 'uint256' },
      { name: 'curve', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    stateMutability: 'payable',
  },
  /*
   * Needed by `parseEventLogs` after a creation: the new addresses come out of the
   * receipt rather than from a follow-up `launchCount() - 1` read, because two
   * creations in one block would make that read name somebody else's launch.
   */
  {
    type: 'event',
    name: 'LaunchCreated',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'curve', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: false },
      { name: 'name', type: 'string', indexed: false },
      { name: 'symbol', type: 'string', indexed: false },
    ],
  },

  /* The factory's errors. A creation refused for a reason the creator can act on. */
  { type: 'error', name: 'NotAdmin', inputs: [] },
  { type: 'error', name: 'NotPendingAdmin', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  {
    type: 'error',
    name: 'LaunchFeeTooHigh',
    inputs: [{ name: 'got', type: 'uint256' }, { name: 'max', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'WrongLaunchFee',
    inputs: [{ name: 'sent', type: 'uint256' }, { name: 'required', type: 'uint256' }],
  },
  { type: 'error', name: 'FeeForwardFailed', inputs: [] },
  { type: 'error', name: 'InvalidParams', inputs: [] },
  /*
   * `Graduated` and the two below reach a creation through `CurveMath.validate`, which
   * the factory runs on the parameters before anything is deployed. Added because the
   * guard asked for them, which is the point of deriving the list from the sources
   * rather than writing out the ones that came to mind.
   */
  { type: 'error', name: 'Graduated', inputs: [] },
  {
    type: 'error',
    name: 'InsufficientSold',
    inputs: [{ name: 'requested', type: 'uint256' }, { name: 'sold', type: 'uint256' }],
  },
  /* From the libraries and the token, which revert through `createLaunch`. */
  { type: 'error', name: 'ZeroSupply', inputs: [] },
  { type: 'error', name: 'ZeroRecipient', inputs: [] },
  { type: 'error', name: 'ZeroVirtualReserve', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  {
    type: 'error',
    name: 'InsufficientCurveSupply',
    inputs: [{ name: 'requested', type: 'uint256' }, { name: 'available', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'FeeTooHigh',
    inputs: [{ name: 'got', type: 'uint256' }, { name: 'max', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'UnreachableGraduation',
    inputs: [{ name: 'target', type: 'uint256' }, { name: 'reachable', type: 'uint256' }],
  },
  { type: 'error', name: 'Overflow', inputs: [] },
] as const;

export const CURVE_ABI = [
  { type: 'function', name: 'TOKEN', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'CREATOR', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'LP_RESERVE', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'REWARD_ROUTE', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'injCollected', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'tokensSold', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'graduated', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'migrated', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'poolQuote', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'poolTokens', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'platformOwed', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'creatorOwed', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'platformPaid', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'creatorPaid', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'lpBonus', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'currentFeeBps', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'currentSellFeeBps', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'MAX_PER_WALLET', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'TRADE_START', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'purchasedFromCurve',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'curveParams',
    inputs: [],
    outputs: [
      { name: 'virtualInj', type: 'uint256' },
      { name: 'virtualTokens', type: 'uint256' },
      { name: 'curveSupply', type: 'uint256' },
      { name: 'graduationTarget', type: 'uint256' },
      { name: 'feeBps', type: 'uint256' },
      { name: 'feeSellBps', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'quoteBuy',
    inputs: [{ type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'fee', type: 'uint256' },
          { name: 'injInAfterFee', type: 'uint256' },
          { name: 'tokensOut', type: 'uint256' },
          { name: 'refund', type: 'uint256' },
          { name: 'graduates', type: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'quoteSell',
    inputs: [{ type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'fee', type: 'uint256' },
          { name: 'injOut', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'buy',
    inputs: [
      { name: 'minTokensOut', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'sell',
    inputs: [
      { name: 'tokensIn', type: 'uint256' },
      { name: 'minInjOut', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'claimFees', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'graduate', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  /*
   * THE CURVE'S EVENTS, and their absence was the same defect as the missing errors
   * one block below: a log arrives as a topic hash plus data, and viem can only turn
   * it into a name and arguments if the ABI declares the event. With none,
   * `parseEventLogs` returned an empty array for every log it was given, so
   * `evm/trades.ts` reported zero trades for a launch whose own state says it has
   * traded - and it reported that confidently, over a window it really had read.
   *
   * Measured on the live PAD curve, 30 Oct 2026: `eth_getLogs` over the page after its
   * creation returns one log, and the trade reader saw none of it.
   *
   * `indexed` IS PART OF THE DECODING, not decoration: an indexed argument is in
   * `topics` and an unindexed one is in `data`, so getting it wrong does not fail, it
   * reads the wrong bytes as the wrong field. Taken from `Curve.sol` one for one, and
   * `abi-matches-contracts.test.ts` derives the list from that source.
   */
  {
    type: 'event',
    name: 'Bought',
    inputs: [
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'injIn', type: 'uint256', indexed: false },
      { name: 'tokensOut', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'refund', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Sold',
    inputs: [
      { name: 'seller', type: 'address', indexed: true },
      { name: 'tokensIn', type: 'uint256', indexed: false },
      { name: 'injOut', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Graduated',
    inputs: [
      { name: 'poolQuote', type: 'uint256', indexed: false },
      { name: 'poolTokens', type: 'uint256', indexed: false },
      { name: 'earlyFeePremium', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PoolBought',
    inputs: [
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'injIn', type: 'uint256', indexed: false },
      { name: 'tokensOut', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PoolSold',
    inputs: [
      { name: 'seller', type: 'address', indexed: true },
      { name: 'tokensIn', type: 'uint256', indexed: false },
      { name: 'injOut', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FeesClaimed',
    inputs: [
      { name: 'toCreator', type: 'uint256', indexed: false },
      { name: 'toPlatform', type: 'uint256', indexed: false },
    ],
  },
  /*
   * The curve's own errors, so viem can decode a revert into a name rather than hex.
   * `abi-matches-contracts.test.ts` reads these out of the Solidity, so an error
   * renamed there fails rather than silently going generic in `errors.ts`.
   */
  { type: 'error', name: 'NotReady', inputs: [] },
  /* V-04. Plain INJ sent to a curve would be unrecoverable, so the curve refuses it. */
  { type: 'error', name: 'DirectTransfersRefused', inputs: [] },
  { type: 'error', name: 'AlreadyGraduated', inputs: [] },
  { type: 'error', name: 'NotStarted', inputs: [] },
  {
    type: 'error',
    name: 'SlippageExceeded',
    inputs: [{ name: 'got', type: 'uint256' }, { name: 'wanted', type: 'uint256' }],
  },
  { type: 'error', name: 'NothingToClaim', inputs: [] },
  { type: 'error', name: 'TransferFailed', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  {
    type: 'error',
    name: 'OverWalletCap',
    inputs: [{ name: 'wanted', type: 'uint256' }, { name: 'allowance', type: 'uint256' }],
  },
  /*
   * From `CurveMath` and `PoolMath`. A library's revert travels up through the curve,
   * so its selector lands on a `buy` or `sell` call and must be declared on this ABI
   * to be readable at all.
   */
  { type: 'error', name: 'ZeroVirtualReserve', inputs: [] },
  { type: 'error', name: 'Graduated', inputs: [] },
  {
    type: 'error',
    name: 'InsufficientCurveSupply',
    inputs: [{ name: 'requested', type: 'uint256' }, { name: 'available', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'InsufficientSold',
    inputs: [{ name: 'requested', type: 'uint256' }, { name: 'sold', type: 'uint256' }],
  },
  { type: 'error', name: 'Overflow', inputs: [] },
  {
    type: 'error',
    name: 'FeeTooHigh',
    inputs: [{ name: 'got', type: 'uint256' }, { name: 'max', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'UnreachableGraduation',
    inputs: [{ name: 'target', type: 'uint256' }, { name: 'reachable', type: 'uint256' }],
  },
  { type: 'error', name: 'PoolEmpty', inputs: [] },
] as const;

export const ERC20_ABI = [
  { type: 'function', name: 'name', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'allowance',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  /*
   * OpenZeppelin v5's errors. A sell can hit either between the approval and the sale:
   * the allowance is exact, so a second sell in the same session has none left yet.
   */
  {
    type: 'error',
    name: 'ERC20InsufficientBalance',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'balance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'ERC20InsufficientAllowance',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'allowance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
] as const;
