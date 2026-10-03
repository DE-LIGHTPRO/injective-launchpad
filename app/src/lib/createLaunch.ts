import { validate, type CurveConfig } from './curve.ts';
import { NETWORK } from './config.ts';

/**
 * The messages that create a launch, built as data so they can be tested.
 *
 * Creating a launch is three messages in one transaction, and the order matters:
 *
 *   1. `MsgCreateDenom`   makes `factory/<creator>/<subdenom>`
 *   2. `MsgMint`          mints `curve_supply + lp_reserve` to the creator
 *   3. `MsgExecuteContract` CreateLaunch, with that whole amount attached
 *
 * The factory refuses anything but the exact amount, and nothing mints later, so
 * a launch that gets this wrong either fails outright or, worse, succeeds with a
 * supply the curve cannot honour. That is why the construction lives here as a
 * pure function with tests rather than inside a signing call where nothing can
 * reach it. Two defects in sibling projects came from exactly that shape: a quote
 * that built the wrong transaction, and a deposit address that needed a contract
 * call rather than a transfer.
 *
 * NOT YET BROADCAST. These messages have never been signed against a chain. They
 * are verified against the contract's own expectations (the factory's
 * `CreateLaunch` arm and its seed check) and against Injective's documented
 * tokenfactory message types, not against a node. The form shows them to the user
 * before anything is signed for that reason.
 */

export const MSG_CREATE_DENOM = '/injective.tokenfactory.v1beta1.MsgCreateDenom';
export const MSG_MINT = '/injective.tokenfactory.v1beta1.MsgMint';
export const MSG_EXECUTE = '/cosmwasm.wasm.v1.MsgExecuteContract';

export interface LaunchPlan {
  /** `factory/<creator>/<subdenom>`, which the chain derives and we must match. */
  denom: string;
  /** Exactly what the factory will require to be attached. */
  seedAmount: bigint;
  messages: Array<{ typeUrl: string; value: Record<string, unknown> }>;
}

export interface LaunchInput {
  creator: string;
  /** The ticker, which becomes the subdenom. */
  symbol: string;
  curve: CurveConfig;
  lpReserve: bigint;
  creatorFeeShareBps: number;
  factory: string;
}

export class LaunchInputError extends Error {
  readonly field: keyof LaunchInput | 'symbol' | 'lpReserve' | 'creatorFeeShareBps' | 'curve';
  constructor(field: LaunchInputError['field'], message: string) {
    super(message);
    this.name = 'LaunchInputError';
    this.field = field;
  }
}

/**
 * Tokenfactory subdenoms are not tickers.
 *
 * The chain accepts `[a-zA-Z0-9/:._-]` and caps the full denom at 128 bytes, so a
 * ticker with a space or an emoji produces a denom the chain refuses at the first
 * message, after the user has filled in a whole form. Checked here, before
 * anything is signed, and the rule is stated rather than implied.
 */
const SUBDENOM_OK = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,43}$/;

export function denomFor(creator: string, symbol: string): string {
  return `factory/${creator}/${symbol}`;
}

/**
 * Everything the form must get right, refused one reason at a time.
 *
 * Ordered so the first failure is the one a user can act on: a bad ticker before
 * a bad curve, because the ticker is what they typed and the curve is mostly
 * defaults.
 */
export function validateLaunch(input: LaunchInput): void {
  if (!/^inj1[0-9a-z]{38,}$/.test(input.creator)) {
    throw new LaunchInputError('creator', 'Connect an Injective wallet first.');
  }
  if (!SUBDENOM_OK.test(input.symbol)) {
    throw new LaunchInputError(
      'symbol',
      'A ticker can use letters, digits, dot, dash and underscore, must start with a letter or digit, and is 2 to 44 characters.',
    );
  }
  const denom = denomFor(input.creator, input.symbol);
  // The chain's own limit. A denom over it is rejected at MsgCreateDenom.
  if (new TextEncoder().encode(denom).length > 128) {
    throw new LaunchInputError('symbol', 'That ticker makes the denom longer than the chain allows.');
  }
  if (!/^inj1[0-9a-z]{38,}$/.test(input.factory)) {
    throw new LaunchInputError('factory', 'This launchpad has no factory configured.');
  }
  if (!Number.isInteger(input.creatorFeeShareBps) || input.creatorFeeShareBps < 0 || input.creatorFeeShareBps > 10_000) {
    throw new LaunchInputError('creatorFeeShareBps', 'The creator fee share is a whole number of basis points, 0 to 10000.');
  }
  if (input.lpReserve < 0n) {
    throw new LaunchInputError('lpReserve', 'The liquidity reserve cannot be negative.');
  }
  if (input.lpReserve === 0n) {
    /*
     * Allowed by the contract and almost always a mistake. With no reserve the
     * curve can sell out exactly and graduate with quote but no token side, so
     * the migrated pool has nothing to pair. The contract tolerates it because an
     * operator may have a reason; the form should not produce it silently.
     */
    throw new LaunchInputError(
      'lpReserve',
      'With no liquidity reserve a sold-out curve graduates with nothing to pair against. Set some aside.',
    );
  }

  // The curve's own rules, which the contract checks again on both sides.
  try {
    validate(input.curve);
  } catch (e) {
    throw new LaunchInputError('curve', (e as Error).message);
  }

  /*
   * NO SEPARATE REACHABILITY CHECK, and the absence is deliberate.
   *
   * I wrote one here: `graduationTarget > maxCollectable(curve)` with its own
   * message about a launch that could never graduate. It was unreachable.
   * `validate` above tests the identical condition on its last line and throws
   * first, with a clearer sentence. The comment I had written claimed the curve
   * validator missed this case because the two values are individually legal,
   * and that was simply false; I had not run it.
   *
   * Third unreachable branch on this project, after a Result<Option> whose None
   * no input could produce and a clamp the arithmetic could never reach. The
   * pattern is adding a defensive check without first testing whether anything
   * gets to it, so the rule is now: write the test that reaches the branch
   * before writing the branch.
   */
}

/** What the factory requires to be attached, which is the whole minted supply. */
export function seedAmount(curve: CurveConfig, lpReserve: bigint): bigint {
  return curve.curveSupply + lpReserve;
}

export function planLaunch(input: LaunchInput): LaunchPlan {
  validateLaunch(input);

  const denom = denomFor(input.creator, input.symbol);
  const seed = seedAmount(input.curve, input.lpReserve);

  /*
   * `curve` goes on the wire as decimal strings, because that is how
   * `CurveConfigStored` deserialises Uint128 and because JSON has no integer wide
   * enough: 800,000,000 tokens at 18 decimals is 8e26, and a Number loses it.
   */
  const curveMsg = {
    virtual_inj: input.curve.virtualInj.toString(),
    virtual_tokens: input.curve.virtualTokens.toString(),
    curve_supply: input.curve.curveSupply.toString(),
    graduation_target: input.curve.graduationTarget.toString(),
    fee_bps: Number(input.curve.feeBps),
  };

  return {
    denom,
    seedAmount: seed,
    messages: [
      {
        typeUrl: MSG_CREATE_DENOM,
        value: { sender: input.creator, subdenom: input.symbol },
      },
      {
        typeUrl: MSG_MINT,
        // Minted to the creator, who then attaches it. The factory never holds
        // launch funds, which is the property its own tests assert.
        value: { sender: input.creator, amount: { denom, amount: seed.toString() } },
      },
      {
        typeUrl: MSG_EXECUTE,
        value: {
          sender: input.creator,
          contract: input.factory,
          msg: {
            create_launch: {
              denom,
              lp_reserve: input.lpReserve.toString(),
              creator_fee_share_bps: input.creatorFeeShareBps,
              curve: curveMsg,
            },
          },
          // The whole supply, in the denom just minted. The factory refuses any
          // other amount, so this is not a default to adjust.
          funds: [{ denom, amount: seed.toString() }],
        },
      },
    ],
  };
}

/** A human summary of what signing would do, shown before it is signed. */
export function describePlan(plan: LaunchPlan, curve: CurveConfig, lpReserve: bigint): string[] {
  const whole = (v: bigint) => (v / 10n ** 18n).toLocaleString('en-US');
  return [
    `Create the denom ${plan.denom}`,
    `Mint ${whole(plan.seedAmount)} tokens to you, and nothing can mint more afterwards`,
    `Send all ${whole(plan.seedAmount)} to the launchpad: ${whole(curve.curveSupply)} onto the curve and ${whole(lpReserve)} held back to pair at graduation`,
    `Buyers pay ${NETWORK.quoteSymbol} and the curve prices every trade until it reaches the target`,
  ];
}
