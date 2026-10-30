import { fmt } from '@/lib/curve';
import { denomLabel } from '@/lib/chain';
import { isEvm } from '@/lib/config';
import {
  FIXED_TOTAL_SUPPLY_TOKENS,
  CURVE_SUPPLY_TOKENS,
  LP_RESERVE_TOKENS,
  CREATOR_FEE_SHARE_BPS,
  PLATFORM_FEE_SHARE_BPS,
  REWARD_ROUTES,
  type RewardRoute,
} from '@/lib/launchLimits';
import type { LaunchRules } from '@/lib/launchRules';
import type { TokenProfile } from '@/lib/tokenProfile';

/**
 * Everything the launch will be, on one screen, before it can be signed.
 *
 * WHY IT EXISTS. A launch is immutable: the ticker, the fees, the rules and the
 * reward route are all fixed the moment the transaction lands, and until now a
 * creator checked them by scrolling back up a long form and reading the fields they
 * had typed. Reading your own inputs is the worst way to catch a mistake in them.
 *
 * It restates the DERIVED figures too, not only the typed ones. A creator who typed
 * "1" in a fee box has not seen what a buyer pays, and a creator who left the rules
 * blank has not been told the launch is open to everyone from the first block. The
 * mistakes worth catching are mostly in what was left alone.
 */
export function LaunchPreview({
  symbol,
  name,
  description,
  image,
  quoteLabel,
  quoteDecimals,
  buyFeePct,
  sellFeePct,
  rewardRoute,
  rules,
  openingBuy,
  openingBuyShare,
  profile,
}: {
  symbol: string;
  name: string;
  description: string;
  image: string;
  quoteLabel: string;
  /**
   * Decimals of that quote, which scale the opening buy.
   *
   * REQUIRED, and it did not exist: the opening buy was scaled by a literal 18 with
   * `quoteLabel` printed next to it. On the 6-decimal E2EUSD pair every opening buy
   * rendered as `0 E2EUSD` - measured at 0.5, 5, 100 and 1915 - beside a share of
   * supply that was computed correctly, so the one row on this card that is a number
   * the creator typed read zero while the row said they were taking 12% of the supply.
   * Required rather than defaulted for the reason `CurveChart` records: a default of 18
   * is the right answer for the default pair and silently wrong for every other, which
   * is what makes it the trap rather than the convenience.
   */
  quoteDecimals: number;
  buyFeePct: number;
  sellFeePct: number;
  rewardRoute: RewardRoute;
  rules: LaunchRules;
  openingBuy: bigint;
  openingBuyShare: number | null;
  profile: TokenProfile;
}) {
  const route = REWARD_ROUTES.find((r) => r.value === rewardRoute);
  const links = [
    ['Website', profile.website],
    ['X', profile.x],
    ['Telegram', profile.telegram],
  ].filter(([, v]) => Boolean(v)) as Array<[string, string]>;

  return (
    <div className="card preview-card">
      <h2>Before you sign</h2>
      <p className="note">
        Every line here is fixed once the transaction lands. Nothing below can be
        edited afterwards, by you or by us.
      </p>

      <div className="preview-head">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="preview-logo" src={image.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/')} alt="" />
        ) : (
          <div className="preview-logo preview-logo-empty" aria-hidden="true" />
        )}
        <div>
          <strong>{name.trim() || symbol.trim() || 'Untitled'}</strong>
          <span className="note mono">{symbol.trim() ? `$${symbol.trim()}` : 'no ticker yet'}</span>
        </div>
      </div>

      {description.trim() && <p className="note">{description.trim()}</p>}

      <div className="metric-row">
        <span className="k">Priced in</span>
        <span className="v mono">{quoteLabel}</span>
      </div>
      <div className="metric-row">
        <span className="k">Total supply</span>
        <span className="v mono">{FIXED_TOTAL_SUPPLY_TOKENS.toLocaleString('en-US')}</span>
      </div>
      <div className="metric-row">
        <span className="k">On the curve / held for the pool</span>
        <span className="v mono">
          {CURVE_SUPPLY_TOKENS.toLocaleString('en-US')} /{' '}
          {LP_RESERVE_TOKENS.toLocaleString('en-US')}
        </span>
      </div>
      <div className="metric-row">
        <span className="k">Buy fee / sell fee</span>
        <span className="v mono">
          {buyFeePct}% / {sellFeePct}%
        </span>
      </div>
      <div className="metric-row">
        {/*
            The SPLIT restated, because a creator who typed a fee has not necessarily
            worked out what reaches them, and "70% of 1%" is the number they will
            later check their claim against.
          */}
        <span className="k">Your share of each fee</span>
        <span className="v mono">
          {CREATOR_FEE_SHARE_BPS / 100}% ({PLATFORM_FEE_SHARE_BPS / 100}% runs the launchpad)
        </span>
      </div>
      <div className="metric-row">
        <span className="k">Your share goes</span>
        <span className="v">{route?.label ?? rewardRoute}</span>
      </div>

      <div className="metric-row">
        {/*
            Stated even when absent, and that is the point. A creator who left the
            rules blank has not been told the launch is open to everyone from the
            first block; an empty field says nothing, this says what it means.
          */}
        <span className="k">Max per wallet</span>
        <span className="v mono">
          {/* 18 is right here and must not be "fixed" to the quote: a cap is a count of
              TOKENS, and every token on this launchpad is 18 decimals. The opening buy
              below is the one in the quote asset. */}
          {rules.maxPerWallet ? fmt(BigInt(rules.maxPerWallet), 18, 0) : 'no cap'}
        </span>
      </div>
      <div className="metric-row">
        <span className="k">Buying opens</span>
        <span className="v mono">
          {rules.tradeStart
            ? new Date(rules.tradeStart * 1000).toLocaleString()
            : 'immediately'}
        </span>
      </div>
      <div className="metric-row">
        <span className="k">Opening fee</span>
        <span className="v mono">
          {rules.earlyFee
            ? `${rules.earlyFee.startBps / 100}% falling over ${Math.round(rules.earlyFee.seconds / 60)} min`
            : 'none'}
        </span>
      </div>
      {/*
          TWO ROWS THAT DO NOT EXIST ON THE EVM BACKEND, so they are absent rather than
          reading "none". The factory's `createLaunch` carries no amount to spend and no
          profile, and the form does not offer either there - so a row saying "none"
          would describe a choice the creator was never given, on the one panel whose
          job is to be exactly what is about to be signed. "None" for a field that
          cannot be set is the same false reassurance as a greyed-out control.
        */}
      {!isEvm() && (
        <>
          <div className="metric-row">
            <span className="k">Your opening buy</span>
            <span className="v mono">
              {openingBuy > 0n
                ? `${fmt(openingBuy, quoteDecimals, 4)} ${quoteLabel}${
                    openingBuyShare !== null
                      ? ` · ${(openingBuyShare * 100).toFixed(1)}% of supply`
                      : ''
                  }`
                : 'none'}
            </span>
          </div>

          <div className="metric-row">
            <span className="k">Links</span>
            <span className="v">
              {links.length === 0 ? 'none' : links.map(([k]) => k).join(', ')}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
