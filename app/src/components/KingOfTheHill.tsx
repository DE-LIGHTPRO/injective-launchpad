import Link from 'next/link';
import { TokenLogo } from './TokenLogo';
import { CurveGlyph } from './CurveGlyph';
import { symbolOf } from '@/lib/chain';
import { compact, ageLabel } from '@/lib/boardMetrics';
import { NETWORK } from '@/lib/config';
import { denomLabel } from '@/lib/chain';
import type { LaunchRow } from '@/lib/launchList';

/**
 * The three largest launches, with the leader called out.
 *
 * Taken from nearly.trade, which runs a "King of the Hill" strip above its board and
 * is right to: a launchpad board is a long list of strangers' tokens, and without a
 * focal point a visitor has no idea which of them anyone is actually trading. It is
 * also the one competitive mechanic a bonding curve gives you for free, because
 * position on the curve is public and objective.
 *
 * BY MARKET CAP, as theirs is. The argument for it used to be that the alternative,
 * "closest to graduating", was gameable: a creator picked their own graduation target,
 * so a deliberately tiny one would outrank a launch that had raised ten times more.
 *
 * That is no longer true. The curve is policy and every launch graduates at the same
 * target, so progress is now a fair ranking too. Market cap stays because it is the
 * more useful of the two, not because the other one can be faked. Noting the change
 * rather than leaving the old reasoning in place: a justification that has quietly
 * stopped applying is how the next person inherits a constraint nobody has.
 *
 * NO EXTRA QUERIES. Every figure comes from rows the board has already loaded, so this
 * strip cannot disagree with the cards below it and costs nothing to render. That is
 * the same rule the totals bar follows and for the same reason.
 *
 * ONE QUOTE ONLY. It ranks by market cap, and a market cap is denominated in the
 * launch's quote asset, so ranking an INJ launch against a USDC one compares base
 * units of different things: without a price oracle, and there is none here, that
 * comparison has no meaning. The caller passes rows already filtered to one quote,
 * which the board does by default.
 *
 * It renders nothing below three launches. With one or two, "top 3" is the whole board
 * with a crown on it, which tells a visitor nothing and makes an empty launchpad look
 * like it is pretending.
 */
export function KingOfTheHill({ rows, nowSeconds }: { rows: LaunchRow[]; nowSeconds: number }) {
  const top = [...rows]
    .filter((r) => !r.graduated)
    .sort((a, b) => (BigInt(b.marketCap) > BigInt(a.marketCap) ? 1 : -1))
    .slice(0, 3);

  if (top.length < 3) return null;

  const [king, ...rest] = top;

  return (
    <section className="hill" aria-labelledby="hill-heading">
      <div className="hill-head">
        <h2 id="hill-heading">King of the hill</h2>
        <p className="note">
          The three largest launches still on their curve, by market cap. Updated every
          time this page reads the chain.
        </p>
      </div>

      <div className="hill-grid">
        <Link href={`/launch/${king.id}`} className="hill-king">
          <div className="hill-crown">Holds the hill</div>
          <div className="hill-id">
            <TokenLogo profile={king.profile} symbol={symbolOf(king.denom)} size={44} />
            <div>
              <strong>{symbolOf(king.denom)}</strong>
              {/*
                * Age rather than a creator handle. On a board where anyone can launch,
                * how long something has survived is the more useful of the two, and
                * `ageLabel` returns null rather than "just now" for a launch whose
                * opening block is unknown.
                */}
              <span className="note">{ageLabel(king.openedAt, nowSeconds) ?? 'on the curve'}</span>
            </div>
          </div>
          <div className="hill-cap">
            <span className="v mono">
              {compact(BigInt(king.marketCap), king.quoteDecimals)} {denomLabel(king.quoteDenom)}
            </span>
            <span className="k">market cap</span>
          </div>
          <CurveGlyph
            config={{
              virtualInj: BigInt(king.curve.virtualInj),
              virtualTokens: BigInt(king.curve.virtualTokens),
              curveSupply: BigInt(king.curve.curveSupply),
              graduationTarget: BigInt(king.curve.graduationTarget),
              feeBps: BigInt(king.curve.feeBps),
            }}
            state={{
              injCollected: BigInt(king.raised),
              tokensSold: BigInt(king.tokensSold),
              graduated: king.graduated,
            }}
            height={40}
          />
        </Link>

        <div className="hill-rest">
          {rest.map((r, i) => (
            <Link key={r.id} href={`/launch/${r.id}`} className="hill-row">
              <span className="hill-rank mono">{i + 2}</span>
              <TokenLogo profile={r.profile} symbol={symbolOf(r.denom)} size={28} />
              <strong>{symbolOf(r.denom)}</strong>
              <span className="v mono">
                {compact(BigInt(r.marketCap), r.quoteDecimals)} {denomLabel(r.quoteDenom)}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
