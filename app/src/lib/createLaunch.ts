import { validate, type CurveConfig } from './curve.ts';
import { NETWORK } from './config.ts';
import { profileFieldError } from './tokenProfile.ts';

/**
 * The messages that create a launch, built as data so they can be tested.
 *
 * Creating a launch is four messages in one transaction, and the order matters:
 *
 *   1. `MsgCreateDenom`      makes `factory/<creator>/<subdenom>`
 *   2. `MsgMint`             mints `curve_supply + lp_reserve` to the creator
 *   3. `MsgSetDenomMetadata` names it, and declares the 18-decimal display unit
 *   4. `MsgExecuteContract`  CreateLaunch, with that whole amount attached
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
export const MSG_SET_METADATA = '/injective.tokenfactory.v1beta1.MsgSetDenomMetadata';
export const MSG_EXECUTE = '/cosmwasm.wasm.v1.MsgExecuteContract';

/**
 * Tokens are 18 decimals here, and the metadata has to say so.
 *
 * This is the detail almost every tokenfactory launch gets wrong. Of the 737
 * factory denoms on Injective testnet that bother to set a name, the ones sampled
 * carry `display: ""` and a single denom unit at exponent 0, which tells every
 * wallet and explorer that the base unit IS the display unit. The holder then sees
 * `1000000000000000000000` where they hold a thousand tokens.
 *
 * Correct metadata declares two units: the base at exponent 0, which is what the
 * chain moves, and a display unit at 18, which is what a person reads. Wallets
 * divide by the display exponent, so getting this wrong is not cosmetic, it is
 * every balance in the ecosystem being wrong by eighteen orders of magnitude.
 */
export const TOKEN_DECIMALS = 18;

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
  /** Human name for wallets and explorers. Defaults to the ticker when empty. */
  name?: string;
  /** One line a holder reads in their wallet. Optional, and empty is honest. */
  description?: string;
  /**
   * Image and links, stored in the FACTORY rather than in bank metadata.
   *
   * Bank metadata is where this belongs and it cannot be read back: measured against
   * Injective, a per-denom `denoms_metadata` read returns 501 and the list is 2000+
   * entries across pages. The contract is queryable, so identity lives there and bank
   * metadata is still set for wallets that read it their own way.
   *
   * Validated by `profileFieldError` before the plan is built and again by the contract,
   * because these end up as `href` and `src` in a browser.
   */
  profile?: Record<string, string>;
  /**
   * Trading rules the curve enforces until graduation. Absent means an open launch.
   *
   * Validated by `validateRules` before the plan is built and by the contract again.
   * Never described to a user as a property of the token: see `launchRules.ts`.
   */
  // `unknown` because `early_fee` is a nested object while the others are strings;
  // narrowing to `string` here was what made the rules field quietly reject it.
  rules?: Record<string, unknown>;
  /**
   * Quote the creator spends on their own launch, in the same transaction.
   *
   * Base units. Attached alongside the token seed, so the factory is never funded
   * separately and never holds anything between transactions.
   */
  initialBuy?: bigint;
  curve: CurveConfig;
  lpReserve: bigint;
  factory: string;
}

export class LaunchInputError extends Error {
  readonly field:
    | keyof LaunchInput
    | 'symbol'
    | 'lpReserve'
    | 'curve'
    | 'profile'
    | 'rules';
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
  for (const [field, value] of Object.entries(input.profile ?? {})) {
    const problem = profileFieldError(value);
    if (problem) throw new LaunchInputError('profile', `${field}: ${problem}`);
  }
  if (!/^inj1[0-9a-z]{38,}$/.test(input.factory)) {
    throw new LaunchInputError('factory', 'This launchpad has no factory configured.');
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
   * The curve is no longer sent. It used to go on the wire as decimal strings, since
   * `CurveConfigStored` deserialises Uint128 that way and JSON has no integer wide
   * enough for 8e26. The factory builds the shape from its own constants now, so the
   * only number that crosses is the fee, and `curveMsg` went with it rather than
   * being left as an unused local that `tsc` would not have complained about.
   */
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
        /*
         * Set before the supply leaves the creator's wallet, because they are the
         * denom admin and `CreateLaunch` is what hands that supply away. Setting
         * it afterwards still works today, but ordering it here keeps the whole
         * launch in one transaction that either lands complete or not at all.
         */
        typeUrl: MSG_SET_METADATA,
        value: {
          sender: input.creator,
          metadata: {
            description: (input.description ?? '').trim(),
            denom_units: [
              // What the chain moves.
              { denom, exponent: 0, aliases: [] },
              // What a person reads. Wallets divide by this.
              { denom: input.symbol, exponent: TOKEN_DECIMALS, aliases: [] },
            ],
            base: denom,
            // `display` must name one of the units above or wallets fall back to
            // the base and show raw integers.
            display: input.symbol,
            name: (input.name ?? '').trim() || input.symbol,
            symbol: input.symbol,
            uri: '',
            uri_hash: '',
          },
        },
      },
      {
        typeUrl: MSG_EXECUTE,
        value: {
          sender: input.creator,
          contract: input.factory,
          msg: {
            create_launch: {
              denom,
              // Omitted entirely when there is nothing to say, which the contract
              // deserialises as the default. An empty string would be stored and would
              // render as a link to the current page, permanently: profiles are
              // immutable, like everything else about a launch.
              ...(input.profile && Object.keys(input.profile).length > 0
                ? { profile: input.profile }
                : {}),
              // Same treatment: omitted when empty, so a launch with no rules sends
              // nothing rather than a zero cap the contract would refuse.
              ...(input.rules && Object.keys(input.rules).length > 0 ? { rules: input.rules } : {}),
              ...(input.initialBuy && input.initialBuy > 0n
                ? { initial_buy: input.initialBuy.toString() }
                : {}),
              fee_bps: Number(input.curve.feeBps),
            },
          },
          /*
           * The whole supply, plus the opening buy when there is one. The factory
           * refuses any other amount of either, and refuses a third denom outright,
           * so neither of these is a default to adjust.
           *
           * Order matters to nothing on chain but matters here: the seed is first so
           * the panel renders the launch before the purchase, which is the order the
           * two things happen in.
           */
          funds: [
            { denom, amount: seed.toString() },
            ...(input.initialBuy && input.initialBuy > 0n
              ? [{ denom: NETWORK.quoteDenom, amount: input.initialBuy.toString() }]
              : []),
          ],
        },
      },
    ],
  };
}

/** A human summary of what signing would do, shown before it is signed. */
export function describePlan(
  plan: LaunchPlan,
  curve: CurveConfig,
  lpReserve: bigint,
  initialBuy = 0n,
): string[] {
  const whole = (v: bigint) => (v / 10n ** 18n).toLocaleString('en-US');
  const lines = [
    `Create the denom ${plan.denom}`,
    `Name it, with a display unit at ${TOKEN_DECIMALS} decimals so wallets show whole tokens`,
    `Mint ${whole(plan.seedAmount)} tokens to you, and nothing can mint more afterwards`,
    `Send all ${whole(plan.seedAmount)} to the launchpad: ${whole(curve.curveSupply)} onto the curve and ${whole(lpReserve)} held back to pair at graduation`,
    `Buyers pay ${NETWORK.quoteSymbol} and the curve prices every trade until it reaches the target`,
  ];

  /*
   * The opening buy is listed LAST and in the creator's own terms, because it is the
   * step that takes supply before anyone else can see the launch. Every launchpad
   * offers this and most of them describe it as a feature; what it is, from a buyer's
   * side, is the creator at the front of the queue. A plan that lists it blandly
   * between two mechanical steps is the plan not saying so.
   */
  if (initialBuy > 0n) {
    lines.push(
      `Immediately spend ${whole(initialBuy)} ${NETWORK.quoteSymbol} of your own on the curve, at the opening price, before anyone else can buy`,
    );
  }
  return lines;
}
