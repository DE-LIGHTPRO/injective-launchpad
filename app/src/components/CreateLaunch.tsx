'use client';


import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogoUpload } from './LogoUpload';
import { LaunchPreview } from './LaunchPreview';
import {
  listQuotes,
  denomLabel,
  denomsFromCreator,
  quoteLabel as quoteLabelOf,
  type QuoteAsset,
} from '@/lib/chain';
import { CurveChart } from './CurveChart';
import {
  planLaunch,
  describePlan,
  tickerAlreadyUsed,
  LaunchInputError,
  type LaunchPlan,
} from '@/lib/createLaunch';
import {
  parseAmount,
  fmt,
  maxCollectable,
  quoteBuy,
  validate as validateCurve,
  type CurveConfig,
  type CurveState,
} from '@/lib/curve';
import { NETWORK, getFactoryAddress, getLcdUrl, isDeployed, isEvm } from '@/lib/config';
import {
  FIXED_TOTAL_SUPPLY,
  FIXED_TOTAL_SUPPLY_TOKENS,
  CREATOR_FEE_SHARE_BPS,
  PLATFORM_FEE_SHARE_BPS,
  MAX_INITIAL_BUY_BPS,
  MAX_FEE_BPS,
  DEFAULT_FEE_BPS,
  REWARD_ROUTES,
  initialBuyCeiling,
  fixedCurveFor,
  FIXED_LP_RESERVE,
  CURVE_SUPPLY_TOKENS,
  LP_RESERVE_TOKENS,
  openingReserveWholeFor,
  graduationWholeFor,
  openingMarketCap,
} from '@/lib/launchLimits';
import { useConnectedAccount } from '@/lib/walletStore';
import { TxDialog, useTxFlow } from './TxDialog';
import { profileForChain, profileFieldError, imageSrc } from '@/lib/tokenProfile';
import {
  launchCost,
  launchAffordable,
  denomCreationFeeFor,
  fetchDenomCreationFee,
  launchGasReserveFor,
} from '@/lib/launchCost';
import {
  rulesForChain,
  earlyFeeForChain,
  validateRules,
  openingBuyOverCap,
  describeRules,
  hasAnyRule,
  MAX_EARLY_FEE_BPS,
  type LaunchRules,
  type EarlyFee,
} from '@/lib/launchRules';

/**
 * Create a launch.
 *
 * The form's job is to make the irreversible parts legible before they happen.
 * A launch mints a fixed supply, hands all of it to a curve, and cannot be
 * edited afterwards: the contract stores the config once and nothing can change
 * it, which is the point of a fair launch and also why a typo here is permanent.
 *
 * So the curve is drawn from the real maths as the numbers change, the exact
 * three messages are shown, and the summary names what cannot be undone. The
 * messages come from `planLaunch`, which is a pure function with its own tests,
 * because the construction is the part most likely to be wrong and the part a
 * form cannot verify.
 *
 * SIGNING IS NOT WIRED, deliberately and visibly. Broadcasting needs Injective's
 * protobuf types and a wallet to exercise them, and this codebase has twice
 * recorded what an unexercised transaction builder costs. The button says so
 * rather than failing at the end of a filled-in form.
 */

const ONE = 10n ** 18n;

const DEFAULTS = {
  symbol: '',
  name: '',
  description: '',
  image: '',
  website: '',
  x: '',
  telegram: '',
  maxPerWallet: '',
  tradeStart: '',
  openingFeePct: '',
  openingFeeMins: '10',
  initialBuy: '',
  /*
   * PERCENT, not basis points. These read '100' when the field took bps, and the
   * field now takes percent: left alone the form would have defaulted every launch
   * to a 100% fee, refused by the cap but only after the creator had filled the
   * whole form.
   */
  feeBps: String(DEFAULT_FEE_BPS / 100),
  feeSellBps: String(DEFAULT_FEE_BPS / 100),
  rewardRoute: 'creator',
};

export function CreateLaunch() {
  const [f, setF] = useState(DEFAULTS);
  /*
   * The wallet's gas balance, so the form can refuse a launch it knows cannot land.
   * `null` means not read, which is NOT "insufficient": see `launchAffordable`.
   */
  const [gasBalance, setGasBalance] = useState<bigint | null>(null);
  /** The launchpad's own charge, read from the factory. Zero until it is known. */
  const [launchFee, setLaunchFee] = useState<{ amount: bigint; denom: string }>({
    amount: 0n,
    denom: NETWORK.quoteDenom,
  });
  /*
   * The CHAIN's denom creation fee, which differs per network: testnet charges
   * 1 INJ and mainnet charges 0.1 (measured 12 Oct 2026). Seeded with the measured
   * constant for this network so the form is never wrong while the read is in
   * flight, then replaced by what the chain says.
   */
  const [denomFee, setDenomFee] = useState<bigint>(denomCreationFeeFor(NETWORK.name));
  /*
   * The connected account comes from the shared store, not local state. It used to be
   * a `useState` set only by this page's own ConnectWallet, so connecting in the header
   * (the usual place) left the Sign section still showing "Connect a wallet" even though
   * a wallet was plainly connected. Reading the store means either connect point works,
   * the same way the trade panel reads it.
   */
  const account = useConnectedAccount();
  const router = useRouter();

  /*
   * Read once per connected account, not on every keystroke. The figure only has to
   * be good enough to catch "this wallet plainly cannot pay the 1 INJ denom fee";
   * the chain is still the authority at signing time.
   */
  useEffect(() => {
    if (!account) {
      setGasBalance(null);
      return;
    }
    let live = true;
    void (async () => {
      const [{ denomBalance }, { factoryLaunchFee }] = await Promise.all([
        import('@/lib/wallet'),
        import('@/lib/chain'),
      ]);
      const [b, fee, chainFee] = await Promise.all([
        denomBalance(account.address, NETWORK.gasDenom).catch(() => null),
        factoryLaunchFee().catch(() => ({ amount: 0n, denom: NETWORK.quoteDenom })),
        fetchDenomCreationFee(getLcdUrl()).catch(() => null),
      ]);
      if (!live) return;
      setGasBalance(b);
      setLaunchFee(fee);
      // null is "could not read", which keeps the measured constant rather than
      // replacing it with a zero that would under-report the cost.
      if (chainFee !== null) setDenomFee(chainFee);
    })();
    return () => {
      live = false;
    };
  }, [account]);

  /*
   * The quote assets this launchpad allows, read from the factory.
   *
   * `null` until the read lands, and the picker renders NOTHING in that state and
   * nothing when there is only one. A select with a single option is a control that
   * does nothing, and this launchpad ships with one quote; the picker is the feature
   * that appears when an operator adds a second, not a permanent empty gesture.
   */
  const [quotes, setQuotes] = useState<{ quotes: QuoteAsset[]; defaultDenom: string } | null>(null);
  const [quoteDenom, setQuoteDenom] = useState<string | null>(null);
  /*
   * The chosen pair, resolved once. Its decimals scale the curve and parse the opening
   * buy; its label goes everywhere this form used to say "INJ" regardless of the pair.
   */
  const activeQuote = quoteDenom ?? quotes?.defaultDenom ?? NETWORK.quoteDenom;
  /*
   * The CHOSEN pair's own spec, not the network default. Decimals scale the amounts;
   * `virtualWhole` scales the curve itself, which is what sets the market cap a
   * launch in this pair opens at. One constant for every asset would price a dollar
   * pair at an eighth of an INJ pair's opening cap, and the form would draw it as
   * though it were the same launch.
   */
  const quoteSpec = quotes?.quotes.find((q) => q.denom === activeQuote);
  const quoteDecimals = quoteSpec?.decimals ?? NETWORK.quoteDecimals;
  const quoteVirtualWhole = quoteSpec?.virtualWhole;
  const quoteLabel = quoteLabelOf(activeQuote, quotes?.quotes);
  /*
   * The two figures the card states as this launch's fixed terms, in the chosen pair's
   * whole units. Resolved through the same helpers `fixedCurveFor` builds the curve
   * from, because these rows previously printed the INJ constants under whatever ticker
   * was selected: 676 and 1915 beside E2EUSD for a pair the factory opens at 5354.
   */
  const openingReserve = openingReserveWholeFor({ virtualWhole: quoteVirtualWhole });
  const graduationTarget = graduationWholeFor(openingReserve);
  useEffect(() => {
    let live = true;
    void listQuotes().then((q) => {
      if (!live) return;
      setQuotes(q);
      setQuoteDenom(q.defaultDenom);
    });
    return () => {
      live = false;
    };
  }, []);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The ticker this session has already launched, which must not be launched again. */
  const [createdSymbol, setCreatedSymbol] = useState<string | null>(null);
  const tx = useTxFlow();

  const set = (k: keyof typeof DEFAULTS) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  /*
   * The name and description go on chain as denom metadata, which is the only
 * reason they are asked for: see `TOKEN_DECIMALS` in createLaunch.ts.
 *
 * The curve is derived from four plain numbers rather than asked for in base
   * units. "Total supply" and "share on the curve" are what a creator thinks in;
   * `virtual_tokens` is not, and asking for it directly is how a launch gets a
   * shape nobody intended.
   */
  const built = useMemo((): { curve: CurveConfig; lpReserve: bigint } | { error: string } => {
    /*
     * The curve is POLICY, not input. It used to be derived from four numbers the
     * creator typed, and fixing the supply was supposed to make market caps
     * comparable across the board. On its own it did not: market cap is the spot
     * price times the supply, and the spot price comes from the curve, so two cards
     * showing the same supply still measured different things if one creator had
     * halved the opening reserve.
     *
     * Same for progress to graduation, which was a fraction of a target the creator
     * also chose. `KingOfTheHill` already ranks by market cap rather than progress
     * for exactly that reason, and that workaround is no longer needed.
     *
     * The fee stays a choice: it is a cost, badged per card, and it does not make two
     * launches incomparable the way a different price curve does.
     */
    /*
     * PERCENTAGES IN, BASIS POINTS OUT, converted once. A creator thinks in percent
     * and the contract takes bps, and doing the conversion in two places is how the
     * number shown and the number sent drift apart.
     *
     * `Math.round` on the product, not on the input: 0.05% is 5 bps, and parsing the
     * percent as an integer would refuse every fraction of a percent a creator might
     * reasonably want.
     */
    const asBps = (pct: string, label: string): number | { error: string } => {
      if (pct.trim() === '') return { error: `Enter the ${label} fee.` };
      const n = Number(pct);
      if (!Number.isFinite(n) || n < 0) return { error: `The ${label} fee cannot be negative.` };
      const bps = Math.round(n * 100);
      if (bps > MAX_FEE_BPS) {
        return { error: `The ${label} fee is ${n}%. The most a launch may charge is ${MAX_FEE_BPS / 100}%.` };
      }
      return bps;
    };
    const buy = asBps(f.feeBps, 'buy');
    if (typeof buy !== 'number') return buy;
    const sell = asBps(f.feeSellBps, 'sell');
    if (typeof sell !== 'number') return sell;
    // In the chosen pair's own units, as the factory will build it. Both fees live
    // on the curve, because that is what the quote maths reads.
    const curve: CurveConfig = {
      ...fixedCurveFor({ decimals: quoteDecimals, virtualWhole: quoteVirtualWhole }),
      feeBps: BigInt(buy),
      feeSellBps: BigInt(sell),
    };
    try {
      // Still validated. The constants are hand-written, and a typo in one would
      // otherwise draw a chart for a curve no launch can actually have.
      validateCurve(curve);
    } catch (e) {
      return { error: (e as Error).message };
    }
    return { curve, lpReserve: FIXED_LP_RESERVE };
  }, [f, quoteDecimals, quoteVirtualWhole]);


  // Null until the address is both safe and complete, so a half-typed URL does not
  // fire a request on every keystroke.
  const logoPreview = useMemo(() => imageSrc(f.image), [f.image]);

  /*
   * Rules are parsed from two plain inputs rather than asked for in base units and
   * nanoseconds. A creator thinks in whole tokens and in a local date; the contract
   * wants 1e18 units and a nanosecond epoch, and asking for either directly is how a
   * launch ends up with a cap a thousand times smaller than intended, permanently.
   */
  const builtRules = useMemo((): LaunchRules => {
    let cap: bigint | null = null;
    if (f.maxPerWallet.trim().length > 0) {
      try {
        cap = parseAmount(f.maxPerWallet);
      } catch {
        // Reported by `ruleProblems` below rather than thrown; a half-typed number
        // must not take the panel to the error boundary while someone is typing.
        cap = 0n;
      }
    }
    let start: number | null = null;
    if (f.tradeStart.trim().length > 0) {
      // `datetime-local` has no zone, so it is read in the browser's own, which is the
      // zone the creator is looking at while they type it.
      const ms = new Date(f.tradeStart).getTime();
      start = Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    }
    /*
     * Asked for as a percentage and a number of minutes, which is how a creator
     * thinks about it. Basis points and seconds are what the contract stores, and
     * asking for those directly is how a launch ends up with a ten-second window
     * nobody meant, permanently.
     */
    let earlyFee: EarlyFee | null = null;
    const pct = Number(f.openingFeePct);
    const mins = Number(f.openingFeeMins);
    if (f.openingFeePct.trim().length > 0 && Number.isFinite(pct)) {
      earlyFee = {
        startBps: Math.round(pct * 100),
        seconds: Number.isFinite(mins) ? Math.round(mins * 60) : 0,
      };
    }
    return { maxPerWallet: cap, tradeStart: start, earlyFee, openedAt: start };
  }, [f.maxPerWallet, f.tradeStart, f.openingFeePct, f.openingFeeMins]);

  const ruleProblems = useMemo(
    () =>
      'error' in built
        ? []
        : validateRules(
            builtRules,
            built.curve.curveSupply,
            Math.floor(Date.now() / 1000),
            Number(built.curve.feeBps),
          ),
    [builtRules, built],
  );
  const ruleError = (field: 'maxPerWallet' | 'tradeStart' | 'earlyFee') =>
    ruleProblems.find((p) => p.field === field)?.message ?? null;


  /*
   * The creator's own opening buy, parsed from whole quote units.
   *
   * Zero when blank, which is the honest default: a launch where the creator takes
   * nothing first is a different product from one where they take a position, and the
   * form should not pre-fill a number that changes which one it is.
   */
  const devBuy = useMemo(() => {
    if (f.initialBuy.trim().length === 0) return 0n;
    try {
      // At the pair's decimals: "5" is 5 USDC, not 5 x 10^18 USDC base units.
      const v = parseAmount(f.initialBuy, quoteDecimals);
      return v > 0n ? v : 0n;
    } catch {
      return 0n;
    }
  }, [f.initialBuy, quoteDecimals]);

  /*
   * After `builtRules` and `devBuy`, which it reads. It sat above both, so with a wallet
   * connected it hit the temporal dead zone ("Cannot access 'builtRules' before
   * initialization"); the try/catch below turned that into a form error, and the create
   * flow could never reach the sign step. Order matters for useMemo bodies.
   */
  /*
   * WHAT THIS LAUNCH COSTS IN INJ, and whether the wallet can pay it, worked out
   * BEFORE anything is signed. Injective charges a flat 1 INJ to create a denom and
   * the wallet's balance is already known, so a creator being sent to their wallet
   * to sign a transaction that cannot land is a failure the page chose not to catch.
   */
  const cost = useMemo(
    () =>
      launchCost({
        openingBuy: devBuy,
        launchFee: launchFee.amount,
        launchFeeDenom: launchFee.denom,
        denomFee,
        // Measured per backend: a CosmWasm launch is five messages including a denom
        // creation, an EVM launch is one call. See `launchGasReserveFor`.
        gasReserve: launchGasReserveFor(NETWORK.name),
        quoteDenom: activeQuote,
        gasDenom: NETWORK.gasDenom,
      }),
    [devBuy, activeQuote, launchFee, denomFee],
  );
  const affordable = launchAffordable(gasBalance, cost);

  /*
   * THE OTHER HALF OF F-05: a ticker this wallet has already used cannot be launched
   * again, and the chain is the only thing that knows. The session latch below covers
   * a second click; this covers a reload, a second tab, and a ticker launched days
   * ago, which the latch cannot see.
   *
   * The comparison itself lives in `tickerAlreadyUsed`, with the case sensitivity and
   * the unread case explained there, because a denom is compared byte for byte and
   * `null` is not `false` - two things that are invisible when read inline here.
   */
  const [mine, setMine] = useState<string[] | null>(null);
  useEffect(() => {
    if (!account) {
      setMine(null);
      return;
    }
    let live = true;
    void denomsFromCreator(account.address).then((d) => {
      if (live) setMine(d);
    });
    return () => {
      live = false;
    };
  }, [account, createdSymbol]);
  const tickerTaken = tickerAlreadyUsed(mine, account?.address ?? null, f.symbol);
  /*
   * Either reason is enough, and they are one disable so no path forgets the other.
   * `tickerTaken === true` only: see the null case above.
   */
  const alreadyLaunched =
    tickerTaken === true ||
    (createdSymbol !== null && createdSymbol === f.symbol.trim());

  const plan = useMemo((): { plan: LaunchPlan } | { error: string; field?: string } | null => {
    if ('error' in built) return { error: built.error };
    if (!account) return null;
    const factory = getFactoryAddress();
    try {
      return {
        plan: planLaunch({
          creator: account.address,
          symbol: f.symbol.trim(),
          name: f.name,
          description: f.description,
          rules: { ...rulesForChain(builtRules), ...earlyFeeForChain(builtRules.earlyFee) },
          initialBuy: devBuy,
          // Attached alongside the seed; the factory forwards it to the platform in
          // the same transaction and never holds it.
          launchFee: launchFee.amount > 0n ? launchFee : undefined,
          profile: profileForChain({
            image: f.image,
            website: f.website,
            x: f.x,
            telegram: f.telegram,
            /*
             * STORED ON THE FACTORY, not only in bank metadata. It went to
             * `MsgSetDenomMetadata` alone, and Injective answers a per-denom
             * `denoms_metadata` read with 501, so the one piece of writing on this
             * form was collected and then invisible to every reader. Bank metadata
             * is still set, for wallets that read it their own way.
             */
            description: f.description,
          }),
          curve: built.curve,
          lpReserve: built.lpReserve,
          quoteDenom: quoteDenom ?? undefined,
          rewardRoute: f.rewardRoute as 'creator' | 'pool',
          factory,
        }),
      };
    } catch (e) {
      const err = e as LaunchInputError;
      return { error: err.message, field: err.field as string };
    }
  // `quoteDenom` was missing, so switching the pair did not refresh the signed plan.
  }, [account, built, f, quoteDenom, quoteDecimals]);

  /*
   * Signing, behind the confirmation the user already ticked.
   *
   * `busy` guards re-entry rather than relying on the button's `disabled`: a second
   * click landing while the first prompt is open produces a second transaction with
   * the same sequence number, and the chain rejects one of them after both have been
   * approved. That reads as a launch failing at random.
   */
  const sign = useCallback(async () => {
    if (!account || busy) return;
    if (plan === null || !('plan' in plan)) return;
    setBusy(true);
    try {
      const { broadcastLaunch } = await import('@/lib/broadcast');
      /*
       * `landed`, not `confirmed`: this component already has a `confirmed` state for
       * the checkbox the creator ticks, and a local of the same name shadows it for the
       * whole block. Nothing reads it here today, so nothing is broken - but the next
       * person to add `if (!confirmed) return` at the top of this function, meaning the
       * checkbox, gets a ReferenceError from the temporal dead zone instead, which
       * TypeScript cannot see and no test would catch.
       */
      const landed = await tx.run({
        title: `Create ${f.symbol.trim() || 'launch'}`,
        send: (onStage) =>
          broadcastLaunch({
            plan: plan.plan,
            sender: account.address,
            wallet: account.provider,
            onStage,
          }),
      });
      /*
       * THE BOARD IS SERVER-RENDERED AND NOTHING REFETCHED IT. A creator launched a
       * token, the transaction landed, and the launch did not appear until they
       * reloaded the page by hand. The most important write in the product was the
       * one the refresh guard did not cover, because that guard listed helper names
       * rather than deriving them.
       *
       * `router.refresh()` re-runs the server components against the chain, which is
       * the only honest source for a board: inserting the new launch optimistically
       * would be rendering a launch nobody has read back.
       *
       * ON A CONFIRMATION ONLY. A launch is four messages in one transaction, so a
       * refusal creates nothing at all - and refreshing the board after one would
       * re-read a chain that has not changed, beside a dialog explaining why. The
       * refresh is what makes the new launch appear, so it must follow the launch
       * existing rather than the signature happening.
       */
      /*
       * LATCHED ON THE TICKER THAT LANDED, so the same launch cannot be sent twice.
       *
       * `setBusy(false)` re-armed the button over an unchanged form, and audit F-05
       * caught someone using it: block 143426568 created `ghdsjs`, and eight seconds
       * later block 143426582 ran the same call and failed. The denom already
       * existed, so the second transaction could only ever burn gas, and the chain's
       * refusal is what the creator saw.
       *
       * Keyed on the symbol rather than a bare boolean because a creator launching a
       * SECOND, different token is doing something legitimate: editing the ticker
       * releases the latch, repeating one does not. It also survives the denom read
       * below being unreachable, which is the point of having both.
       */
      if (landed) {
        setCreatedSymbol(f.symbol.trim());
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }, [account, busy, plan, router, tx, f.symbol]);

  /*
   * What that buy actually gets, quoted from the same maths the contract runs. A
   * creator typing "5 INJ" has no idea whether that is 1% of the supply or 40%, and
   * 40% is the number that decides whether anyone else buys at all.
   */
  const devBuyPreview = useMemo(() => {
    if (devBuy <= 0n || 'error' in built) return null;
    try {
      const q = quoteBuy(built.curve, { injCollected: 0n, tokensSold: 0n, graduated: false }, devBuy);
      const total = built.curve.curveSupply + built.lpReserve;
      /*
       * Two denominators on purpose, and they are not interchangeable. `share` is of
       * the TOTAL supply, which is what a holder reads and what the launch page
       * publishes. The CAP is against the curve supply, which is what is actually
       * purchasable and what the contract compares. With an 80/20 split those differ
       * by a quarter, so checking the displayed percentage against the contract's
       * limit would pass a launch the chain then refuses after signing.
       */
      const ceiling = initialBuyCeiling(built.curve.curveSupply);
      return {
        tokens: q.tokensOut,
        share: Number(q.tokensOut) / Number(total),
        overCap: q.tokensOut > ceiling,
        ceiling,
        /*
         * The creator's own cap, which binds the creator. The factory buys with them as
         * recipient on a fresh curve, so it checks the opening buy against
         * `max_per_wallet` and returns `InitialBuyOverCap`. Both fields are optional and
         * setting both is natural, and the combination reverted the launch after signing:
         * the ceiling above only binds past 55 INJ, while a cap of a few million tokens
         * is passed by an opening buy of a few INJ.
         */
        overWalletCap: openingBuyOverCap(builtRules, q.tokensOut),
        walletCap: builtRules.maxPerWallet,
      };
    } catch {
      return null;
    }
  }, [devBuy, built, builtRules]);

  const fresh: CurveState = { injCollected: 0n, tokensSold: 0n, graduated: false };
  // A rule problem blocks the plan as firmly as a bad curve does. Both are permanent
  // once created, and the form is the only place either can still be changed.
  // The opening-buy cap blocks the plan, it does not merely colour a sentence red.
  // The previous version warned at 20% of supply and let the creator sign anyway,
  // which is the create-form-as-guarantee failure: the only thing stopping a creator
  // taking three quarters of their own curve was a paragraph.
  const ok =
    plan !== null &&
    'plan' in plan &&
    ruleProblems.length === 0 &&
    !devBuyPreview?.overCap &&
    !devBuyPreview?.overWalletCap;

  return (
    <>
      <div className="card">
        <h1>Create a launch</h1>
        <p className="note">
          You supply the tokens. Buyers bring {quoteLabel}, and the curve prices every
          trade until it graduates. Nothing here can be edited afterwards, which is what makes it
          a fair launch and also why the numbers are worth checking twice.
        </p>
      </div>

      <div className="card">
        <div className="field">
          <label htmlFor="cl-symbol">
            Ticker <span className="hint">letters, digits, dot, dash, underscore</span>
          </label>
          <input
            id="cl-symbol"
            value={f.symbol}
            onChange={(e) => set('symbol')(e.target.value)}
            placeholder="KAIJU"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="field">
          <label htmlFor="cl-name">
            Name <span className="hint">what wallets show, defaults to the ticker</span>
          </label>
          <input
            id="cl-name"
            value={f.name}
            onChange={(e) => set('name')(e.target.value)}
            placeholder={f.symbol || 'Kaiju Token'}
            autoComplete="off"
          />
        </div>

        {/*
            THE PROFILE FIELDS ARE ABSENT ON THE EVM BACKEND, NOT DISABLED, and the
            difference is the same one rule 14 of the Sealed notes draws about a greyed
            control: a dead input implies a version of this product where the thing can
            be filled in, and there is not one.

            The EVM factory's `createLaunch` takes eleven parameters and none of them is
            a description, an image or a link. `adapt.ts` returns every profile field as
            null for the same reason. So a form that collected them here would take a
            creator's writing, their logo and their socials and drop all of it on the
            floor: the worst kind of field, because nothing errors and the launch looks
            like it worked. Shown once, as a sentence, rather than five times as a
            disabled box.
          */}
        {isEvm() ? (
          <p className="note">
            A description, a logo and links are not part of a launch on this chain: the
            factory stores a name and a ticker and nothing else, so there is nowhere to
            put them. Everything a buyer sees about this token comes off the chain.
          </p>
        ) : (
          <>
          <div className="field">
            <label htmlFor="cl-desc">
              Description <span className="hint">optional, one line</span>
            </label>
            <input
              id="cl-desc"
              value={f.description}
              onChange={(e) => set('description')(e.target.value)}
              placeholder="What this token is for"
              autoComplete="off"
            />
          </div>

          <div className="field">
            <label htmlFor="cl-image">
              Logo <span className="hint">https:// or ipfs:// address of an image</span>
            </label>
            <input
              id="cl-image"
              value={f.image}
              onChange={(e) => set('image')(e.target.value)}
              placeholder="https://… or ipfs://…"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={profileFieldError(f.image) !== null}
            />
            {/*
                The reason is shown per field rather than once at the end. A form with
                four URL inputs and a single "invalid" at the bottom makes the creator
                guess which one, and these are permanent: a profile is immutable.
              */}
            {profileFieldError(f.image) && <p className="note err-text">{profileFieldError(f.image)}</p>}
            {/*
                Above the preview and below the field, because the field is still the
                authority: an upload writes its `ipfs://` address into it, so what gets
                launched is always the value shown, whether it was typed or pinned.
                Renders nothing at all when the deployment has no pinning key.
              */}
            <LogoUpload onUploaded={set('image')} />
            {logoPreview && (
              <div className="logo-preview">
                {/*
                    A preview, because an ipfs:// address that resolves to nothing renders
                    as an empty square forever and nothing on chain will ever say so. The
                    src is the gateway URL, never the raw value.
                  */}
                <img src={logoPreview} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                <span className="note">If this stays blank the address does not resolve to an image.</span>
              </div>
            )}
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="cl-website">
                Website <span className="hint">optional</span>
              </label>
              <input
                id="cl-website"
                value={f.website}
                onChange={(e) => set('website')(e.target.value)}
                placeholder="https://"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={profileFieldError(f.website) !== null}
              />
              {profileFieldError(f.website) && (
                <p className="note err-text">{profileFieldError(f.website)}</p>
              )}
            </div>
            <div className="field">
              <label htmlFor="cl-x">
                X <span className="hint">optional</span>
              </label>
              <input
                id="cl-x"
                value={f.x}
                onChange={(e) => set('x')(e.target.value)}
                placeholder="https://x.com/"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={profileFieldError(f.x) !== null}
              />
              {profileFieldError(f.x) && <p className="note err-text">{profileFieldError(f.x)}</p>}
            </div>
          </div>

          <div className="field">
            <label htmlFor="cl-tg">
              Telegram <span className="hint">optional</span>
            </label>
            <input
              id="cl-tg"
              value={f.telegram}
              onChange={(e) => set('telegram')(e.target.value)}
              placeholder="https://t.me/"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={profileFieldError(f.telegram) !== null}
            />
            {profileFieldError(f.telegram) && (
              <p className="note err-text">{profileFieldError(f.telegram)}</p>
            )}
          </div>
          </>
        )}

        <div className="field-row">
          <div className="field">
            {/*
              * NOT AN INPUT, and not a disabled one either. A greyed-out field implies
              * a version of this form where the number can be changed, and there
              * isn't one: the factory refuses any total but this. Stated as a fact,
              * with the reason, because a creator who wanted 10M tokens deserves to
              * know why they cannot have them rather than to find a dead control.
              */}
            <span className="field-label">Total supply</span>
            <div className="fixed-value">
              <span className="mono">{FIXED_TOTAL_SUPPLY_TOKENS.toLocaleString('en-US')}</span>
              <span className="chip chip-sm muted">fixed</span>
            </div>
            {/*
                "THE SAME CURVE" IS A CLAIM ABOUT THE FACTORY AND IT IS NOT TRUE OF IT.
                The supply really is fixed: `CURVE_SUPPLY` and `LP_RESERVE` are factory
                constants and no caller can change them. The CURVE is not. `createLaunch`
                takes `virtualInj` and `graduationTarget` as parameters, and the live PAD
                launch uses 30 and 85 INJ against this form's 676 and 1,915 - so the one
                launch on the board is the counterexample to the sentence under the form
                that made it.
                
                What this form offers is a DEFAULT, and the honest version says so. The
                alternative was enforcing it in the factory, which would make the sentence
                true and also take away a parameter launches are already using.
              */}
            <p className="note">
              The supply is the same for every launch here and cannot be changed. This
              form also fills in one curve shape for everyone, which is what makes prices
              and market caps comparable across launches that use it - but the contract
              accepts other shapes, so a launch created another way may not line up.
            </p>
          </div>
          <div className="field">
            <span className="field-label">
              On the curve <span className="hint">% of supply</span>
            </span>
            <div className="fixed-value">
              <span className="mono">{CURVE_SUPPLY_TOKENS.toLocaleString('en-US')}</span>
              <span className="chip chip-sm muted">fixed</span>
            </div>
            <p className="note">
              The other {LP_RESERVE_TOKENS.toLocaleString('en-US')} is held back and
              paired against the {quoteLabel} raised when the launch graduates.
            </p>
          </div>
        </div>

        {/*
          * Stated, not entered. These were three inputs, and they are the reason a
          * fixed supply alone did not make the board comparable: market cap is the
          * spot price times the supply, and the price comes from the curve. A creator
          * who halved the opening reserve opened at a different price with the same
          * supply, so the headline figure on two cards measured different things.
          */}
        <div className="field-row">
          <div className="field">
            <span className="field-label">
              Graduates at <span className="hint">{quoteLabel} raised</span>
            </span>
            <div className="fixed-value">
              <span className="mono">
                {graduationTarget.toLocaleString('en-US')} {quoteLabel}
              </span>
              <span className="chip chip-sm muted">fixed</span>
            </div>
          </div>
          <div className="field">
            <span className="field-label">
              Opening reserve <span className="hint">sets the starting price</span>
            </span>
            <div className="fixed-value">
              <span className="mono">
                {openingReserve.toLocaleString('en-US')} {quoteLabel}
              </span>
              <span className="chip chip-sm muted">fixed</span>
            </div>
            {/*
             * THE RESERVE IS THE INPUT; THE MARKET CAP IS WHAT IT MEANS. A virtual
             * reserve is an implementation detail of the curve, and a creator reading
             * "676 INJ" beside the word "fixed" has no way to turn it into the thing
             * they actually want to know. `openingMarketCap` is the figure the reserve
             * policy was chosen FOR, and it was derivable and shown nowhere.
             *
             * Passed the RESOLVED reserve, never the INJ default, which is the defect
             * these two rows already had.
             */}
            <p className="note">
              That opens this launch at a market cap of{' '}
              <span className="mono">
                {Math.round(openingMarketCap(openingReserve)).toLocaleString('en-US')}{' '}
                {quoteLabel}
              </span>
              . Every launch created from this form opens at the same price, so being
              early on one is worth what it is worth on any other.
            </p>
          </div>
        </div>

        <div className="field-row">
          {/*
              TWO FEES, because entry and exit are not the same decision. Shown as
              percentages because that is how a creator thinks about a fee and how
              every other launchpad states it; the contract takes bps and the
              conversion happens once, here.
            */}
          <div className="field">
            <label htmlFor="cl-fee">
              Buy fee <span className="hint">%, up to {MAX_FEE_BPS / 100}</span>
            </label>
            <input
              id="cl-fee"
              value={f.feeBps}
              onChange={(e) => set('feeBps')(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <div className="field">
            <label htmlFor="cl-fee-sell">
              Sell fee <span className="hint">%, up to {MAX_FEE_BPS / 100}</span>
            </label>
            <input
              id="cl-fee-sell"
              value={f.feeSellBps}
              onChange={(e) => set('feeSellBps')(e.target.value)}
              inputMode="decimal"
            />
          </div>
          <div className="field">
            <span className="field-label">
              Your share goes <span className="hint">set once, cannot change</span>
            </span>
            <div className="segmented" role="group" aria-label="Where your fee share goes">
              {REWARD_ROUTES.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  aria-pressed={f.rewardRoute === r.value}
                  onClick={() => set('rewardRoute')(r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <p className="note">
              {REWARD_ROUTES.find((r) => r.value === f.rewardRoute)?.detail}
            </p>
            {/*
                NOT "to holders", and the absence is deliberate. Paying holders needs
                a holder list, and Injective answers `denom_owners` with
                not-implemented for a tokenfactory denom; a claim-based version is
                gameable by buying immediately before claiming. The pool is the
                honest version: it benefits everyone still holding rather than
                whoever happened to hold at a snapshot.
              */}
            <p className="note">
              {isEvm()
                ? 'Paying holders directly is not possible here: the token has no transfer hook, deliberately, so nothing watches who holds what. The pool is the closest honest version.'
                : 'Paying holders directly is not possible on Injective: a token transfer runs no contract code, so nothing can see who holds what. The pool is the closest honest version.'}
            </p>
          </div>

          {quotes !== null && quotes.quotes.length > 1 && (
            <div className="field">
              <label htmlFor="cl-quote">
                Paired with <span className="hint">what buyers pay in</span>
              </label>
              <select
                id="cl-quote"
                value={quoteDenom ?? quotes.defaultDenom}
                onChange={(e) => setQuoteDenom(e.target.value)}
              >
                {quotes.quotes.map((q) => (
                  <option key={q.denom} value={q.denom}>
                    {q.symbol ?? denomLabel(q.denom)}
                  </option>
                ))}
              </select>
              <p className="note">
                The curve is the same shape in every pair, scaled to that
                asset&rsquo;s own decimals. Launches in different pairs are not
                directly comparable on the board.
              </p>
            </div>
          )}
          <div className="field">
            {/*
              * Also not an input. It was one, capped at the whole fee, which made the
              * platform's share something a creator could set to zero: every rational
              * creator would, so the split was 100/0 and our side of it was a number
              * that accrued nothing. It is policy now, at the same 70/30 nearly.trade
              * and ponsfamily.com both use, and it is shown rather than hidden
              * because a creator earning from their launch is the point of it.
              */}
            <span className="field-label">Your share of the fee</span>
            <div className="fixed-value">
              <span className="mono">{CREATOR_FEE_SHARE_BPS / 100}%</span>
              <span className="chip chip-sm muted">fixed</span>
            </div>
            <p className="note">
              {CREATOR_FEE_SHARE_BPS / 100}% of the buy and sell fees you set above is
              yours, claimable from your launch at any time. The other{' '}
              {PLATFORM_FEE_SHARE_BPS / 100}% runs this launchpad. An opening fee is not
              split: the part above your rate goes into the pool at graduation.
            </p>
          </div>
        </div>
      </div>

      {'error' in built && (
        /*
          * The reason, where the curve would have been.
          *
          * `built.error` existed and was used only to HIDE this card and to block the
          * plan. Nothing rendered it, so a bad number produced a form that silently
          * dropped its most informative panel and offered no explanation: the curve
          * simply vanished. Showing it here puts the sentence exactly where the
          * missing thing was.
          */
        <div className="card">
          <h2>The curve this makes</h2>
          <p className="note err-text">{built.error}</p>
          <p className="note">
            Fix that and the shape appears here, drawn from the same maths the contract
            charges.
          </p>
        </div>
      )}

      {!('error' in built) && (
        <div className="card">
          <h2>The curve this makes</h2>
          <p className="note">
            Drawn from the same maths the contract charges, so this is the shape buyers will
            actually pay.
          </p>
          {/*
            * The quote travels with the curve. `CurveChart` defaults to INJ at 18
            * decimals, which is right for the default pair and silently wrong for any
            * other: called bare, this chart labelled its axis `0 INJ raised` and
            * `0.0 INJ` for an E2EUSD curve the row below said tops out at
            * 15,689.37 E2EUSD, the ceiling collapsing to one decimal place because a
            * 6-decimal reserve was divided by 1e18. The component's own docblock
            * records that defect as fixed; the default reinstated it one call site over.
            */}
          <CurveChart
            config={built.curve}
            state={fresh}
            height={150}
            quoteLabel={quoteLabel}
            quoteDecimals={quoteDecimals}
          />
          <div style={{ marginTop: 'var(--space-4)' }}>
            <div className="metric-row">
              <span className="k">On the curve</span>
              <span className="v mono">{fmt(built.curve.curveSupply, 18, 0)}</span>
            </div>
            <div className="metric-row">
              <span className="k">Held back for liquidity</span>
              <span className="v mono">{fmt(built.lpReserve, 18, 0)}</span>
            </div>
            <div className="metric-row">
              <span className="k">Curve ceiling</span>
              <span className="v mono">
                {fmt(maxCollectable(built.curve), quoteDecimals, 2)} {quoteLabel}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Launch rules</h2>
        <p className="note">
          Optional. Both are enforced by the curve contract on every buy and sell until
          this launch graduates. Afterwards it trades against its locked pool and neither applies.
        </p>

        {/*
            OFFERED ONLY WHERE THE CONTRACT ENFORCES IT.
            A cap the chain does not apply is worse than no cap: a creator sets it,
            the launch page displays it, and a buyer reads it as a protection. The
            EVM contracts carry no LaunchRules, so the control is absent there rather
            than present and inert.
          */}
        <div className="field-row" style={{ marginTop: 'var(--space-4)' }}>
          <div className="field">
            <label htmlFor="cl-cap">
              Max per wallet <span className="hint">tokens, blank for no cap</span>
            </label>
            <input
              id="cl-cap"
              value={f.maxPerWallet}
              onChange={(e) => set('maxPerWallet')(e.target.value)}
              placeholder="no cap"
              inputMode="decimal"
              aria-invalid={ruleError('maxPerWallet') !== null}
            />
            {ruleError('maxPerWallet') && <p className="note err-text">{ruleError('maxPerWallet')}</p>}
          </div>
          <div className="field">
            <label htmlFor="cl-start">
              Buying opens <span className="hint">your local time, blank for immediately</span>
            </label>
            <input
              id="cl-start"
              type="datetime-local"
              value={f.tradeStart}
              onChange={(e) => set('tradeStart')(e.target.value)}
              aria-invalid={ruleError('tradeStart') !== null}
            />
            {ruleError('tradeStart') && <p className="note err-text">{ruleError('tradeStart')}</p>}
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="cl-openfee">
              {/*
                * The cap named here is MAX_EARLY_FEE_BPS, not the MAX_FEE_BPS the buy
                * and sell fields carry: the opening fee is allowed to be double the
                * base rate. Stating the wrong one of the two is the defect
                * `fee-ceiling-claims.test.ts` exists for.
                */}
              Opening fee{' '}
              <span className="hint">%, up to {MAX_EARLY_FEE_BPS / 100}, blank for none</span>
            </label>
            <input
              id="cl-openfee"
              value={f.openingFeePct}
              onChange={(e) => set('openingFeePct')(e.target.value)}
              placeholder="none"
              inputMode="decimal"
              aria-invalid={ruleError('earlyFee') !== null}
            />
            {ruleError('earlyFee') && <p className="note err-text">{ruleError('earlyFee')}</p>}
          </div>
          <div className="field">
            <label htmlFor="cl-openmins">
              Falling over <span className="hint">minutes</span>
            </label>
            <input
              id="cl-openmins"
              value={f.openingFeeMins}
              onChange={(e) => set('openingFeeMins')(e.target.value)}
              inputMode="decimal"
              disabled={f.openingFeePct.trim().length === 0}
            />
          </div>
        </div>

        {/*
            NO OPENING BUY ON THE EVM BACKEND, because the factory cannot do one.
            `createLaunch` takes eleven parameters and not one of them is an amount to
            spend, so a figure typed here would be collected, validated, previewed with
            its share of the supply, and then not sent - and the launch would succeed,
            which is what makes that the worst possible outcome. `validateLaunch`
            refuses it rather than dropping it, and the field is absent rather than
            disabled for the reason the profile fields above are.

            A creator there is not prevented from buying first; they buy from their own
            curve in a second transaction, at the opening price, like anybody else. That
            is a fairer arrangement than this field describes, so it is worth saying
            plainly rather than leaving as an unexplained gap.
          */}
        {isEvm() ? (
          <p className="note">
            There is no opening buy here: the launch transaction creates the curve and
            nothing else. Once it exists you can buy from it at the opening price in a
            second transaction, in the same queue as everyone else.
          </p>
        ) : (
          <>
          <div className="field">
            <label htmlFor="cl-devbuy">
              Your opening buy <span className="hint">{quoteLabel}, blank for none</span>
            </label>
            <input
              id="cl-devbuy"
              value={f.initialBuy}
              onChange={(e) => set('initialBuy')(e.target.value)}
              placeholder="none"
              inputMode="decimal"
            />
            {devBuyPreview && (
              /*
                  The SHARE, not just the token count. A creator typing "5 INJ" cannot
                  tell whether that is 1% of the supply or 40%, and 40% is the figure
                  that decides whether anyone else buys. It is also the number the
                  launch page will show every visitor, so showing it here is showing
                  them what everyone else will see.
                */
              <p
                className={`note ${
                  devBuyPreview.overCap || devBuyPreview.overWalletCap ? 'err-text' : ''
                }`}
              >
                That buys about {fmt(devBuyPreview.tokens, 18, 0)}{' '}
                {f.symbol.trim() || 'tokens'}, roughly{' '}
                <strong>{(devBuyPreview.share * 100).toFixed(1)}% of the supply</strong>, in
                the same transaction and before anyone else can buy.
                {devBuyPreview.overCap && (
                  <>
                    {' '}
                    The contract refuses this: an opening buy cannot exceed{' '}
                    {MAX_INITIAL_BUY_BPS / 100}% of the curve, which is about{' '}
                    {fmt(devBuyPreview.ceiling, 18, 0)} {f.symbol.trim() || 'tokens'}.
                    Reduce the amount.
                  </>
                )}
                {/*
                    The creator's own cap refuses the creator, which is the half nothing
                    said. Named separately from the ceiling above because they are
                    different limits with different remedies: the ceiling is ours and
                    fixed, this one the creator set a few fields up and can lower or
                    raise. Both are stated rather than one standing in for the other.
                  */}
                {devBuyPreview.overWalletCap && devBuyPreview.walletCap !== null && (
                  <>
                    {' '}
                    Your own wallet cap refuses it: you capped every buyer at{' '}
                    {fmt(devBuyPreview.walletCap, 18, 0)} {f.symbol.trim() || 'tokens'}, and
                    that cap counts against you too, so the launch would fail after you
                    signed. Lower the opening buy or raise the cap.
                  </>
                )}
              </p>
            )}
          </div>
          </>
        )}

        {hasAnyRule(builtRules) && ruleProblems.length === 0 && (
          <div style={{ marginTop: 'var(--space-4)' }}>
            <ul className="plan">
              {describeRules(
                builtRules,
                (v) => fmt(v, 18, 0),
                (s) => new Date(s * 1000).toLocaleString(),
              ).lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            {/*
                The limits, stated here rather than discovered later. A cap is per
                address, so one person with several addresses gets several caps, and
                no on-chain rule fixes that. Saying so is the difference between a
                fair-launch tool and a promise the product cannot keep.
              */}
            <p className="note">
              {describeRules(builtRules, (v) => fmt(v, 18, 0), (s) => new Date(s * 1000).toLocaleString()).scope}
            </p>
          </div>
        )}

        {/*
            There is no transfer rule here, and the reason is worth stating once on the
            page rather than letting a creator look for one.

            IT IS A DIFFERENT REASON ON EACH BACKEND, and only one of them is about the
            chain. An Injective tokenfactory denom is a bank denom and a bank send runs
            no contract code, so nothing CAN run on a transfer. An ERC-20 transfer runs
            plenty of contract code and a hook is perfectly possible: `LaunchToken`
            simply does not have one, and overrides nothing, because "nobody can change
            the supply and nothing watches your transfers" is a simpler promise than a
            list of what the hook does and does not do. Calling that a limit of the
            chain would be a convenient untruth - it is a choice, and it is ours.
          */}
        <p className="note">
          {isEvm()
            ? 'Rules are not attached to transfers here, by choice: the token inherits a plain ERC-20 and overrides nothing, so no code of ours runs when you move it. What the curve enforces is every trade it settles, which is every trade until graduation.'
            : 'Rules cannot be attached to transfers on Injective: a tokenfactory denom is a bank denom, and a bank send runs no contract code. What the curve can enforce is every trade it settles, which is every trade until graduation.'}
        </p>
      </div>

      {/*
          THE PREVIEW SITS ABOVE SIGN, not beside the fields. A launch is immutable,
          and until now the only way to check it was to scroll back up and reread the
          boxes you filled in yourself, which is the worst way to catch a mistake in
          them. It renders only when the form is coherent: a preview of an invalid
          launch would show figures the contract will never accept.
        */}
      {!('error' in built) && (
        <LaunchPreview
          symbol={f.symbol}
          name={f.name}
          description={f.description}
          image={f.image}
          quoteLabel={quoteLabel}
          quoteDecimals={quoteDecimals}
          buyFeePct={Number(built.curve.feeBps) / 100}
          sellFeePct={Number(built.curve.feeSellBps) / 100}
          rewardRoute={f.rewardRoute as 'creator' | 'pool'}
          rules={builtRules}
          openingBuy={devBuy}
          openingBuyShare={devBuyPreview?.share ?? null}
          profile={{
            image: f.image || null,
            website: f.website || null,
            x: f.x || null,
            telegram: f.telegram || null,
            description: f.description || null,
          }}
        />
      )}

      <div className="card">
        <h2>Sign</h2>

        {/*
            Said FIRST, and said once.
            
            Without a factory the form still accepts every field and only refuses at
            the end, after someone has chosen a ticker, a supply, a curve shape and
            three rules. The information that none of it can be submitted was available
            before they typed anything, and withholding it until the last step is the
            same defect as an inviting button on a quote that cannot execute.
          */}
        {!isDeployed() && (
          <p className="note warn-text">
            No launchpad contracts are deployed on {NETWORK.label} yet, so nothing here
            can be submitted. The curve above is real arithmetic and the messages below
            are the ones that will be sent once there is a factory to send them to.
          </p>
        )}

        {!account && (
          <>
{/*
              NO SECOND CONNECT BUTTON. The header is `position: sticky`, so its
              "Connect wallet" is on screen at every scroll position, and an identical
              button here put two of the same control in view at once: a reader has to
              work out whether they do different things, and they do not.

              The sentence stays, because the reason this section is empty still needs
              saying. It names where the control is rather than repeating it.
            */}
            <p className="note">
              Connect a wallet, using the button in the header, to see exactly what
              would be signed.
            </p>
          </>
        )}

        {account && plan && 'error' in plan && (
          <p className="note danger-text">{plan.error}</p>
        )}

        {account && ok && 'plan' in plan && (
          <>
            <ul className="plan">
              {!('error' in built) &&
                describePlan(plan.plan, built.curve, built.lpReserve, devBuy, {
                  label: quoteLabel,
                  decimals: quoteDecimals,
                }).map((l) => (
                  <li key={l}>{l}</li>
                ))}
            </ul>

            {/*
                WHATEVER IS ACTUALLY GOING TO BE SENT, which is five CosmWasm messages
                on one backend and one factory call on the other. The summary counted
                the messages and the body printed `plan.messages`, so on the EVM build
                it promised five messages and rendered `[]` - a disclosure panel that
                disclosed nothing, under a heading that was wrong about what it was
                hiding. Both read off the plan, so neither can be wrong about the other.

                `bigint` does not survive `JSON.stringify`, which throws on it rather
                than skipping it: without the replacer this panel took the whole page
                to the error boundary the moment an EVM plan existed.
              */}
            <details className="raw">
              <summary>
                {plan.plan.evm
                  ? 'The call, exactly as it will be sent'
                  : 'The five messages, exactly as they will be sent'}
              </summary>
              {/* Focusable because it scrolls in both axes: see `.raw pre:focus-visible`. */}
              <pre tabIndex={0}>
                {JSON.stringify(
                  plan.plan.evm ?? plan.plan.messages,
                  (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
                  2,
                )}
              </pre>
            </details>

            <label className="toggle" style={{ marginTop: 'var(--space-4)' }}>
              <input
                id="cl-confirm"
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {/*
                  "THE RIGHT TO MINT MORE IS GIVEN UP" IS NOT TRUE ON THE EVM BACKEND,
                  and it is the one sentence a creator ticks a box to say they have read.
                  There is no such right there to give up: `LaunchToken` has no mint
                  function, so the supply is fixed by the absence of code rather than by
                  a key being handed over. Nor does the supply leave the creator's
                  wallet - it is minted straight to the curve and never touches them.
                  Two false clauses in the one place on the page where being exact is
                  the whole point of the control.
                */}
              <span>
                {plan.plan.evm
                  ? 'I understand the supply is fixed at creation and goes straight to the launch contract, that no mint function exists so none can ever be added, and that none of this can be changed afterwards.'
                  : 'I understand the supply is fixed, all of it leaves my wallet, the right to mint more is given up for good, and none of this can be changed afterwards.'}
              </span>
            </label>

            {/*
                THE COST, ITEMISED, and a refusal when the wallet plainly cannot pay
                it. `affordable === false` only when a balance was actually read:
                `null` is "not known" and must not block a launch, because an
                unreachable LCD says nothing about whether the wallet is funded.

                EVERY FIGURE HERE IS THE GAS ASSET, so every one is scaled by
                `gasDecimals` and labelled `gasSymbol` - not the quote's, and not
                this launch's `quoteDecimals` from line 194. `launchCost` zeroes
                the launchpad fee and the opening buy unless they are in `gasDenom`
                precisely so that this total is one asset and can be compared
                against one balance.
              */}
            <div className="metric-row">
              <span className="k">
                Costs to create{' '}
                {/*
                    THE DENOM FEE IS NOT ITEMISED WHERE IT IS NOT CHARGED. There is no
                    tokenfactory on the EVM backend, so `denomCreationFeeFor` returns
                    zero there and naming a "0.00 Injective denom fee" would invent a
                    line item for a charge that does not exist on that chain.
                  */}
                <span className="note">
                  (
                  {cost.denomFee > 0n
                    ? `${fmt(cost.denomFee, NETWORK.gasDecimals, 2)} Injective denom fee`
                    : 'gas'}
                  {cost.launchFee > 0n
                    ? `, ${fmt(cost.launchFee, NETWORK.gasDecimals, 2)} launchpad fee`
                    : ''}
                  {cost.openingBuy > 0n
                    ? `, ${fmt(cost.openingBuy, NETWORK.gasDecimals, 4)} opening buy`
                    : ''}
                  {cost.denomFee > 0n ? ', plus gas' : ''})
                </span>
              </span>
              <span className="v mono">
                {fmt(cost.total, NETWORK.gasDecimals, 4)} {NETWORK.gasSymbol}
              </span>
            </div>
            {affordable === false && (
              <p className="note err-text">
                This wallet holds {fmt(gasBalance ?? 0n, NETWORK.gasDecimals, 4)}{' '}
                {NETWORK.gasSymbol}. Creating a token costs{' '}
                {fmt(cost.total, NETWORK.gasDecimals, 4)} {NETWORK.gasSymbol}
                {cost.denomFee > 0n
                  ? ", most of it Injective\u2019s own one-off charge for a new denom"
                  : ''}
                . Top the wallet up and this will unlock.
              </p>
            )}

            {alreadyLaunched && (
              /*
               * Named before the button is reached, because a disabled button with no
               * reason reads as the page being broken. Which of the two reasons it is
               * matters to the creator: one is "you just did this", the other is "this
               * wallet did this at some point", and the second is the one that needs a
               * new ticker rather than a reload.
               */
              /*
               * BOTH SENTENCES MAKE A CLAIM ABOUT THE CHAIN, and on the EVM backend both
               * were false. A tokenfactory denom is globally unique and `MsgCreateDenom`
               * refuses a duplicate, which is what "would be refused by the chain" and
               * "a ticker can only be used once per wallet" describe. An ERC-20 symbol is
               * a string in storage and the factory does not look at it: a second launch
               * with the same ticker is accepted, deploys, and works. So there the block
               * is ours, to stop an accident, and it has to say so - telling a creator
               * the chain will refuse something it will happily do is the kind of claim
               * this project writes guards for.
               */
              <p className="note warn-text">
                {createdSymbol !== null && createdSymbol === f.symbol.trim()
                  ? isEvm()
                    ? `${f.symbol.trim()} was just created from this wallet. Change the ticker to launch another token: this chain would let you launch a second ${f.symbol.trim()}, which is almost never what anyone means.`
                    : `${f.symbol.trim()} was just created from this wallet. Change the ticker to launch another token: sending this one again would be refused by the chain and the gas would be spent.`
                  : isEvm()
                    ? `This wallet has already launched ${f.symbol.trim()} here. This chain does not reserve tickers, so a second one would deploy and trade alongside the first. Pick another unless that is really what you want.`
                    : `This wallet has already created ${f.symbol.trim()}. A ticker can only be used once per wallet, so pick another one.`}
              </p>
            )}

            <button
              className="go"
              disabled={!confirmed || busy || affordable === false || alreadyLaunched}
              onClick={() => void sign()}
            >
              {busy
                ? 'Waiting for your wallet…'
                : alreadyLaunched
                  ? `${f.symbol.trim()} already exists`
                  : `Create ${f.symbol.trim() || 'launch'}`}
            </button>

            <TxDialog flow={tx} />

            {/*
                THE LABEL WAS HONEST AND THEN IT WAS NOT, which is the subtler half of
                audit F-10. It said "this signing path has not yet been run against a
                chain", written when the encoding had never left a unit test and I
                could not run it, since that needs a wallet extension. It has been run
                since: the audit's own F-05 evidence is two create transactions in
                testnet blocks 143426568 and 143426582, the first of which created a
                launch. A caution that has stopped being true costs the same as a
                missing one, because the next true caution reads like this one.

                What has NOT been exercised is mainnet, so that is what the caution is
                scoped to now, and it is scoped by the network the build is pointed at
                rather than by a flag somebody has to remember to clear. The structural
                reassurance is unchanged and is why this was safe to offer either way:
                all five messages are one transaction, so a mis-built launch is a
                refused transaction rather than a denom with no curve behind it.

                THE EVM BACKEND IS A THIRD CASE AND NEITHER SENTENCE FITS IT. It is one
                call, not five messages; it has been exercised on that chain's mainnet,
                because that is the only chain it has (Injective EVM is 1776 and there
                is no testnet deployment of this factory), so the mainnet caution would
                be both wrong and permanently stuck on. What IS worth saying is that the
                call is simulated before anything is signed, which the other backend
                does too and which is new on this one.

                AND THIS ONE STAYS A NAME TEST, unlike the chip in the header and the
                sentence on /risks, which moved to `NETWORK.realFunds`. Those ask "is a
                balance here money". This asks something narrower and unrelated: has
                THIS signing path been exercised on Injective's CosmWasm mainnet. The
                two answers coincide today and they are not the same question, so
                `realFunds` would be the right value for the wrong reason - and would
                stop being the right value the moment a fourth network appeared.
              */}
            <p className="note">
              {isEvm()
                ? 'The launch is one call, run against the chain first so a mis-built one is refused before your wallet opens and costs nothing. It deploys the token and the curve together: either both exist or neither does.'
                : NETWORK.name === 'mainnet'
                  ? 'This signing path has been exercised on testnet and not yet on mainnet. All five messages go in a single transaction, so if anything is wrong the chain refuses the whole thing and nothing is created.'
                  : 'All five messages go in a single transaction, so if anything is wrong the chain refuses the whole thing and nothing is created.'}
            </p>
          </>
        )}
      </div>
    </>
  );
}
