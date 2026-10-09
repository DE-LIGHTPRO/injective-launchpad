'use client';

import { useMemo, useState } from 'react';
import { ConnectWallet } from './ConnectWallet';
import { CurveChart } from './CurveChart';
import {
  planLaunch,
  describePlan,
  LaunchInputError,
  type LaunchPlan,
} from '@/lib/createLaunch';
import { parseAmount, fmt, maxCollectable, type CurveConfig, type CurveState } from '@/lib/curve';
import { NETWORK, getFactoryAddress } from '@/lib/config';
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
  totalSupply: '1000000000',
  curveShare: '80',
  target: '85',
  virtualInj: '30',
  feeBps: '100',
  creatorFeeShareBps: '2000',
};

export function CreateLaunch() {
  const [f, setF] = useState(DEFAULTS);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [confirmed, setConfirmed] = useState(false);
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
      const total = parseAmount(f.totalSupply || '0');
      const sharePct = Number(f.curveShare);
      if (!Number.isFinite(sharePct) || sharePct <= 0 || sharePct >= 100) {
        return { error: 'The share on the curve is a percentage above 0 and below 100.' };
      }
      if (total <= 0n) return { error: 'Total supply must be above zero.' };

      // Integer arithmetic throughout: a percentage of 1e27 through a float
      // loses the low digits of the supply.
      const curveSupply = (total * BigInt(Math.round(sharePct * 100))) / 10_000n;
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
          profile: profileForChain({
            image: f.image,
            website: f.website,
            x: f.x,
            telegram: f.telegram,
          }),
          curve: built.curve,
          lpReserve: built.lpReserve,
          creatorFeeShareBps: Math.round(Number(f.creatorFeeShareBps) || 0),
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

  const fresh: CurveState = { injCollected: 0n, tokensSold: 0n, graduated: false };
  // A rule problem blocks the plan as firmly as a bad curve does. Both are permanent
  // once created, and the form is the only place either can still be changed.
  const ok = plan !== null && 'plan' in plan && ruleProblems.length === 0;

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
            <label htmlFor="cl-supply">Total supply</label>
            <input id="cl-supply" value={f.totalSupply} onChange={(e) => set('totalSupply')(e.target.value)} inputMode="decimal" />
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
            <label htmlFor="cl-cshare">
              Your share of the fee <span className="hint">bps of the fee itself</span>
            </label>
            <input id="cl-cshare" value={f.creatorFeeShareBps} onChange={(e) => set('creatorFeeShareBps')(e.target.value)} inputMode="numeric" />
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
                describePlan(plan.plan, built.curve, built.lpReserve).map((l) => (
                  <li key={l}>{l}</li>
                ))}
            </ul>

            <details className="raw">
              <summary>The four messages, exactly as they would be sent</summary>
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

            {/*
                The button states the blocker instead of offering an action that
                cannot complete. A quote can be real and still not executable, and
                the honest move is to say which.
              */}
            <button className="go" disabled>
              Broadcasting is not wired up yet
            </button>
            <p className="note">
              The messages above are built and tested against the contract&rsquo;s own
              expectations, but they have never been signed against a chain. Signing needs
              Injective&rsquo;s protobuf types and a wallet to exercise them, and shipping a
              transaction builder nobody has run is how a launch ends up sending the wrong
              thing. Use them with <code>injectived tx</code> in the meantime.
            </p>
          </>
        )}
      </div>
    </>
  );
}
