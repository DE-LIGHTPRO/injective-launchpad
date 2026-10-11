import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLaunch, getLaunchDetail, resolveQuote, symbolOf, short, ChainError, contractFacts } from '@/lib/chain';
import { assessCurveCode, blocksTrading, pinnedCodeIds } from '@/lib/codeCheck';
import { CodeCheck } from '@/components/CodeCheck';
import { TrustBadges } from '@/components/TrustBadges';
import { ShareRow } from '@/components/ShareRow';
import { WatchButton } from '@/components/WatchButton';
import { Price } from '@/components/Price';
import { BRAND_NAME } from '@/lib/brand';
import { ArrowLeftIcon } from '@/components/Icons';
import { TokenLogo } from '@/components/TokenLogo';
import { visibleLinks } from '@/lib/tokenProfile';
import { describeRules, hasAnyRule } from '@/lib/launchRules';
import { marketCap, compact, feeLabel, ageLabel } from '@/lib/boardMetrics';
import { addressName } from '@/lib/addressName';
import { StatusChip } from '@/components/StatusChip';
import { CreatorPosition } from '@/components/CreatorPosition';
import { FeeEarnings } from '@/components/FeeEarnings';
import { CopyButton } from '@/components/CopyButton';
import { graduationProgress, fmt, launchSpotPrice, maxCollectable } from '@/lib/curve';
import { NETWORK, isDeployed, isDevBuild, getPinnedCurveCodeIdsRaw } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { CurveChart } from '@/components/CurveChart';
import { DemoBanner } from '@/components/DemoBanner';
import { TradePanel } from '@/components/TradePanel';
import { Trades } from '@/components/Trades';

export const dynamic = 'force-dynamic';

/**
 * What a shared launch link looks like.
 *
 * A launchpad spreads by links: a creator posts their token, and whatever the preview
 * shows is the whole pitch. With no metadata every one of them rendered as the site's
 * generic title with no description, so four different tokens shared identically and
 * none of them said what it was.
 *
 * Built from the launch's own figures rather than a template, and it reports PROGRESS
 * rather than a price, because progress is the one number that means the same thing
 * whenever the link is opened. A price in a preview is cached by the platform that
 * scraped it and goes stale within minutes, which is worse than saying nothing.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return { title: 'Launch' };

  try {
    const launch = await getLaunch(numericId);
    const detail = await getLaunchDetail(launch.curve);
    const sym = symbolOf(detail.denom);
    const pct = (graduationProgress(detail.config, detail.state) * 100).toFixed(1);
    /*
     * The share card carries the same figures as the page, so it needs the same
     * quote. This is the copy with the widest reach: it is what a link preview shows
     * in a chat, where nobody can click through to check the units.
     */
    const q = await resolveQuote(detail.quoteDenom);
    const raised = fmt(detail.pool ? detail.pool.quote : detail.state.injCollected, q.decimals, 2);
    const target = fmt(detail.config.graduationTarget, q.decimals, 0);

    const state = detail.state.graduated
      ? `Graduated: trading against a locked pool of ${raised} ${q.label}`
      : `${pct}% to graduation, ${raised} of ${target} ${q.label} raised`;
    const description = `${state}. One-sided bonding curve on Injective: the creator supplies tokens, buyers bring ${q.label}.`;

    /*
     * The creator's image is NOT used as the preview card.
     *
     * It is a URL a stranger controls, and a social platform fetching it on our behalf
     * turns every shared link into a request we cannot see and did not make. The
     * scheme allowlist protects this page from a hostile value; it does not make the
     * destination ours to vouch for.
     */
    return {
      // Absolute: the layout template would otherwise append the name a second time.
      title: { absolute: `${sym} on ${BRAND_NAME}` },
      description,
      openGraph: { title: `${sym} on ${BRAND_NAME}`, description, type: 'website' },
      twitter: { card: 'summary', title: `${sym} on ${BRAND_NAME}`, description },
    };
  } catch {
    // A launch that cannot be read still needs a title, and it must not be the
    // error: a preview saying "no such launch" is worse than a plain one.
    return { title: 'Launch' };
  }
}

const ONE = 1_000_000_000_000_000_000n;

export default async function LaunchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numericId = Number(id);

  if ((!isDeployed() && !isDemoMode()) || !Number.isFinite(numericId)) {
    return (
      <div className="empty">
        <p>No factory is configured, so this launch cannot be loaded.</p>
        <Link href="/" className="note">
          ← back to launches
        </Link>
      </div>
    );
  }

  let launch, detail, facts;
  try {
    launch = await getLaunch(numericId);
    [detail, facts] = await Promise.all([
      getLaunchDetail(launch.curve),
      contractFacts(launch.curve, launch.denom),
    ]);
  } catch (e) {
    /*
     * A launch that does not exist is a 404, not a rendered error at 200.
     * `notFound()` is what sets the status; returning markup, however correct the
     * words, leaves the response saying the page is fine.
     */
    if (e instanceof ChainError && e.notFound) notFound();
    return (
      <div className="empty">
        <p className="danger-text">{(e as Error).message}</p>
        {isDevBuild() && (e as Error & { detail?: string }).detail && (
          <code>{(e as Error & { detail?: string }).detail}</code>
        )}
        <p style={{ marginTop: 'var(--space-4)' }}>
          <Link href="/" className="note">
            ← back to launches
          </Link>
        </p>
      </div>
    );
  }

  const codeStatus = assessCurveCode(
    facts ?? null,
    pinnedCodeIds(getPinnedCurveCodeIdsRaw()),
    launch.curve,
  );
  const symbol = symbolOf(detail.denom);
  // Only the links that survive the scheme allowlist, so nothing hostile reaches an
  // href even if the chain the UI is pointed at never checked them.
  const links = visibleLinks(launch.profile);
  /*
   * Formatted on the server, so the figures are the same ones the page renders rather
   * than being recomputed per client. The time is rendered in UTC here for the same
   * reason: a server-rendered local time is the SERVER's local time, which is not the
   * reader's, and a launch that says it opens at a time nobody's clock agrees with is
   * worse than one that says UTC plainly.
   */

  /*
   * THIS launch's quote, resolved once and handed to every panel that renders money.
   *
   * The decimals come from the factory's allowlist, the same source the contract
   * scaled this launch's curve with. Every figure below, market cap, price, reserve,
   * fees, fills, trades, is denominated in it: they were all rendered with
   * `NETWORK.quoteSymbol` and scaled as 18 decimals, so a USDC-paired launch showed
   * numbers a trillion times too large under the wrong ticker.
   */
  const quote = await resolveQuote(detail.quoteDenom);
  const totalSupply = detail.config.curveSupply + detail.lpReserve;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const ruleCopy = describeRules(
    detail.rules,
    (v) => fmt(v, 18, 0),
    (secs) => `${new Date(secs * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  );
  const progress = graduationProgress(detail.config, detail.state);
  const price = launchSpotPrice(detail.config, detail.state, detail.pool, ONE);
  const reserveNow = detail.pool ? detail.pool.quote : detail.state.injCollected;
  const ceiling = maxCollectable(detail.config);
  const remaining = detail.config.curveSupply - detail.state.tokensSold;

  return (
    <>
      <DemoBanner />
      <p className="note" style={{ marginBottom: 'var(--space-4)' }}>
        <Link href="/" className="back-link">
          <ArrowLeftIcon size={14} /> All launches
        </Link>
      </p>

      <div className="token-head">
        <TokenLogo profile={launch.profile} symbol={symbol} size={48} />
        <div>
          <div className="token-title">
            <h1>{symbol}</h1>
            <StatusChip
              graduated={detail.state.graduated}
              migrated={detail.migrated}
              rules={detail.rules}
            />
          </div>
          <div className="denom-row mono">
            <span>{detail.denom}</span>
            <CopyButton value={detail.denom} label="Copy" />
          </div>
        </div>
      </div>
      <TrustBadges status={codeStatus} migrated={detail.migrated} demo={isDemoMode()} />
      <CodeCheck status={codeStatus} curve={launch.curve} />
      <div className="share-row" style={{ margin: 'var(--space-4) 0' }}>
        <WatchButton id={launch.id} symbol={symbol} />
        <ShareRow symbol={symbol} path={`/launch/${launch.id}`} />
      </div>

      {links.length > 0 && (
        <>
          <div className="token-links">
            {links.map((l) => (
              /*
               * `rel="noopener noreferrer nofollow ugc"` on every one of these, and each
               * token earns its place:
               *   noopener  - the opened page cannot reach back through window.opener
               *   noreferrer- it does not learn which launch page sent the visitor
               *   nofollow  - a launchpad is an open submission form, so outbound links
               *               are not endorsements and must not pass ranking
               *   ugc       - what these actually are: user-generated content
               * The href is already through `safeExternalUrl`; this covers what happens
               * after a safe link is followed.
               */
              <a
                key={l.kind}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
              >
                {l.label}
              </a>
            ))}
          </div>
          {/*
              Said plainly once, under the links. Anyone can create a launch here, so
              these are the creator's claims about themselves and nothing has checked
              them. A launchpad that renders them without saying so is lending its own
              credibility to a stranger's URL.
            */}
          <p className="note">Links are supplied by the creator and are not verified.</p>
        </>
      )}

      {/*
          The metric strip, which is how a token page is read at a glance.
          
          nearly.trade's row is Market cap, Price, Liquidity, 24h volume, Holders, ATH.
          Four of those are here. Two are not, and are ABSENT rather than estimated:
          holders needs an indexer this chain does not provide for factory denoms, and
          24h volume needs timestamped trade history at a depth the query limits do not
          reliably return. A column filled with a plausible guess is worse than a
          column that is not there, because nobody can tell which it was.
        */}
      <div className="metric-strip">
        <div>
          <span className="k">Market cap</span>
          <span className="v mono">
            {compact(marketCap(detail.config, detail.state, totalSupply, detail.pool), quote.decimals)} {quote.label}
          </span>
        </div>
        <div>
          <span className="k">Price</span>
          <span className="v mono">
            <Price raw={price} decimals={quote.decimals} unit={quote.label} />
          </span>
        </div>
        <div>
          {/*
              "Curve reserve", not "liquidity". Until graduation there is no pool: the
              reserve is what backs sells on the curve, and calling it liquidity would
              borrow the word from a thing that does not exist yet.
            */}
          <span className="k">{detail.pool ? 'Locked liquidity' : 'Curve reserve'}</span>
          <span className="v mono">
            {fmt(reserveNow, quote.decimals, 2)} {quote.label}
          </span>
        </div>
        <div>
          <span className="k">Trading fee</span>
          <span className="v mono">{feeLabel(detail.config.feeBps).replace(' fee', '')}</span>
        </div>
        <div>
          <span className="k">Age</span>
          {/*
              Words, not a dash. The guard has no placeholder exemption and adding one
              would be weakening a rule to fit a glyph, but the better argument is that
              a dash here is ambiguous: it could mean zero, unknown, or not applicable.
              This launch's creation time genuinely is not recorded, and saying so is
              shorter to read than a symbol someone has to interpret.
            */}
          <span className="v">{ageLabel(detail.rules.openedAt, nowSeconds) ?? 'not recorded'}</span>
        </div>
      </div>

      <div className="cols" style={{ marginTop: 'var(--space-5)' }}>
        <div>
          <div className="card">
            <h2>Price curve</h2>
            <CurveChart
              config={detail.config}
              state={detail.state}
              quoteLabel={quote.label}
              quoteDecimals={quote.decimals}
            />
            <div className="bar" style={{ marginTop: 'var(--space-2)' }}>
              <i style={{ width: `${Math.min(100, progress * 100).toFixed(1)}%` }} />
            </div>
            <div className="metric-row" style={{ marginTop: 'var(--space-3)' }}>
              <span className="k">Progress to graduation</span>
              <span className="v mono">{(progress * 100).toFixed(1)}%</span>
            </div>
          </div>

          <div className="card" style={{ marginTop: 'var(--space-4)' }}>
            <h2>Numbers</h2>
            <div className="metric-row">
              <span className="k">Spot price</span>
              <span className="v mono">
                <Price raw={price} decimals={quote.decimals} unit={`${quote.label} / ${symbol}`} />
              </span>
            </div>
            <div className="metric-row">
              <span className="k">{detail.pool ? 'Pool liquidity' : 'Raised'}</span>
              <span className="v mono">
                {fmt(reserveNow, quote.decimals, 3)} {quote.label}
              </span>
            </div>
            <div className="metric-row">
              <span className="k">Graduates at</span>
              <span className="v mono">
                {fmt(detail.config.graduationTarget, quote.decimals, 0)} {quote.label}
              </span>
            </div>
            <div className="metric-row">
              <span className="k">Curve ceiling</span>
              <span className="v mono">
                {fmt(ceiling, quote.decimals, 2)} {quote.label}
              </span>
            </div>
            <div className="metric-row">
              <span className="k">Sold</span>
              <span className="v mono">
                {fmt(detail.state.tokensSold, 18, 0)} / {fmt(detail.config.curveSupply, 18, 0)}
              </span>
            </div>
            <div className="metric-row">
              <span className="k">Still on the curve</span>
              <span className="v mono">{fmt(remaining, 18, 0)} {symbol}</span>
            </div>
            <div className="metric-row">
              <span className="k">Held back for liquidity</span>
              <span className="v mono">{fmt(detail.lpReserve, 18, 0)} {symbol}</span>
            </div>
            <div className="metric-row">
              <span className="k">Creator</span>
              <span className="v mono">
                <Link href={`/creator/${detail.creator}`} title="Everything this address has launched">
                  {short(detail.creator)}
                </Link>
              </span>
            </div>
            <div className="metric-row">
              <span className="k">Curve contract</span>
              <span className="v mono">
                <a
                  href={`${NETWORK.explorer}/contract/${launch.curve}`}
                  target="_blank"
                  rel="noopener"
                >
                  {short(launch.curve)}
                </a>
              </span>
            </div>
          </div>
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Trades
              quote={quote}
              curve={launch.curve}
              denom={launch.denom}
              totalSupply={(detail.config.curveSupply + detail.lpReserve).toString()}
            />
          </div>
        </div>

        <aside className="trade-col" aria-label="Trade">
          <TradePanel
            curve={launch.curve}
            quoteAsset={quote}
            config={detail.config}
            state={detail.state}
            symbol={symbol}
            denom={detail.denom}
            tradingClosed={detail.state.graduated}
            pool={detail.pool}
            rules={detail.rules}
            blocked={blocksTrading(codeStatus)}
          />
          {hasAnyRule(detail.rules) && (
            <div className="card" style={{ marginTop: 'var(--space-4)' }}>
              <h2>Launch rules</h2>
              <ul className="plan">
                {ruleCopy.lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              {/*
                  The scope sentence is not optional decoration. These rules stop at
                  graduation, and a buyer reading a cap without that is being told
                  something about the token rather than about this curve.
                */}
              <p className="note">{ruleCopy.scope}</p>
            </div>
          )}
        </aside>
      </div>

      <div className="stack-below">
        <CreatorPosition
          creator={detail.creator}
          denom={detail.denom}
          totalSupply={(detail.config.curveSupply + detail.lpReserve).toString()}
        />

        <FeeEarnings
          curve={launch.curve}
          creator={detail.creator}
          creatorOwed={detail.creatorOwed}
          platformOwed={detail.platformOwed}
          creatorPaid={detail.creatorPaid}
          platformPaid={detail.platformPaid}
          feeBps={detail.config.feeBps}
          quote={quote}
        />
      </div>
    </>
  );
}
