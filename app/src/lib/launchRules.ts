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
 * So the wording is fixed, and `test/launch-rules.test.ts` holds it: "on the curve",
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

/** Mirrors `MAX_EARLY_FEE_BPS` in the curve contract. */
export const MAX_EARLY_FEE_BPS = 2_000;

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
    } else if (ef.startBps > MAX_EARLY_FEE_BPS) {
      out.push({
        field: 'earlyFee',
        message: `The most an opening fee can be is ${MAX_EARLY_FEE_BPS / 100}%.`,
      });
    } else if (!Number.isFinite(ef.seconds) || ef.seconds <= 0) {
      out.push({ field: 'earlyFee', message: 'Give the opening fee a window to fall over.' });
    }
  }

  return out;
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
      `Buys in the first ${window} pay up to ${(rules.earlyFee.startBps / 100).toFixed(2)}%, falling to the curve's own fee. No wallet is exempt, including the creator's. The extra goes into the pool at graduation, not to the creator. Sells are not affected.`,
    );
  }

  return {
    lines,
    /*
     * Three things this sentence has to do, and dropping any one of them makes it a
     * claim the product cannot keep:
     *   - say WHERE it is enforced (the curve), not "the token"
     *   - say WHEN it stops (graduation), because afterwards it trades on a DEX
     *   - say what it does not stop (one person, several addresses)
     */
    scope:
      'Enforced by the curve contract on every buy and sell until this launch graduates. Afterwards the token trades on a DEX and these no longer apply. A cap is per address, so it raises the cost of taking the opening cheaply rather than making it impossible.',
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
