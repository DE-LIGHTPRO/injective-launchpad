import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getLaunch, listLaunches, getLaunchDetail, resolveQuote, symbolOf, short, ChainError, contractFacts } from '@/lib/chain';
import { resolveLaunchSlug, launchPath, pathForSlug, parseLaunchRef } from '@/lib/launchPath';
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
import { graduationProgress, fmt, spotPriceWad, maxCollectable, tokenDistribution } from '@/lib/curve';
import { NETWORK, isDeployed, isDevBuild, getPinnedCurveCodeIdsRaw } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { PriceChart } from '@/components/PriceChart';
import { DemoBanner } from '@/components/DemoBanner';
import { TradePanel } from '@/components/TradePanel';
import { Trades } from '@/components/Trades';
import { hasEverTraded, loadTradeView } from '@/lib/tradeView';
import { EMPTY_SERIES } from '@/lib/priceSeries';

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
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  try {
    const launch = await launchForSlug(slug);
    if (!launch) return { title: 'Launch' };
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
      /*
       * Which of the forms a crawler should index. The redirect is deliberately
       * temporary (see the page body), so this is what keeps `/launch/7` and
       * `/launch/INJINU` from competing with each other in search.
       */
      alternates: { canonical: launchPath(launch, await listLaunches().catch(() => [launch])) },
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

/**
 * The launch a path segment names, or null.
 *
 * USED BY THE METADATA TOO, which is why it is a function rather than inline: a share
 * card built from a different launch than the page renders is the quietest way to
 * mislead somebody, and two separate resolutions is exactly how that happens.
 *
 * The numeric fast path exists because an id needs no board read, and `/launch/<id>`
 * is what every link shared before this change looks like.
 */
async function launchForSlug(slug: string) {
  const ref = parseLaunchRef(slug);
  if (!ref) return null;
  if (ref.kind === 'id') {
    try {
      return await getLaunch(ref.id);
    } catch {
      return null;
    }
  }
  return resolveLaunchSlug(slug, await listLaunches()).launch;
}


export default async function LaunchPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (!isDeployed() && !isDemoMode()) {
    return (
      <div className="empty">
        <p>No factory is configured, so this launch cannot be loaded.</p>
        <Link href="/" className="note">
          ← back to launches
        </Link>
      </div>
    );
  }

  /*
   * Resolved against the board, because whether a ticker is ambiguous is a property
   * of the board rather than of the launch. One read, reused for the redirect
   * decision and for the clash list.
   */
  const board = await listLaunches().catch(() => []);
  const { launch: resolved, candidates, canonical } = resolveLaunchSlug(slug, board);

  /*
   * One launch, one URL. `/launch/7` and `/launch/injinu` both land on
   * `/launch/INJINU`: serving the same page at three addresses splits its search
   * ranking and makes a shared link look unlike the one in the address bar. A
   * permanent redirect is right because the canonical form does not change back.
   */
  /*
   * TEMPORARY (307), not permanent, and that is deliberate. Which slug is canonical
   * depends on the board: `/launch/INJINU` is canonical until a second creator uses
   * the ticker, at which point `/launch/INJINU-1` becomes canonical instead. A 308 is
   * cached by browsers for ever, so it would promise something this page cannot keep.
   * `rel="canonical"` in the metadata is what tells a crawler which form to index.
   */
  if (resolved && canonical) redirect(pathForSlug(canonical));

  /*
   * A ticker two creators both used. The page lists them instead of choosing: sending
   * someone to a different token than the one they were linked to is the worst thing
   * a launchpad can do with a URL, and it would look like it worked.
   */
  if (!resolved && candidates.length > 1) {
    return (
      <div className="empty">
        <h1>{symbolOf(candidates[0].denom)}</h1>
        <p>
          More than one launch uses this ticker. A ticker is not unique on Injective,
          so pick the one you meant.
        </p>
        <ul className="plain-list" style={{ marginTop: 'var(--space-4)' }}>
          {candidates.map((c) => (
            <li key={c.id}>
              <Link href={launchPath(c, board)}>
                {symbolOf(c.denom)} by {short(c.creator)}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (!resolved) notFound();

  let launch, detail, facts;
  try {
    launch = resolved;
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

  /*
   * The trade history, read ONCE for the whole page. The price chart and the trade
   * list are the same data asked two ways; fetching it in each would be two tx
   * searches for one curve on one render.
   */
  /*
   * Resolved here, once, from the state read above, and handed to both surfaces. The
   * tx search cannot answer "has this ever traded" when the node that holds those
   * blocks has pruned them; the curve can, and it costs no request.
   */
  const tradedOnChain = hasEverTraded(detail);
  const tradeView = await loadTradeView({
    curve: launch.curve,
    denom: launch.denom,
    quote,
    totalSupply: totalSupply.toString(),
    tradedOnChain,
  });

  const ruleCopy = describeRules(
    detail.rules,
    (v) => fmt(v, 18, 0),
    (secs) => `${new Date(secs * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  );
  const progress = graduationProgress(detail.config, detail.state);
  // Wad precision: on a 6-decimal quote a whole-unit price floors to 0.
  const price = spotPriceWad(detail.config, detail.state, detail.pool, ONE);
  const reserveNow = detail.pool ? detail.pool.quote : detail.state.injCollected;
  const ceiling = maxCollectable(detail.config);
  const supply = tokenDistribution(detail.config, detail.state, detail.lpReserve, detail.pool);

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

      {/*
          WHAT THE CREATOR SAID THIS IS. The form has always collected a description
          and it went into `MsgSetDenomMetadata` and nowhere else; Injective answers a
          per-denom `denoms_metadata` read with 501, which is why every other identity
          field is stored on the factory. So the only piece of writing on the whole
          form was collected, validated, signed, and then shown to nobody.

          RENDERED AS TEXT, never as markup. It is attacker-controlled input like
          every other profile field; what keeps it safe is that it is text content,
          and `white-space: pre-line` is what lets the creator's own line breaks
          survive without any markup being interpreted.
        */}
      {launch.profile.description && (
        <p className="token-about">{launch.profile.description}</p>
      )}
      <div className="share-row" style={{ margin: 'var(--space-4) 0' }}>
        <WatchButton id={launch.id} symbol={symbol} />
        <ShareRow symbol={symbol} path={launchPath(launch, board)} />
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
            <Price raw={price} decimals={quote.decimals + 18} unit={quote.label} />
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
            {/*
                ONE FETCH FOR BOTH. `tradeView` is read once above and feeds the chart
                here and the trade list below; each fetching its own would be two tx
                searches for the same curve on the same render.
              */}
            <PriceChart
              series={tradeView.kind === 'view' ? tradeView.view.series : EMPTY_SERIES}
              change={tradeView.kind === 'view' ? tradeView.view.change : null}
              config={detail.config}
              state={detail.state}
              quoteLabel={quote.label}
              quoteDecimals={quote.decimals}
              sym={symbol}
              tradedOnChain={tradedOnChain}
              /* Whole tokens, which turns a fill price into a market cap. */
              totalSupplyTokens={Number(totalSupply / 10n ** 18n)}
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
                <Price raw={price} decimals={quote.decimals + 18} unit={`${quote.label} / ${symbol}`} />
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
            {/*
                THREE ROWS ABOUT THE CURVE, AND MIGRATION INVALIDATED ALL THREE. The
                reason, the measurement and the reason the split cannot be reconstructed
                are all on `tokenDistribution` in `curve.ts`, which is where this now
                comes from so that it can be tested by behaviour rather than by reading
                this file. In short: after `seed_pool`, `tokensSold` is a constant and
                `lpReserve` is what WAS held back, and the page printed both in the
                present tense on a launch badged "Liquidity locked".
              */}
            {supply.kind === 'pool' ? (
              <>
                <div className="metric-row">
                  <span className="k">In the locked pool</span>
                  <span className="v mono">{fmt(supply.inPool, 18, 0)} {symbol}</span>
                </div>
                <div className="metric-row">
                  <span className="k">Held outside the pool</span>
                  <span className="v mono">{fmt(supply.outside, 18, 0)} {symbol}</span>
                </div>
              </>
            ) : (
              <>
                <div className="metric-row">
                  <span className="k">Sold</span>
                  <span className="v mono">
                    {fmt(supply.sold, 18, 0)} / {fmt(supply.curveSupply, 18, 0)}
                  </span>
                </div>
                <div className="metric-row">
                  <span className="k">Still on the curve</span>
                  <span className="v mono">{fmt(supply.onCurve, 18, 0)} {symbol}</span>
                </div>
                <div className="metric-row">
                  <span className="k">Held back for liquidity</span>
                  <span className="v mono">{fmt(supply.heldBack, 18, 0)} {symbol}</span>
                </div>
              </>
            )}
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
            <Trades result={tradeView} quote={quote} />
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
