/**
 * ABIs for the EVM contracts, written out rather than imported from Foundry's output.
 *
 * `evm/out` is a build artifact and is gitignored, so importing from it would make the
 * app's build depend on someone having run `forge build` first. These are the exact
 * signatures in `evm/src`, and `abi-matches-contracts.test.ts` reads those sources and
 * fails if a signature here names a function they do not have.
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
] as const;
