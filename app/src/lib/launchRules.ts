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
 * rules are worth anything. At graduation liquidity moves to a DEX and the rules stop
 * completely.
 *
 * So the wording is fixed, and `test/launch-rules.test.ts` holds it: "on the curve",
 * "until it graduates", never "on the token" and never "every transfer".
 */

export interface LaunchRules {
  /** Base units. Null means no cap. */
  maxPerWallet: bigint | null;
  /** Unix seconds. Null means open immediately. */
  tradeStart: number | null;
}

export const NO_RULES: LaunchRules = { maxPerWallet: null, tradeStart: null };

/** What the contract stores, with amounts as decimal strings and time in nanoseconds. */
export interface RawLaunchRules {
  max_per_wallet?: string | null;
  trade_start?: string | null;
}

/*
 * CosmWasm `Timestamp` is NANOSECONDS since the epoch, serialised as a string because it
 * does not fit a JS number. Treating it as seconds puts every launch start in 1970 and
 * so reads as "already open", which is the failure that silently removes the rule rather
 * than breaking visibly.
 */
const NANOS_PER_SECOND = 1_000_000_000n;

export function parseRules(raw: unknown): LaunchRules {
  if (raw === null || typeof raw !== 'object') return NO_RULES;
  const o = raw as RawLaunchRules;
  const cap = typeof o.max_per_wallet === 'string' ? o.max_per_wallet : null;
  const start = typeof o.trade_start === 'string' ? o.trade_start : null;
  return {
    maxPerWallet: cap === null ? null : safeBigInt(cap),
    tradeStart: start === null ? null : Number(safeBigInt(start) / NANOS_PER_SECOND),
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

export interface RuleProblem {
  field: 'maxPerWallet' | 'tradeStart';
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
export function validateRules(rules: LaunchRules, curveSupply: bigint, nowSeconds: number): RuleProblem[] {
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

  return out;
}

/** Whether buying is open, matching the contract's inclusive boundary. */
export function buyingOpenAt(rules: LaunchRules, nowSeconds: number): boolean {
  return rules.tradeStart === null || nowSeconds >= rules.tradeStart;
}

export function hasAnyRule(rules: LaunchRules): boolean {
  return rules.maxPerWallet !== null || rules.tradeStart !== null;
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
      return { text: 'migrated', tone: 'warn' };
  }
}
