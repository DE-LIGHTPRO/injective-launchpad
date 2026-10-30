/**
 * Launch rules, and the sentence this file exists to keep honest.
 *
 * Hooked on Solana does this with Token-2022 transfer hooks: a rule lives in the token
 * and Solana runs it on every transfer, so a trade that breaks the rule never lands.
 * That is not available here and pretending otherwise would be the worst kind of copy.
 * Injective tokenfactory denoms are bank denoms, and a bank send executes no contract
 * code, so nothing can run on a transfer.
 *
 * What IS true: every buy and sell before graduation goes through the curve contract, so
 * a rule there binds every trade for the whole fair-launch window, which is when launch
 * rules are worth anything. At graduation the reserve is seeded into the locked pool in
 * the same contract, and the rules stop completely: like Pons's anti-snipe window, they
 * are launch-window rules and they expire.
 *
 * So the wording is fixed, and `launch-rules.test.ts` holds it: "on the curve",
 * "until it graduates", never "on the token" and never "every transfer".
 */

export interface EarlyFee {
  /** Fee in bps at the moment buying opens. Always above the curve's own fee. */
  startBps: number;
  /** Seconds over which it falls linearly to the curve's own fee. */
  seconds: number;
}

export interface LaunchRules {
  /** Base units. Null means no cap. */
  maxPerWallet: bigint | null;
  /** Unix seconds. Null means open immediately. */
  tradeStart: number | null;
  /** Null means the curve's own fee applies from the first block. */
  earlyFee: EarlyFee | null;
  /**
   * When buying became possible: `tradeStart` if one was set, else the block that
   * created the launch. The decay is measured from here, so a launch announced in
   * advance does not spend its premium before anyone may trade.
   */
  openedAt: number | null;
}

export const NO_RULES: LaunchRules = {
  maxPerWallet: null,
  tradeStart: null,
  earlyFee: null,
  openedAt: null,
};

/**
 * Mirrors `MAX_EARLY_FEE_BPS` in `contracts/curve/src/state.rs`.
 *
 * DELIBERATELY DOUBLE the curve's own `MAX_FEE_BPS` of 1000, because the point of an
 * opening fee is to be steep enough that being first is not free. So the most a buy
 * can ever pay here is 20%, not the 10% that caps the base rate, and any copy stating
 * a ceiling has to say which of the two it means. The premium above the base rate goes
 * to `state.lp_bonus` and into the locked pool at graduation, so it is not part of the
 * creator/platform split either.
 *
 * Every outward-facing figure comes from here. It was written twice before, once here
 * and once as `MAX_EARLY_FEE_PCT` in `boardMetrics.ts`, which is how a page ends up
 * quoting a ceiling the contract does not have.
 */
export const MAX_EARLY_FEE_BPS = 2_000;

/**
 * The most this FORM will let a creator set.
 *
 * EQUAL TO THE CONTRACT CEILING AGAIN, because the factory the app points at can now
 * price the whole range. It was lowered to 1,000 as a V-01 mitigation: the deployed
 * curve folded the opening premium into `feeBps` and `CurveMath.validate` refused
 * anything over 1,000, so a launch created with an opening fee between 10.01% and 20%
 * reverted every buy and every sell until the premium decayed. The form could not
 * create what that chain could not trade.
 *
 * `0xe24adc45…` carries the fix - two ceilings for two questions - and is verified
 * against its deployed bytecode in `evm/test/DeployedFactory.t.sol`, which creates a
 * launch with a 15% opening fee and trades it. So the mitigation has done its job and
 * is removed rather than left in place looking like a policy.
 *
 * IT STAYS A SEPARATE CONSTANT, equal rather than merged. The two answer different
 * questions - what the contracts permit, and what this form offers - and the next time
 * a deployed factory cannot do something the source can, this is where that is said.
 */
export const FORM_MAX_EARLY_FEE_BPS = MAX_EARLY_FEE_BPS;

/**
 * The fee a buy pays right now, in bps.
 *
 * Mirrors `EarlyFee::bps_at`, including rounding DOWN, because a client figure that
 * disagrees with the chain is worse than no figure: the panel would quote one fee and
 * the wallet would settle another.
 */
export function feeBpsAt(rules: LaunchRules, baseBps: number, nowSeconds: number): number {
  const ef = rules.earlyFee;
  if (ef === null || rules.openedAt === null) return baseBps;
  const elapsed = Math.max(0, nowSeconds - rules.openedAt);
  if (elapsed >= ef.seconds || ef.seconds <= 0) return baseBps;
  const premium = Math.max(0, ef.startBps - baseBps);
  return baseBps + Math.floor((premium * (ef.seconds - elapsed)) / ef.seconds);
}

/** Seconds until the opening fee reaches the curve's own, or null when it already has. */
export function secondsUntilBaseFee(rules: LaunchRules, nowSeconds: number): number | null {
  if (rules.earlyFee === null || rules.openedAt === null) return null;
  const endsAt = rules.openedAt + rules.earlyFee.seconds;
  return nowSeconds >= endsAt ? null : endsAt - nowSeconds;
}

/** What the contract stores, with amounts as decimal strings and time in nanoseconds. */
export interface RawLaunchRules {
  max_per_wallet?: string | null;
  trade_start?: string | null;
  early_fee?: { start_bps?: number; seconds?: number } | null;
}

/*
 * CosmWasm `Timestamp` is NANOSECONDS since the epoch, serialised as a string because it
 * does not fit a JS number. Treating it as seconds puts every launch start in 1970 and
 * so reads as "already open", which is the failure that silently removes the rule rather
 * than breaking visibly.
 */
const NANOS_PER_SECOND = 1_000_000_000n;

/**
 * `openedAtSeconds` comes from the curve's own `Config.opened_at` rather than being
 * inferred, because inferring it is wrong in the one case that matters: a launch with
 * no `trade_start` opened at the block that created it, which this side cannot know.
 */
export function parseRules(raw: unknown, openedAtSeconds?: number | null): LaunchRules {
  if (raw === null || typeof raw !== 'object') return NO_RULES;
  const o = raw as RawLaunchRules;
  const cap = typeof o.max_per_wallet === 'string' ? o.max_per_wallet : null;
  const start = typeof o.trade_start === 'string' ? o.trade_start : null;
  const startSecs = start === null ? null : Number(safeBigInt(start) / NANOS_PER_SECOND);

  // The contract only stores a well-formed pair, but this parses chain data from a
  // factory the UI may not control, so a half-formed one becomes no rule rather than
  // a fee of NaN rendered beside a trade.
  const raw_ef = o.early_fee;
  const earlyFee: EarlyFee | null =
    raw_ef && typeof raw_ef.start_bps === 'number' && typeof raw_ef.seconds === 'number'
      ? { startBps: raw_ef.start_bps, seconds: raw_ef.seconds }
      : null;

  return {
    maxPerWallet: cap === null ? null : safeBigInt(cap),
    tradeStart: startSecs,
    earlyFee,
    openedAt: openedAtSeconds ?? startSecs,
  };
}

function safeBigInt(v: string): bigint {
  try {
    return BigInt(v);
  } catch {
    // Contract state is data. A value that is not a number must not throw and blank
    // the page that was about to display it.
    return 0n;
  }
}

/** The rules as `CreateLaunch` expects them, with absent rules omitted entirely. */
export function rulesForChain(input: { maxPerWallet: bigint | null; tradeStart: number | null }): Record<
  string,
  string
> {
  const out: Record<string, string> = {};
  if (input.maxPerWallet !== null && input.maxPerWallet > 0n) {
    out.max_per_wallet = input.maxPerWallet.toString();
  }
  if (input.tradeStart !== null) {
    out.trade_start = (BigInt(input.tradeStart) * NANOS_PER_SECOND).toString();
  }
  return out;
}

/** The early fee as `CreateLaunch` expects it, or nothing when there is none. */
export function earlyFeeForChain(ef: EarlyFee | null): Record<string, unknown> {
  return ef === null ? {} : { early_fee: { start_bps: ef.startBps, seconds: ef.seconds } };
}

export interface RuleProblem {
  field: 'maxPerWallet' | 'tradeStart' | 'earlyFee';
  message: string;
}

/**
 * The same refusals the contract makes, so the form can say which rule is wrong before
 * a wallet is opened rather than after a transaction fails.
 *
 * `curveSupply` is needed because the binding check depends on it: a cap at or above the
 * whole sellable supply can never bind, and storing it would advertise a protection the
 * launch does not have.
 */
export function validateRules(
  rules: LaunchRules,
  curveSupply: bigint,
  nowSeconds: number,
  baseFeeBps = 0,
): RuleProblem[] {
  const out: RuleProblem[] = [];

  if (rules.maxPerWallet !== null) {
    if (rules.maxPerWallet <= 0n) {
      out.push({ field: 'maxPerWallet', message: 'A cap of zero would stop anyone buying.' });
    } else if (rules.maxPerWallet >= curveSupply) {
      out.push({
        field: 'maxPerWallet',
        message: 'That is the whole supply on the curve, so the cap could never apply. Lower it or leave it off.',
      });
    }
  }

  if (rules.tradeStart !== null && rules.tradeStart < nowSeconds) {
    /*
     * A warning rather than a refusal in the contract, and a refusal here, because the
     * two are answering different questions. The chain cannot know what the creator
     * meant by a past timestamp and treats it as open, which is correct. A form CAN
     * know: someone filling in a start time wants a future one, and a past one means
     * they got the date wrong, which is permanent.
     */
    out.push({ field: 'tradeStart', message: 'That time has already passed, so the launch would open immediately.' });
  }

  if (rules.earlyFee !== null) {
    const ef = rules.earlyFee;
    // Mirrors the contract's refusals, so the form says which rule is wrong before a
    // wallet opens rather than after a transaction fails.
    if (!Number.isFinite(ef.startBps) || ef.startBps <= baseFeeBps) {
      out.push({
        field: 'earlyFee',
        message: `An opening fee has to be above the trading fee of ${(baseFeeBps / 100).toFixed(2)}%, or it never applies.`,
      });
    } else if (ef.startBps > FORM_MAX_EARLY_FEE_BPS) {
      out.push({
        field: 'earlyFee',
        message: `The most an opening fee can be is ${FORM_MAX_EARLY_FEE_BPS / 100}%. Above that the curve cannot price a trade until the fee has decayed, so the launch would open untradeable.`,
      });
    } else if (!Number.isFinite(ef.seconds) || ef.seconds <= 0) {
      out.push({ field: 'earlyFee', message: 'Give the opening fee a window to fall over.' });
    }
  }

  return out;
}

/**
 * Whether a buy would put this address over the wallet cap.
 *
 * Mirrors `would_exceed_cap` in `contracts/curve/src/state.rs`, including the strict
 * `>`: a buy landing exactly on the cap is allowed, there and here. The Rust uses
 * `saturating_add` because a `Uint128` can overflow and "absurdly large" should read as
 * over the cap rather than as an arithmetic error; a `bigint` cannot overflow, so plain
 * addition is the faithful translation and not a looser one.
 *
 * ONE RESOLVER, because this decision had been made in one place and needed in two.
 * `openingBuyOverCap` below checked the creator's own first buy; the trade panel checked
 * nothing at all, so a buyer part-way to the cap got a live quote, an enabled button and
 * a refusal inside the block. Reproduced on testnet before writing this: on AUDCAP8
 * (cap 100,000, that address already holding 78,564.513) the contract quotes 0.03 INJ at
 * 47,133.186 tokens, which is 125,697.699 against a 100,000 cap. The quote is correct,
 * the curve is right to refuse it, and the user pays gas to find out.
 */
export function buyOverCap(rules: LaunchRules, held: bigint, tokensOut: bigint): boolean {
  return rules.maxPerWallet !== null && held + tokensOut > rules.maxPerWallet;
}

/**
 * How much more this address may still buy, or `null` when the launch has no cap.
 *
 * Floored at zero rather than going negative. A cap can be exceeded on paper - a creator
 * may set one lower than an existing holder already has - and a negative allowance would
 * render as a minus sign in front of a number somebody has to act on.
 */
export function remainingAllowance(rules: LaunchRules, held: bigint): bigint | null {
  if (rules.maxPerWallet === null) return null;
  return rules.maxPerWallet > held ? rules.maxPerWallet - held : 0n;
}

/**
 * Whether the creator's own opening buy would break the cap the creator just set.
 *
 * THE RULE BINDS ITS AUTHOR, and that is the part the form did not say. The factory
 * buys with the creator as recipient on a curve nobody has touched, so it checks
 * `would_exceed_cap(0, tokens_out)` and returns `InitialBuyOverCap`. Two optional
 * fields in one form, both reasonable to set together - "cap each wallet, and I will
 * take an opening position" - and the combination reverts the whole launch after the
 * creator has signed and paid gas.
 *
 * It is reachable at ordinary numbers rather than at extremes. Measured against the
 * default shape on 18 Oct 2026: 1 INJ buys 1.569M tokens and 5 INJ buys 7.800M, so any
 * cap in the single-digit millions is exceeded by an opening buy of a few INJ. The 10%
 * ceiling the form already checks does not help, because it only binds past 55 INJ.
 *
 * The curve it buys on has never been touched, so the held figure is zero and this is
 * `buyOverCap` at that one input rather than a second copy of the comparison.
 */
export function openingBuyOverCap(rules: LaunchRules, tokensOut: bigint): boolean {
  return buyOverCap(rules, 0n, tokensOut);
}

/** Whether buying is open, matching the contract's inclusive boundary. */
export function buyingOpenAt(rules: LaunchRules, nowSeconds: number): boolean {
  return rules.tradeStart === null || nowSeconds >= rules.tradeStart;
}

export function hasAnyRule(rules: LaunchRules): boolean {
  return rules.maxPerWallet !== null || rules.tradeStart !== null || rules.earlyFee !== null;
}

/**
 * How each rule is described to a buyer.
 *
 * Every string names the curve and names graduation, because a rule that stops at
 * graduation and is described as a property of the token is a false claim about what
 * someone is buying. `scope` is returned separately rather than baked into each line so
 * the panel can show it once under a list instead of repeating it per rule.
 */
export function describeRules(
  rules: LaunchRules,
  formatAmount: (v: bigint) => string,
  formatTime: (unixSeconds: number) => string,
): { lines: string[]; scope: string } {
  const lines: string[] = [];

  if (rules.maxPerWallet !== null) {
    lines.push(
      `One address can hold at most ${formatAmount(rules.maxPerWallet)} bought from this curve. Selling frees the allowance again.`,
    );
  }
  if (rules.tradeStart !== null) {
    lines.push(`Buying opens at ${formatTime(rules.tradeStart)}. Nothing can be bought before then.`);
  }
  if (rules.earlyFee !== null) {
    const mins = Math.round(rules.earlyFee.seconds / 60);
    const window = mins >= 1 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${rules.earlyFee.seconds} seconds`;
    /*
     * Three things in one sentence, and none of them is optional: the fee, the
     * window, and WHERE IT GOES. A launchpad charging an extra fee without saying who
     * receives it reads as the creator taking more, which is the opposite of what
     * this does and the reason anyone would object to it.
     */
    /*
     * "No wallet is exempt" is a deliberate contrast with how this is usually built.
     *
     * ponsfamily.com has the same mechanism and lets a creator WHITELIST wallets out
     * of it, then discloses on each card that "the creator exempted 32 wallets from
     * the launch snipe tax, so they could buy untaxed at the open". Disclosing it is
     * honest and it is still a worse product: the fee exists to make the opening
     * expensive, and an exemption hands exactly that advantage to whoever the creator
     * chooses, which is the thing a buyer was worried about in the first place.
     *
     * There is no exemption here and no way to add one, so this can be said flatly.
     * It is a stronger claim than a disclosure and it costs nothing to keep.
     */
    lines.push(
      /*
       * "SELLS ARE NOT AFFECTED" WAS FALSE, and this was one of three places saying
       * it. `currentSellFeeBps` builds the same schedule against the sell fee, so the
       * premium is charged on the way out too - and unlike the buy side's premium, it
       * is split creator/platform like any ordinary fee rather than held for the pool.
       * Both halves proven in `evm/test/EarlyFee.t.sol`.
       */
      `Trades in the first ${window} pay up to ${(rules.earlyFee.startBps / 100).toFixed(2)}%, falling to the curve's own fee. No wallet is exempt, including the creator's. It applies to sells as well as buys, so leaving early costs more too. On a buy the amount above the curve's own rate goes into the pool at graduation, not to the creator; on a sell the whole fee is split like any other.`,
    );
  }

  return {
    lines,
    /*
     * Three things this sentence has to do, and dropping any one of them makes it a
     * claim the product cannot keep:
     *   - say WHERE it is enforced (the curve), not "the token"
     *   - say WHEN it stops (graduation), because afterwards it trades against its pool
     *   - say what it does not stop (one person, several addresses)
     */
    scope:
      'Enforced by the curve contract on every buy and sell until this launch graduates. Afterwards it trades against its locked pool and these no longer apply. A cap is per address, so it raises the cost of taking the opening cheaply rather than making it impossible.',
  };
}

/**
 * What a launch is right now, in one place.
 *
 * Three states, not two. The chip said "live" on a launch whose start time had not
 * arrived, which is a launch the contract refuses every buy on: the most confident
 * possible label on the one state where it is wrong. The list and the detail page were
 * each deriving it from `graduated` alone, so fixing one would have left the other.
 */
export type LaunchStatus = 'pending' | 'live' | 'graduated' | 'migrated';

export function launchStatus(opts: {
  graduated: boolean;
  migrated?: boolean;
  rules: LaunchRules;
  nowSeconds: number;
}): LaunchStatus {
  // Graduation wins: a launch that reached its target is past its start time by
  // definition, and reporting "pending" there would be nonsense.
  if (opts.graduated) return opts.migrated ? 'migrated' : 'graduated';
  return buyingOpenAt(opts.rules, opts.nowSeconds) ? 'live' : 'pending';
}

/** The chip's words, and the tone that goes with them. */
export function statusLabel(s: LaunchStatus): { text: string; tone: 'accent' | 'warn' | 'muted' } {
  switch (s) {
    case 'pending':
      // Not "coming soon": that is marketing. This says what the contract does.
      return { text: 'not open yet', tone: 'muted' };
    case 'live':
      return { text: 'live', tone: 'accent' };
    case 'graduated':
      return { text: 'graduated', tone: 'warn' };
    case 'migrated':
      // Tradable again, against the locked pool, so it reads as live rather than as a
      // warning. "migrated" said liquidity had gone somewhere; it no longer goes anywhere.
      return { text: 'in pool', tone: 'accent' };
  }
}
