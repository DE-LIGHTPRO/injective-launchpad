'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  quoteBuy,
  quoteBuyWithPremium,
  priceImpactBps,
  sellPriceImpactBps,
  IMPACT_WARN_BPS,
  IMPACT_SEVERE_BPS,
  quoteSell,
  poolQuoteBuy,
  poolQuoteSell,
  poolBuyImpactBps,
  poolSellImpactBps,
  parseAmount,
  effectiveFeeBps,
  fmt,
  CurveError,
  type CurveConfig,
  type CurveState,
  type PoolReserves,
} from '@/lib/curve';
import { NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import {
  buyingOpenAt,
  buyOverCap,
  remainingAllowance,
  feeBpsAt,
  secondsUntilBaseFee,
  NO_RULES,
  type LaunchRules,
} from '@/lib/launchRules';
import { useRouter } from 'next/navigation';
import { useConnectedAccount } from '@/lib/walletStore';
import { denomBalance } from '@/lib/wallet';
import { TxDialog, useTxFlow } from './TxDialog';
import { purchasedFromCurve, type Quote } from '@/lib/chain';

type Side = 'buy' | 'sell';

/**
 * Left behind by Max on a buy, so the transaction can pay its own fee.
 *
 * 0.05 INJ, which is deliberately far more than a transaction costs. Spending the whole
 * balance instead produces a transaction that is rejected for fees AFTER the user has
 * approved it, which reads as the app being broken rather than as a balance being
 * exactly empty.
 *
 * THIS SAID "a launch transaction that simulates near 3,000,000 gas" AND NOTHING
 * SIMULATED ANYTHING. Audit F-09: the figure was the flat literal in `GAS.launch`, and
 * the word "simulates" came from the same vanished `simulateLaunch` the docblock in
 * `broadcast.ts` claimed. A measured launch is the one number nobody here has yet, since
 * the create path needs a funded key, so this reserve is stated as what it is - a
 * generous round number - rather than dressed as a measurement. A real curve buy measures
 * 249,433 gas, which is 0.000187 INJ, so 0.05 is roughly 250 times a trade's fee.
 */
const GAS_RESERVE_INJ = 5n * 10n ** 16n;

/**
 * What Max leaves behind, and it is only ever left behind in the GAS token.
 *
 * Gas on Injective is paid in INJ whatever a launch is priced in, so a buy funded
 * with USDC does not need USDC held back: reserving there would silently shave the
 * user's order for no reason. Reserving the wrong AMOUNT would be worse. The literal
 * is 18-decimal INJ, so applied to a 6-decimal quote it is 50,000,000,000 units, and
 * Max on any realistic USDC balance would have resolved to zero.
 */
function gasReserveFor(quoteDenom: string, gasDenom: string): bigint {
  return quoteDenom === gasDenom ? GAS_RESERVE_INJ : 0n;
}

/**
 * Base units to a plain decimal string, with nothing dropped.
 *
 * `fmt` rounds for display, and rounding here is the bug: a Max that rounds DOWN leaves
 * dust behind, and one that rounds UP produces an amount larger than the balance, which
 * the chain refuses. This is the exact figure.
 */
function formatExact(v: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const frac = (v % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Quotes are computed locally from the same maths the contract runs, so the
 * numbers move as you type without a round trip. `curve.test.ts` asserts them
 * against the Rust unit for unit, so the two cannot silently drift — a client
 * quote that disagrees with the chain is worse than no quote.
 */
export function TradePanel({
  config,
  state,
  symbol,
  denom,
  curve,
  quoteAsset,
  tradingClosed,
  rules = NO_RULES,
  pool = null,
  blocked = false,
}: {
  config: CurveConfig;
  state: CurveState;
  symbol: string;
  /** The curve contract a trade is sent to. */
  curve: string;
  /**
   * THIS launch's quote: what a buy spends and a sell receives.
   *
   * Named `quoteAsset` rather than `quote` because this panel already has a `quote`:
   * the memo holding the priced trade. Two different meanings of the word one scope
   * apart is how the wrong one gets read.
   */
  quoteAsset: Quote;
  /** The launched token's denom, so the panel can read what the account holds. */
  denom: string;
  tradingClosed: boolean;
  rules?: LaunchRules;
  /**
   * The locked pool, once the launch has graduated. Present means every quote on this
   * panel prices against the pool instead of the curve, through the same contract and
   * the same Buy / Sell messages, so nothing else about trading changes for the user.
   */
  pool?: PoolReserves | null;
  /** The curve failed the code check (`lib/codeCheck.ts`); the reason is shown above. */
  blocked?: boolean;
}) {
  const inPool = pool !== null && pool.quote > 0n && pool.tokens > 0n;
  const [side, setSide] = useState<Side>('buy');

  /*
   * THE PANEL IS THREE SCREENS DOWN ON A PHONE. Measured on /launch/ORBIT at 375x812:
   * the Buy/Sell tabs sit at y=2571 of a 4029px page, so a trader scrolls 3.07 viewports
   * past the title, the badges, the stats and the chart before reaching the only control
   * that does anything. The desktop layout puts the panel beside the chart and there is
   * no room for that on a phone, so it falls below everything.
   *
   * A bar pinned to the bottom fixes the reach without reordering the page, which
   * matters: the chart above the panel is the right order for reading, and moving the
   * panel to the top would put a form above the thing it is a form about.
   *
   * IT ONLY APPEARS WHEN THE PANEL IS OFF SCREEN. A fixed bar duplicating a control the
   * reader can already see is clutter, and two Buy buttons on one screen is the kind of
   * thing that makes somebody check which one is real.
   */
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [panelInView, setPanelInView] = useState(true);
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setPanelInView(e.isIntersecting), {
      // Any sliver counts: the bar should go as soon as the real control is reachable.
      threshold: 0,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /** Bring the panel into view and pick a side in one tap. */
  const jumpTo = (s: Side) => {
    setSide(s);
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const [input, setInput] = useState('');

  /*
   * What the connected account actually holds, on both sides.
   *
   * Missing entirely until now, and on the sell side that is not a convenience: a
   * holder could not see their position and had no way to sell all of it, because the
   * amount is in base units and nobody types eighteen decimals by hand. They had to
   * guess low and leave a remainder, or guess high and be refused.
   *
   * `null` means not read, never zero. An unreachable LCD rendered as "0" on a sell
   * screen tells someone their position is gone, which is the most alarming lie this
   * panel could tell.
   */
  const account = useConnectedAccount();
  const router = useRouter();
  const [quoteBal, setQuoteBal] = useState<bigint | null>(null);
  const [tokenBal, setTokenBal] = useState<bigint | null>(null);

  /*
   * Bumped when a trade confirms, so the two reads below run again.
   *
   * Both figures move with every trade and `router.refresh()` does not touch them -
   * they are read in this client component, not server-rendered - so without this the
   * allowance a buyer sees after buying is the one from before they bought, and the
   * second buy of a pair that together exceed the cap would be allowed through.
   */
  const [settled, setSettled] = useState(0);

  /*
   * The wallet cap, read from the curve's own storage rather than inferred.
   *
   * `null` is NOT READ and never zero, for the same reason the balances above are. Here
   * the direction is the dangerous one: zero reads as a full allowance, so an unreachable
   * node would re-enable exactly the buy this is here to stop.
   *
   * Only read when there is a cap to check, and never on the pool: the rule expires at
   * graduation, so a graduated launch would be paying for a request whose answer cannot
   * change anything.
   */
  const capped = rules.maxPerWallet !== null && !inPool;
  const [purchased, setPurchased] = useState<bigint | null>(null);
  useEffect(() => {
    if (!account || !capped) {
      setPurchased(null);
      return;
    }
    let live = true;
    void purchasedFromCurve(curve, account.address).then((v) => {
      if (live) setPurchased(v);
    });
    return () => {
      live = false;
    };
  }, [account, capped, curve, settled]);

  useEffect(() => {
    if (!account) {
      setQuoteBal(null);
      setTokenBal(null);
      return;
    }
    let live = true;
    void Promise.all([
      denomBalance(account.address, quoteAsset.denom),
      denomBalance(account.address, denom),
    ]).then(([q, t]) => {
      // Guarded, because switching launches while a read is in flight would otherwise
      // write the previous token's balance under the new token's name.
      if (live) {
        setQuoteBal(q);
        setTokenBal(t);
      }
    });
    return () => {
      live = false;
    };
  }, [account, denom, quoteAsset.denom, settled]);

  const held = side === 'buy' ? quoteBal : tokenBal;
  const [slippagePct, setSlippagePct] = useState(1);
  const [busy, setBusy] = useState(false);
  /*
   * The aftermath lives in the dialog now, not in two sentences under the button.
   *
   * What was here was `txHash` and `tradeError`, rendered as "Trade sent. View the
   * transaction. Balances update when the page next reads the chain." That was the
   * most this component could truthfully say, because it had a hash from a node that
   * had accepted the bytes and never asked what became of them. The dialog follows
   * the transaction into a block, so there is now a confirmation, a refusal or an
   * explicit "not seen yet" to report instead.
   */
  const tx = useTxFlow();

  /*
   * A launch that has not opened yet gets its own state, and this was missing.
   *
   * `buyingOpenAt` existed with six tests and no call site: the panel rendered a live
   * quote and a button for a launch the contract would refuse at signing, which is the
   * worst version of this because the price looks real right up to the wallet popup.
   * Found by sweeping for exported symbols nothing reaches, not by using the page.
   *
   * Ticking rather than read once, so the panel opens on its own at the start time. A
   * state that requires a reload to clear reads as a broken page, and the one minute
   * after a launch opens is the minute people are actually looking at it.
   */
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const notOpenYet = !tradingClosed && !inPool && !buyingOpenAt(rules, now);
  useEffect(() => {
    if (!notOpenYet) return;
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(id);
  }, [notOpenYet]);

  /*
   * The fee THIS BLOCK charges, which during an opening window is not the curve's own.
   *
   * The panel showed `config.feeBps` and quoted with it, so for the length of a decay
   * it promised more tokens than the chain would deliver. A quote that disagrees with
   * settlement is the defect this codebase calls a faked execution path, and it is
   * worse than no quote because it looks right until the wallet opens.
   *
   * Ticks while the premium is running, both so the figure stays true and so a buyer
   * can watch it fall, which is the behaviour the rule is trying to encourage.
   */
  const baseBps = Number(config.feeBps);
  /*
   * The exit rate is not read here any more. It reached the screen as a label beside
   * an amount it was meant to describe, and both sides of that row now come from the
   * amounts themselves: `config.feeSellBps` goes into the quote, and the rate shown
   * is measured back out of it. The premium never touches the sell side, which is why
   * there was nothing to compose and nothing that drifted.
   */
  // Launch-window rules expire with the curve: the pool charges its base fee only.
  const chargedBps = inPool ? baseBps : feeBpsAt(rules, baseBps, now);
  const premiumBps = Math.max(0, chargedBps - baseBps);
  const decaySecondsLeft = inPool ? null : secondsUntilBaseFee(rules, now);
  useEffect(() => {
    if (decaySecondsLeft === null) return;
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(id);
  }, [decaySecondsLeft]);

  /**
   * The input, in base units of whatever side is being traded.
   *
   * A BUY'S INPUT IS QUOTE, a sell's is tokens, and they do not share decimals: the
   * token is always 18 and the quote is whatever the launch is priced in. Parsing
   * both at 18 was correct for exactly as long as every launch was INJ.
   *
   * It is derived once because the quote memo and the price-impact memo both parse
   * the same box, and they had drifted: one parsed at 18 and the submit path at the
   * quote's decimals, so on a 6-decimal pair the panel QUOTED one amount and would
   * have signed a transaction for another, a trillion apart. The displayed number
   * and the signed number must come from one place.
   */
  const inputDecimals = side === 'buy' ? quoteAsset.decimals : 18;

  const quote = useMemo(() => {
    if (!input.trim()) return null;
    try {
      const raw = parseAmount(input, inputDecimals);
      if (raw <= 0n) return null;
      /*
       * The premium comes off the top before the curve is quoted, exactly as the
       * contract does it. Folding it into `config.feeBps` would be the other way to
       * write this and it is the one the maths crate refuses, since its own fee cap
       * is below what an opening fee is meant to reach.
       *
       * Sells are untouched: the rule is a charge for taking the opening, not an exit
       * tax, and applying it to sells would punish an early buyer for changing their
       * mind.
       */
      if (inPool && pool) {
        return side === 'buy'
          ? (() => {
              const q = poolQuoteBuy(pool, config.feeBps, raw);
              return {
                ok: true,
                side: 'buy',
                fee: q.fee,
                tokensOut: q.tokensOut,
                injInAfterFee: q.quoteInAfterFee,
                refund: 0n,
                graduates: false,
                earlyFeePremium: 0n,
              } as const;
            })()
          // The sell fee on the pool too. It is a venue fee and not a launch-window
          // rule, so unlike the cap, the start time and the opening premium it does
          // not expire at graduation, and the contract charges it on both venues.
          : ({ ok: true, side: 'sell', ...poolQuoteSell(pool, config.feeSellBps, raw) } as const);
      }
      return side === 'buy'
        ? ({
            ok: true,
            side: 'buy',
            /*
             * The premium basis is the contract's, not this panel's. It used to skim
             * `raw * premiumBps`, which charges the premium on quote the curve hands
             * straight back, and overstated `tokensOut` by up to 5.96% on a buy that
             * overshoots the remaining capacity. `min_tokens_out` comes off that
             * figure, so the contract refused those trades as slippage.
             */
            ...quoteBuyWithPremium(config, state, raw, BigInt(premiumBps)),
          } as const)
        : ({ ok: true, side: 'sell', ...quoteSell(config, state, raw) } as const);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof CurveError ? e.message : 'That amount could not be quoted.',
      } as const;
    }
  }, [input, side, config, state, premiumBps, inputDecimals, inPool, pool]);

  /*
   * The fee row's two halves, derived from ONE place so they cannot disagree.
   *
   * The label read `chargedBps`, the sum of the opening premium and the curve's fee,
   * above an amount produced by applying them in sequence: 4.45% beside 0.004415 INJ
   * on a 0.1 INJ buy, which is 4.4155%. See `effectiveFeeBps`, where the arithmetic
   * and the reason live, out of the component as the premium basis already is.
   */
  const okQuote = quote && quote.ok ? quote : null;
  const feeCharged =
    okQuote === null
      ? null
      : okQuote.side === 'buy'
        ? okQuote.fee + (okQuote.earlyFeePremium ?? 0n)
        : okQuote.fee;
  const feeChargedBps =
    okQuote === null || feeCharged === null
      ? null
      : effectiveFeeBps(feeCharged, okQuote.side === 'buy' ? okQuote.injInAfterFee : okQuote.injOut);

  /**
   * Send the trade.
   *
   * WHY THIS WAS MISSING. The button read `<button className="go" disabled>` and there
   * was no handler at all. Every quote on this panel was correct, asserted against the
   * Rust unit for unit, and could not be acted on: the app could sign exactly one kind
   * of transaction, a launch, because the signing path took a `LaunchPlan` and nothing
   * else. Fees accrued to nobody because no trade could happen.
   *
   * `minOut` is sent as the contract's own `min_*` guard rather than being merely
   * displayed, so the slippage figure above the button is the one enforced on chain.
   */
  async function submit() {
    if (!account || !quote?.ok) return;
    setBusy(true);
    try {
      const { broadcastExecute, GAS } = await import('@/lib/broadcast');
      const confirmed = await tx.run({
        title: side === 'buy' ? `Buy ${symbol}` : `Sell ${symbol}`,
        /*
         * The amount is parsed INSIDE `send`, so a `CurveError` from it is reported
         * through the dialog like every other refusal. Parsed outside, it would throw
         * past the only thing on screen that reports anything and the button would
         * simply un-press.
         */
        send: (onStage) =>
          broadcastExecute({
            contract: curve,
            msg:
              side === 'buy'
                ? { buy: { min_tokens_out: minOut.toString() } }
                : { sell: { min_inj_out: minOut.toString() } },
            /*
             * A buy attaches quote, a sell attaches the token itself: this curve takes
             * payment by attachment on both sides, so neither needs an allowance and
             * neither can be spent without the trade happening in the same transaction.
             */
            funds: [
              {
                denom: side === 'buy' ? quoteAsset.denom : denom,
                amount: parseAmount(input, inputDecimals).toString(),
              },
            ],
            sender: account.address,
            wallet: account.provider,
            gas: GAS.trade,
            onStage,
          }),
      });
      /*
       * THE INPUT AND THE PAGE ARE CLEARED ON A CONFIRMATION, NOT ON A SEND.
       *
       * Both used to run the moment a hash came back. A trade refused in the block -
       * slippage, most commonly, which is the whole reason `min_*` is on the message -
       * emptied the field and repainted the page with figures that had not moved, so
       * the only evidence of the refusal was a sentence the clearing made look stale.
       * Clearing a form is the app saying the thing is done.
       */
      if (confirmed) {
        setInput('');
        // Re-reads the balances and the wallet allowance, neither of which is a
        // server-rendered prop, so `router.refresh()` below cannot reach them.
        setSettled((n) => n + 1);
        /*
         * THE SAME DEFECT THE CLAIM PANEL HAD. Market cap, curve reserve, progress,
         * tokens sold and the chart are all server-rendered props; nothing refetched
         * them after a trade, so a buy that landed left every figure on the page
         * reading as it did before. `router.refresh()` re-runs the server component
         * against the chain, which is the only honest source for them.
         */
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  /*
   * Whether the chain will refuse this buy on the wallet cap, decided before the wallet
   * opens rather than after.
   *
   * THREE OUTCOMES, not two. `null` is "cannot say", which is what an unread allowance
   * honestly is, and it does not disable the button: refusing a legitimate trade because
   * our own read failed is its own defect, and the contract is the authority at signing
   * either way. The note below says which of the three it is.
   *
   * Sells are never capped. The cap binds what an address may HOLD from the curve, and
   * selling is the thing that frees it.
   */
  const overCap =
    !capped || side !== 'buy' || !quote?.ok || quote.side !== 'buy'
      ? false
      : purchased === null
        ? null
        : buyOverCap(rules, purchased, quote.tokensOut);

  /** What is left of this address's allowance, or `null` when there is nothing to say. */
  const allowanceLeft =
    capped && purchased !== null ? remainingAllowance(rules, purchased) : null;

  /** Worst acceptable fill, sent as the contract's min_* guard. */
  const minOut = useMemo(() => {
    if (!quote?.ok) return 0n;
    const gross = quote.side === 'buy' ? quote.tokensOut : quote.injOut;
    return (gross * BigInt(Math.round((100 - slippagePct) * 100))) / 10_000n;
  }, [quote, slippagePct]);

  /*
   * Price impact, on a buy only.
   *
   * This panel disclosed the 1% fee and said nothing about the curve. On the shape
   * this project ships, 25 INJ into a fresh launch pays about 82% above spot, so the
   * disclosed cost was a fortieth of the real one and read as the whole of it.
   *
   * `null` means "not measurable", never zero. Zero impact is a claim, and on a
   * curve this steep it is the least likely claim to be true, so the row says so
   * rather than printing 0.00%.
   */
  const impactBps = useMemo(() => {
    if (!quote?.ok) return null;
    try {
      const raw = parseAmount(input || '0', inputDecimals);
      // Both sides, because the exit is where a holder is most exposed and it had
      // no disclosure at all: selling a quarter of a position on this shape pays
      // about 25% below spot, against the 1% fee shown beside it.
      if (inPool && pool) {
        return quote.side === 'buy'
          ? poolBuyImpactBps(pool, config.feeBps, raw)
          : poolSellImpactBps(pool, config.feeSellBps, raw);
      }
      return quote.side === 'buy'
        ? priceImpactBps(config, state, raw)
        : sellPriceImpactBps(config, state, raw);
    } catch {
      return null;
    }
  }, [quote, config, state, input, inPool, pool, inputDecimals]);

  if (notOpenYet && rules.tradeStart !== null) {
    return (
      <div className="card">
        <h2>Not open yet</h2>
        <p className="note">
          {/*
              The time is named, and named in UTC. A launch that says only "opens soon"
              gives nobody a reason to come back at the right moment, and a local time
              rendered from a server is the server's local time rather than the
              reader's.
            */}
          Buying opens at{' '}
          <strong>
            {new Date(rules.tradeStart * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC
          </strong>
          . The curve refuses every buy before then, so there is no advantage to being early.
        </p>
        <p className="note">
          {/*
              The clock caveat, stated rather than hidden. The contract gates on BLOCK
              time and this panel reads the browser's, so the two can disagree by a few
              seconds. Promising the button will work at the exact second would be a
              claim this page cannot keep.
            */}
          The contract gates on block time, so the first block after this may land a few
          seconds either side.
        </p>
      </div>
    );
  }

  if (blocked) {
    return (
      <div className="card">
        <h2>Trading disabled</h2>
        <p className="note">
          This launch failed the contract check shown above, so this site will not sign a
          trade against it.
        </p>
      </div>
    );
  }

  if (tradingClosed && !inPool) {
    return (
      <div className="card">
        <h2>Graduating</h2>
        <p className="note">
          This launch reached its target. Its reserve is being seeded into the locked pool,
          which happens in the same transaction as the graduating buy, so this state should
          clear on the next refresh.
        </p>
      </div>
    );
  }

  const unit = side === 'buy' ? quoteAsset.label : symbol;

  return (
    <>
      {/*
          Hidden from the accessibility tree while the panel is in view, and removed from
          the DOM otherwise - not merely visually hidden - so a screen reader and a
          keyboard never meet a second Buy button that duplicates the real one.
        */}
      {!panelInView && (
        <div className="trade-jump" role="group" aria-label="Jump to trading">
          <button type="button" className="trade-jump-buy" onClick={() => jumpTo('buy')}>
            Buy {symbol}
          </button>
          <button type="button" className="trade-jump-sell" onClick={() => jumpTo('sell')}>
            Sell
          </button>
        </div>
      )}
      <div className="card" ref={cardRef}>
      <div className="segmented" role="group" aria-label="Trade side">
        <button aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>
          Buy
        </button>
        <button aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>
          Sell
        </button>
      </div>

      <label className="field">
        <span className="lbl">
          <span>{side === 'buy' ? 'You spend' : 'You sell'}</span>
          {account && (
            <span className="bal-row">
              <span className="mono">
                {/*
                    "not read" rather than "0". An unreachable LCD showing zero on a
                    sell screen tells a holder their position is gone.
                  */}
                {held === null ? 'balance not read' : `${fmt(held, side === 'buy' ? quoteAsset.decimals : 18, held === 0n ? 0 : 4)} ${unit}`}
              </span>
              {held !== null && held > 0n && (
                /*
                 * Max exists because the alternative is typing eighteen decimals by
                 * hand. Without it a seller guesses low and leaves a remainder, or
                 * guesses high and is refused; neither is a choice anyone is making
                 * on purpose.
                 *
                 * On a BUY it deliberately leaves gas behind. Spending the entire
                 * balance produces a transaction that cannot pay its own fee, which
                 * fails after the wallet prompt and looks like the app is broken.
                 */
                <button
                  type="button"
                  className="max-btn"
                  onClick={() => {
                    const spendable =
                      side === 'buy'
                        ? (() => {
                            const reserve = gasReserveFor(quoteAsset.denom, NETWORK.gasDenom);
                            return held > reserve ? held - reserve : 0n;
                          })()
                        : held;
                    // Formatted in the units of the side being traded, which is what
                    // the box is then parsed as. Formatting at 18 and parsing at 6
                    // puts Max a trillion out.
                    setInput(formatExact(spendable, inputDecimals));
                  }}
                >
                  Max
                </button>
              )}
            </span>
          )}
        </span>
        <span className="input-wrap">
          <input
            className="amount"
            inputMode="decimal"
            placeholder="0.00"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label={`Amount of ${unit} to ${side}`}
          />
          <span className="unit">{unit}</span>
        </span>
      </label>

      {/*
          Quick amounts, on the buy side only.
          
          Fixed quote figures make sense for buying: a buyer thinks "ten INJ". They do
          not for selling, where the amount is in tokens whose scale differs by orders
          of magnitude between launches, so a "100" button would be a rounding error on
          one token and someone's whole position on another. Max already covers the
          sell case and covers it exactly.
        */}
      {side === 'buy' && (
        <div className="quick-amounts">
          {/*
              Presets in WHOLE units of the quote, so they read the same whatever the
              pair is priced in. They were raw numbers beside a hardcoded INJ label.
            */}
          {[1, 5, 10, 50].map((v) => (
            <button key={v} type="button" onClick={() => setInput(String(v))}>
              {v} {quoteAsset.label}
            </button>
          ))}
        </div>
      )}

      {quote && !quote.ok && (
        <div className="quote-box">
          <p className="note danger-text" style={{ margin: 0 }}>
            {quote.error}
          </p>
        </div>
      )}

      {quote?.ok && (
        <div className="quote-box">
          <div className="metric-row">
            <span className="k">You receive</span>
            <span className="v mono">
              {quote.side === 'buy'
                ? `${fmt(quote.tokensOut, 18, 2)} ${symbol}`
                : `${fmt(quote.injOut, quoteAsset.decimals, 6)} ${quoteAsset.label}`}
            </span>
          </div>
          <div className="metric-row">
            <span className={premiumBps > 0 && quote.side === 'buy' ? 'k warn-text' : 'k'}>
              {/* Read off the amount beside it, not off a bps constant. It read
                  `chargedBps` during an opening window, the sum of two rates charged
                  in sequence, so the percent was 4.45% above an amount that was
                  4.4155% of the spend. Before that it read `baseBps` on both sides,
                  so a launch with 1% entry and 10% exit labelled the row "Fee · 1%"
                  above a figure that was 10% of the gross. */}
              Fee{feeChargedBps === null ? '' : ` · ${(feeChargedBps / 100).toFixed(2)}%`}
            </span>
            <span className={premiumBps > 0 && quote.side === 'buy' ? 'v mono warn-text' : 'v mono'}>
              {fmt(feeCharged ?? 0n, quoteAsset.decimals, 6)} {quoteAsset.label}
            </span>
          </div>
          {premiumBps > 0 && quote.side === 'buy' && decaySecondsLeft !== null && (
            /*
             * Named, timed, and attributed. A higher fee with no explanation reads as
             * the creator taking more, which is the opposite of what this does: the
             * premium goes into the pool at graduation. The countdown is the point of
             * the rule, so it is shown rather than buried in the rules panel.
             */
            /*
             * AND IT MUST NOT INVITE THE ADDITION THE ROW ABOVE NO LONGER MAKES.
             * This read "3.45% above the curve's 1.00%", two rates a reader adds to
             * 4.45%, which is the figure the fee row was corrected away from. The
             * premium is taken first and the curve's fee is charged on what is left,
             * so the sequence is stated and the combined rate is pointed at rather
             * than restated here, where a third copy of it could drift.
             */
            <p className="note warn-text">
              Opening fee: {(premiumBps / 100).toFixed(2)}% comes off first, then the
              curve&rsquo;s {(baseBps / 100).toFixed(2)}% on what is left, which is the
              combined rate above. It falls to the curve&rsquo;s own fee in{' '}
              {decaySecondsLeft >= 60
                ? `${Math.ceil(decaySecondsLeft / 60)} min`
                : `${decaySecondsLeft}s`}
              . It goes into the pool at graduation, not to the creator, and sells are
              not affected.
            </p>
          )}
                    {(
            <div className="metric-row">
              <span
                className={
                  impactBps === null
                    ? 'k'
                    : impactBps >= IMPACT_SEVERE_BPS
                      ? 'k err-text'
                      : impactBps >= IMPACT_WARN_BPS
                        ? 'k warn-text'
                        : 'k'
                }
              >
                {quote.side === 'buy' ? 'Price impact' : 'Below spot'}
              </span>
              <span
                className={
                  impactBps === null
                    ? 'v mono'
                    : impactBps >= IMPACT_SEVERE_BPS
                      ? 'v mono err-text'
                      : impactBps >= IMPACT_WARN_BPS
                        ? 'v mono warn-text'
                        : 'v mono'
                }
              >
                {impactBps === null ? 'not measurable' : `${(impactBps / 100).toFixed(2)}%`}
              </span>
            </div>
          )}
          {impactBps !== null && impactBps >= IMPACT_SEVERE_BPS && (
            <p className="note err-text">
              {quote.side === 'buy'
                ? 'At this size most of what you spend goes into the curve rather than into tokens. The curve is steepest at the start, so a smaller buy pays a much better price.'
                : 'At this size the curve pays well under the quoted spot price. Selling in smaller pieces recovers more, because each sale moves the price against the next one.'}
            </p>
          )}
          <div className="metric-row">
            <span className="k">Minimum received</span>
            <span className="v mono">
              {quote.side === 'buy'
                ? `${fmt(minOut, 18, 2)} ${symbol}`
                : `${fmt(minOut, quoteAsset.decimals, 6)} ${quoteAsset.label}`}
            </span>
          </div>
          {quote.side === 'buy' && quote.refund > 0n && (
            <div className="metric-row">
              <span className="k warn-text">Refunded · curve full</span>
              <span className="v mono warn-text">
                {fmt(quote.refund, quoteAsset.decimals, 6)} {quoteAsset.label}
              </span>
            </div>
          )}
        </div>
      )}

      {quote?.ok && quote.side === 'buy' && quote.graduates && (
        <p className="note warn-text">
          This buy reaches the graduation target. It closes the curve and moves liquidity on.
        </p>
      )}

      {/*
          THE WALLET CAP, BEFORE THE WALLET OPENS.

          This panel had no cap check at all, so a capped launch priced a buy the curve was
          certain to refuse, enabled the button, and let the refusal arrive inside the block
          with the gas already spent. Reproduced on testnet at ordinary numbers, not at
          extremes: an address 78.5% of the way to its cap was quoted 47,133 tokens for
          0.03 INJ, which is 125,698 against a 100,000 cap.

          Each branch says a different thing, in the order the user needs it. A read that
          failed is the middle case and it says so rather than going quiet, because the rule
          is still live on the chain whatever this page managed to read.
        */}
      {/*
          `account` gates the whole block. Without a connected wallet there is no
          allowance to read, and the middle branch would otherwise tell a visitor their
          allowance could not be read when nothing had been asked for - a false alarm in
          the one place this panel is trying to be trusted about a refusal.
        */}
      {account && capped && side === 'buy' && rules.maxPerWallet !== null && (
        <>
          {overCap === true && (
            <p className="note err-text">
              Over this launch&rsquo;s wallet cap. One address can buy at most{' '}
              {fmt(rules.maxPerWallet, 18, 2)} {symbol} from the curve, and this wallet has{' '}
              {fmt(purchased ?? 0n, 18, 2)} of that, so{' '}
              <strong>{fmt(allowanceLeft ?? 0n, 18, 2)} {symbol}</strong> is the most this buy
              can deliver. Spend less, or sell some to free the allowance.
            </p>
          )}
          {overCap !== true && purchased === null && (
            <p className="note warn-text">
              This launch caps what one address can buy from the curve and your remaining
              allowance could not be read. The curve enforces it either way, so a buy over the
              cap would be refused in the block.
            </p>
          )}
          {overCap !== true && allowanceLeft === 0n && (
            <p className="note err-text">
              This wallet is at the launch&rsquo;s cap of {fmt(rules.maxPerWallet, 18, 2)}{' '}
              {symbol} from the curve. Selling frees the allowance again.
            </p>
          )}
          {overCap !== true && allowanceLeft !== null && allowanceLeft > 0n && (
            <p className="note">
              Wallet cap: you can buy {fmt(allowanceLeft, 18, 2)} more {symbol} from the curve.
              Selling frees the allowance again.
            </p>
          )}
        </>
      )}

      <div className="field">
        <span className="lbl">
          <span>Slippage tolerance</span>
          <span className="mono">{slippagePct}%</span>
        </span>
        <div className="segmented" role="group" aria-label="Slippage tolerance">
          {[0.5, 1, 3].map((p) => (
            <button key={p} aria-pressed={slippagePct === p} onClick={() => setSlippagePct(p)}>
              {p}%
            </button>
          ))}
        </div>
      </div>

      {isDemoMode() ? (
        <button className="go" disabled>
          Demo: trading disabled
        </button>
      ) : !account ? (
        <button className="go" disabled>
          Connect wallet
        </button>
      ) : (
        <button
          className="go"
          onClick={submit}
          /*
           * Disabled only for a reason the user can act on: nothing typed, a quote
           * that failed, trading not open, or a signature already in flight. It is
           * never disabled while a valid trade is sitting there unsigned, which is
           * what the previous unconditional `disabled` amounted to.
           *
           * `overCap === true` is the same test, one step earlier: the trade is not
           * valid, the chain has already decided so, and the only thing signing it
           * achieves is a gas fee. `null` is not `true`, deliberately - a read this
           * page could not make is not a reason to stop someone trading.
           */
          disabled={busy || tradingClosed || !quote?.ok || minOut <= 0n || overCap === true}
        >
          {busy
            ? 'Waiting for your wallet…'
            : overCap === true
              ? 'Over the wallet cap'
              : side === 'buy'
                ? `Buy ${symbol}`
                : `Sell ${symbol}`}
        </button>
      )}

      <TxDialog flow={tx} />

      <p className="note">
        {isDemoMode()
          ? 'This is a demo launch, so there is nothing to sign. The quote above is real arithmetic from the contract maths.'
          : 'Quotes come from the same curve maths the contract runs, checked against it unit for unit.'}
      </p>
      </div>
    </>
  );
}
