import { cache } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getLaunch, listLaunches, listQuotes, getLaunchDetail, quoteFromList, symbolOf, short, ChainError, contractFacts, type Launch } from '@/lib/chain';
import { resolveLaunchSlug, launchPath, pathForSlug, parseLaunchRef } from '@/lib/launchPath';
import { assessCurveCode, blocksTrading, pinnedCodeIds, pinnedCodeHashes } from '@/lib/codeCheck';
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
import {
  NETWORK,
  isDeployed,
  isDevBuild,
  getPinnedCurveCodeIdsRaw,
  getPinnedCurveCodeHashesRaw,
} from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { PriceChart } from '@/components/PriceChart';
import { DemoBanner } from '@/components/DemoBanner';
import { TradePanel } from '@/components/TradePanel';
import { Trades } from '@/components/Trades';
import { hasEverTraded, loadTradeView } from '@/lib/tradeView';
import { EMPTY_SERIES } from '@/lib/priceSeries';

export const dynamic = 'force-dynamic';

/* ---------------------------------------------------------------------------
   THE SHARE CARD AND THE PAGE READ THE SAME CHAIN STATE, ONCE.

   Next renders `generateMetadata` and the component for one request, and they
   each read what they need. Counted by logging every query against the live
   testnet, one warm request to `/launch/GHDSJS` sent NINE smart queries for
   FOUR distinct questions:

       launches {}   x3      config {}   x2
       quotes {}     x2      state {}    x2

   Volume is the smaller half of it. `launchForSlug` is a function and not
   inline because, as the comment on it says, "a share card built from a
   different launch than the page renders is the quietest way to mislead
   somebody, and two separate resolutions is exactly how that happens" - and
   the detail, the quote and the board were two separate resolutions anyway,
   taken a few hundred milliseconds and possibly a block apart. The card
   reports progress to one decimal place. Two reads either side of a fill
   disagree, and the version in the preview is the one that gets cached by
   whatever scraped it.

   `cache` from React memoises for the duration of ONE request, which is the
   unit that matters here: no state is held between visitors, and a second
   visitor still reads the chain afresh. This is also why these wrappers live
   in this server-only file rather than in `lib/chain.ts` - that module is
   imported by client components, where `cache` does not apply.
   --------------------------------------------------------------------------- */

/**
 * Every launch, once per request. Falls back to empty, as the page always has.
 *
 * The metadata's fallback used to be `[launch]` rather than `[]`, and the difference
 * is nothing: `launchSlug` looks for a launch with a LOWER id, so a list holding only
 * this launch and an empty list both find none and both yield the bare ticker.
 */
const allLaunches = cache(() => listLaunches().catch((): Launch[] => []));

/** One curve's config and state, once per request per curve. */
const detailOf = cache((curve: string) => getLaunchDetail(curve));

/** The factory's quote allowlist, once per request. */
const allowlist = cache(() => listQuotes());

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
    const detail = await detailOf(launch.curve);
    const sym = symbolOf(detail.denom);
    const pct = (graduationProgress(detail.config, detail.state) * 100).toFixed(1);
    /*
     * The share card carries the same figures as the page, so it needs the same
     * quote. This is the copy with the widest reach: it is what a link preview shows
     * in a chat, where nobody can click through to check the units.
     */
    const q = quoteFromList(detail.quoteDenom, (await allowlist()).quotes);
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
      alternates: { canonical: launchPath(launch, await allLaunches()) },
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
  return resolveLaunchSlug(slug, await allLaunches()).launch;
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
  const board = await allLaunches();
  const { launch: resolved, sameTicker, canonical } = resolveLaunchSlug(slug, board);

  /*
   * One launch, one URL. `/launch/7` and `/launch/injinu` both land on
   * `/launch/INJINU`: serving the same page at three addresses splits its search
   * ranking and makes a shared link look unlike the one in the address bar.
   */
  /*
   * TEMPORARY (307), not permanent. This used to say the reason was that a canonical
   * slug changes when someone copies the ticker, and since F-17 that is no longer
   * true: the first launch keeps the plain form for ever and a later one carries its
   * suffix from the moment it exists, so a launch's canonical slug is now fixed. The
   * redirect stays temporary anyway, because a 308 is cached by a browser
   * indefinitely and is unrecoverable if it is ever wrong, while the cost of 307 is
   * one extra hop on a legacy or hand-typed URL. `rel="canonical"` in the metadata is
   * what tells a crawler which form to index, and that is the half that matters.
   */
  if (resolved && canonical) redirect(pathForSlug(canonical));

  if (!resolved) notFound();

  let launch, detail, facts, quotes;
  try {
    launch = resolved;
    /*
     * The allowlist joins this group even though the pick below needs `detail` first.
     *
     * `quotes {}` takes no argument, so it depended on nothing and was a fourth serial
     * round trip purely because `resolveQuote` bundles the read with the pick. Measured
     * against the configured LCD at a median 169ms over five samples, on the page a
     * trader actually lands on, which was paying four phases in a row: the board, the
     * detail, the quote, then the trade history.
     */
    [detail, facts, { quotes }] = await Promise.all([
      detailOf(launch.curve),
      contractFacts(launch.curve, launch.denom),
      allowlist(),
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
    {
      ids: pinnedCodeIds(getPinnedCurveCodeIdsRaw()),
      hashes: pinnedCodeHashes(getPinnedCurveCodeHashesRaw()),
    },
    launch.curve,
  );
  const symbol = symbolOf(detail.denom);
  /*
   * Whether this is the launch that named the ticker. Read off `sameTicker` rather
   * than recomputed, so the sentence below and the slug in the address bar cannot
   * disagree about which launch came first.
   */
  const firstOfTicker = !sameTicker.some((o) => o.id < launch.id);
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
  const quote = quoteFromList(detail.quoteDenom, quotes);
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
      {/*
          A TICKER IS NOT UNIQUE AND THE PAGE HAS TO SAY SO. Audit F-17, and the half
          worth keeping from what it replaced: the old disambiguation page offered two
          identically-named entries and asked the reader to pick, which told them
          nothing they could act on and only appeared on the plain URL. This appears
          on whichever launch was resolved, including the copy, which is the reader
          who most needs it, and it says which one came first instead of asking.

          Placed above the code check because it is a question about identity: the
          contract can be exactly the published one and the token still not be the
          one somebody meant to buy.
        */}
      {sameTicker.length > 0 && (
        <div className="card" style={{ marginBottom: 'var(--space-4)' }}>
          <h2 className="warn-text">
            {firstOfTicker
              ? `Another token is also called ${symbol}`
              : `This is not the first token called ${symbol}`}
          </h2>
          <p className="note">
            {firstOfTicker
              ? `This is the earliest launch to use the ticker ${symbol}, and it keeps the plain link. `
              : `An earlier launch already used the ticker ${symbol}. `}
            Anyone can create a token with any ticker on Injective, so the name is not
            an identity. Check the denom above and the creator before you buy.
          </p>
          <ul className="plain-list" style={{ marginTop: 'var(--space-3)' }}>
            {sameTicker.map((c) => (
              <li key={c.id}>
                <Link href={launchPath(c, board)}>
                  {symbolOf(c.denom)} by {short(c.creator)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
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
            {/*
                PAST TENSE ONCE IT HAS HAPPENED. Audit F-06, and it is the same defect
                the token rows below already record: migration invalidated three rows
                about the curve, those were fixed, and the ones on the QUOTE side were
                left behind reading as though the launch were still climbing.

                "Progress to graduation 100.0%" is a bar toward an event that is over.
                The 100% is not even a measurement: `graduationProgress` returns 1 on
                `st.graduated` deliberately, because the contract ZEROES `injCollected`
                when it seeds the pool, so the figure it would otherwise derive from is
                gone. Measured on E2E88375: target 15,169, pool 6,724.38, recorded
                raise 0. That zero is the audit's "0 raised at 100%".
              */}
            <div className="metric-row" style={{ marginTop: 'var(--space-3)' }}>
              <span className="k">{detail.pool ? 'Status' : 'Progress to graduation'}</span>
              <span className="v mono">
                {detail.pool ? 'Graduated' : `${(progress * 100).toFixed(1)}%`}
              </span>
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
              <span className="k">{detail.pool ? 'Graduated at' : 'Graduates at'}</span>
              <span className="v mono">
                {fmt(detail.config.graduationTarget, quote.decimals, 0)} {quote.label}
              </span>
            </div>
            {/*
                THE TWO FIGURES ABOVE DO NOT ADD UP, AND THAT IS CORRECT. Audit F-06.
                A reader sees a launch marked graduated, a target of 15,169 and a pool
                holding 6,724, and the only available reading is that something went
                missing. Part of the raise seeds the pool and the rest is the fees that
                were paid out along the way, and the pool's balance then MOVES with
                trading - selling into it takes quote out. So this is not the amount
                raised and must not be read as one.

                WHAT THE AUDIT ASKED FOR AND THE CHAIN CANNOT GIVE: "raised at
                graduation". The contract zeroes `injCollected` when it seeds the pool,
                so that number is not retained anywhere on chain and cannot be
                recovered from the split either. Saying what the pool figure IS, in a
                line a reader can act on, is the honest version. Deriving a
                plausible-looking raise from the target and the pool would be a number
                nobody measured, in the one place this product claims not to do that.
              */}
            {detail.pool && (
              <p className="note" style={{ marginTop: 'var(--space-2)' }}>
                The pool figure is what is in the locked pool now, not the amount
                raised. Part of the raise seeded it and the rest was paid out as fees,
                and the balance moves as people trade against it.
              </p>
            )}
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
          rewardRoute={detail.rewardRoute}
          quote={quote}
        />
      </div>
    </>
  );
}
