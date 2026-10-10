'use client';

import { useCallback, useMemo, useState } from 'react';
import { ConnectWallet } from './ConnectWallet';
import { CurveChart } from './CurveChart';
import {
  planLaunch,
  describePlan,
  LaunchInputError,
  type LaunchPlan,
} from '@/lib/createLaunch';
import { parseAmount, fmt, maxCollectable, quoteBuy, type CurveConfig, type CurveState } from '@/lib/curve';
import { NETWORK, getFactoryAddress, isDeployed } from '@/lib/config';
import {
  FIXED_TOTAL_SUPPLY,
  FIXED_TOTAL_SUPPLY_TOKENS,
  CREATOR_FEE_SHARE_BPS,
  PLATFORM_FEE_SHARE_BPS,
  MAX_INITIAL_BUY_BPS,
  initialBuyCeiling,
} from '@/lib/launchLimits';
import type { WalletAccount } from '@/lib/wallet';
import { profileForChain, profileFieldError, imageSrc } from '@/lib/tokenProfile';
import {
  rulesForChain,
  earlyFeeForChain,
  validateRules,
  describeRules,
  hasAnyRule,
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
  curveShare: '80',
  target: '85',
  virtualInj: '30',
  feeBps: '100',
};

export function CreateLaunch() {
  const [f, setF] = useState(DEFAULTS);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);

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
    try {
      const total = FIXED_TOTAL_SUPPLY;
      const sharePct = Number(f.curveShare);
      if (!Number.isFinite(sharePct) || sharePct <= 0 || sharePct >= 100) {
        return { error: 'The share on the curve is a percentage above 0 and below 100.' };
      }

      // Integer arithmetic throughout: a percentage of 1e27 through a float
      // loses the low digits of the supply.
      const curveSupply = (total * BigInt(Math.round(sharePct * 100))) / 10_000n;
      /*
       * The REMAINDER, never a second percentage. The factory refuses any total but
       * exactly 1e27 base units, so a reserve computed as its own share of the supply
       * would be refused on chain for a rounding error of one base unit at some
       * percentages, and the form would look correct while doing it.
       */
      const lpReserve = total - curveSupply;
      if (curveSupply <= 0n || lpReserve <= 0n) {
        return { error: 'That split leaves nothing on one side.' };
      }

      /*
       * `virtual_tokens` must exceed `curve_supply`, and the gap sets how far the
       * curve runs before its asymptote. A fixed ratio keeps the shape sane
       * whatever the supply, and the contract validates it again anyway.
       */
      const virtualTokens = (curveSupply * 13_413n) / 10_000n;

      const curve: CurveConfig = {
        virtualInj: parseAmount(f.virtualInj || '0'),
        virtualTokens,
        curveSupply,
        graduationTarget: parseAmount(f.target || '0'),
        feeBps: BigInt(Math.round(Number(f.feeBps) || 0)),
      };
      return { curve, lpReserve };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [f]);

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
          profile: profileForChain({
            image: f.image,
            website: f.website,
            x: f.x,
            telegram: f.telegram,
          }),
          curve: built.curve,
          lpReserve: built.lpReserve,
          factory,
        }),
      };
    } catch (e) {
      const err = e as LaunchInputError;
      return { error: err.message, field: err.field as string };
    }
  }, [account, built, f]);

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
    setSignError(null);
    try {
      const { broadcastLaunch } = await import('@/lib/broadcast');
      const { txHash } = await broadcastLaunch({
        plan: plan.plan,
        sender: account.address,
        wallet: account.provider,
      });
      setResult(txHash);
    } catch (e) {
      const err = e as Error & { kind?: string };
      setSignError(err.message || 'The launch could not be signed.');
    } finally {
      setBusy(false);
    }
  }, [account, busy, plan]);

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
      const v = parseAmount(f.initialBuy);
      return v > 0n ? v : 0n;
    } catch {
      return 0n;
    }
  }, [f.initialBuy]);

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
      };
    } catch {
      return null;
    }
  }, [devBuy, built]);

  const fresh: CurveState = { injCollected: 0n, tokensSold: 0n, graduated: false };
  // A rule problem blocks the plan as firmly as a bad curve does. Both are permanent
  // once created, and the form is the only place either can still be changed.
  // The opening-buy cap blocks the plan, it does not merely colour a sentence red.
  // The previous version warned at 20% of supply and let the creator sign anyway,
  // which is the create-form-as-guarantee failure: the only thing stopping a creator
  // taking three quarters of their own curve was a paragraph.
  const ok =
    plan !== null && 'plan' in plan && ruleProblems.length === 0 && !devBuyPreview?.overCap;

  return (
    <>
      <div className="card">
        <h1>Create a launch</h1>
        <p className="note">
          You supply the tokens. Buyers bring {NETWORK.quoteSymbol}, and the curve prices every
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
            <p className="note">
              Every launch here has the same supply, so market caps on the board are
              comparable. You choose how it splits, not how much there is.
            </p>
          </div>
          <div className="field">
            <label htmlFor="cl-share">
              On the curve <span className="hint">% of supply</span>
            </label>
            <input id="cl-share" value={f.curveShare} onChange={(e) => set('curveShare')(e.target.value)} inputMode="decimal" />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="cl-target">
              Graduates at <span className="hint">{NETWORK.quoteSymbol} raised</span>
            </label>
            <input id="cl-target" value={f.target} onChange={(e) => set('target')(e.target.value)} inputMode="decimal" />
          </div>
          <div className="field">
            <label htmlFor="cl-vinj">
              Opening reserve <span className="hint">sets the starting price</span>
            </label>
            <input id="cl-vinj" value={f.virtualInj} onChange={(e) => set('virtualInj')(e.target.value)} inputMode="decimal" />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="cl-fee">
              Trading fee <span className="hint">bps, max 1000</span>
            </label>
            <input id="cl-fee" value={f.feeBps} onChange={(e) => set('feeBps')(e.target.value)} inputMode="numeric" />
          </div>
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
              {CREATOR_FEE_SHARE_BPS / 100}% of every trading fee is yours, claimable
              from your launch at any time. The other {PLATFORM_FEE_SHARE_BPS / 100}%
              runs this launchpad.
            </p>
          </div>
        </div>
      </div>

      {!('error' in built) && (
        <div className="card">
          <h2>The curve this makes</h2>
          <p className="note">
            Drawn from the same maths the contract charges, so this is the shape buyers will
            actually pay.
          </p>
          <CurveChart config={built.curve} state={fresh} height={150} />
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
                {fmt(maxCollectable(built.curve), 18, 2)} {NETWORK.quoteSymbol}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Launch rules</h2>
        <p className="note">
          Optional. Both are enforced by the curve contract on every buy and sell until
          this launch graduates. Afterwards the token trades on a DEX and neither applies.
        </p>

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
              Opening fee <span className="hint">%, blank for none</span>
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

        <div className="field">
          <label htmlFor="cl-devbuy">
            Your opening buy <span className="hint">{NETWORK.quoteSymbol}, blank for none</span>
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
            <p className={`note ${devBuyPreview.overCap ? 'err-text' : ''}`}>
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
            </p>
          )}
        </div>

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
            page rather than letting a creator look for one. On Solana a token can carry
            a transfer hook; an Injective tokenfactory denom is a bank denom and a bank
            send runs no contract code, so nothing can run on a transfer.
          */}
        <p className="note">
          Rules cannot be attached to transfers on Injective: a tokenfactory denom is a
          bank denom, and a bank send runs no contract code. What the curve can enforce
          is every trade it settles, which is every trade until graduation.
        </p>
      </div>

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
            No launchpad contracts are deployed on {NETWORK.name} yet, so nothing here
            can be submitted. The curve above is real arithmetic and the messages below
            are the ones that will be sent once there is a factory to send them to.
          </p>
        )}

        {!account && (
          <>
            <p className="note">Connect a wallet to see exactly what would be signed.</p>
            <ConnectWallet onAccount={setAccount} />
          </>
        )}

        {account && plan && 'error' in plan && (
          <p className="note danger-text">{plan.error}</p>
        )}

        {account && ok && 'plan' in plan && (
          <>
            <ul className="plan">
              {!('error' in built) &&
                describePlan(plan.plan, built.curve, built.lpReserve, devBuy).map((l) => (
                  <li key={l}>{l}</li>
                ))}
            </ul>

            <details className="raw">
              <summary>The four messages, exactly as they will be sent</summary>
              <pre>{JSON.stringify(plan.plan.messages, null, 2)}</pre>
            </details>

            <label className="toggle" style={{ marginTop: 'var(--space-4)' }}>
              <input
                id="cl-confirm"
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                I understand the supply is fixed, all of it leaves my wallet, and none of this can
                be changed afterwards.
              </span>
            </label>

            <button
              className="go"
              disabled={!confirmed || busy}
              onClick={() => void sign()}
            >
              {busy ? 'Waiting for your wallet…' : `Create ${f.symbol.trim() || 'launch'}`}
            </button>

            {result && (
              <p className="note">
                Launch created.{' '}
                <a
                  href={`${NETWORK.explorer}/transaction/${result}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View the transaction
                </a>
                .
              </p>
            )}
            {signError && <p className="note err-text">{signError}</p>}

            {/*
                THE HONEST LABEL, and it is not a disclaimer to delete once this looks
                like it works. The messages are built by a tested function and shown
                above exactly as they will be sent, but the ENCODING has never run
                against a node, and I cannot run it: that needs a wallet extension.
                What makes it safe to offer anyway is that all four messages are one
                transaction, so a mis-built launch is a rejected transaction rather
                than a denom created with no curve behind it, and the factory refuses
                any attached amount but the exact supply.
              */}
            <p className="note">
              This signing path has not yet been run against a chain. All four messages
              go in a single transaction, so if anything is wrong the chain refuses the
              whole thing and nothing is created. Try it on testnet first.
            </p>
          </>
        )}
      </div>
    </>
  );
}
