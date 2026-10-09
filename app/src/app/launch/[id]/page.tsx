import Link from 'next/link';
import { getLaunch, getLaunchDetail, symbolOf, short } from '@/lib/chain';
import { TokenLogo } from '@/components/TokenLogo';
import { visibleLinks } from '@/lib/tokenProfile';
import { describeRules, hasAnyRule } from '@/lib/launchRules';
import { StatusChip } from '@/components/StatusChip';
import { graduationProgress, fmt, spotPrice, maxCollectable } from '@/lib/curve';
import { NETWORK, isDeployed, isDevBuild } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { CurveChart } from '@/components/CurveChart';
import { DemoBanner } from '@/components/DemoBanner';
import { TradePanel } from '@/components/TradePanel';
import { Trades } from '@/components/Trades';

export const dynamic = 'force-dynamic';

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

  let launch, detail;
  try {
    launch = await getLaunch(numericId);
    detail = await getLaunchDetail(launch.curve);
  } catch (e) {
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
  const ruleCopy = describeRules(
    detail.rules,
    (v) => fmt(v, 18, 0),
    (secs) => `${new Date(secs * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
  );
  const progress = graduationProgress(detail.config, detail.state);
  const price = spotPrice(detail.config, detail.state, ONE);
  const ceiling = maxCollectable(detail.config);
  const remaining = detail.config.curveSupply - detail.state.tokensSold;

  return (
    <>
      <DemoBanner />
      <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
        <Link href="/">← launches</Link>
      </p>

      <div className="metric-row" style={{ alignItems: 'center' }}>
        <div className="sym-row">
          <TokenLogo profile={launch.profile} symbol={symbol} size={48} />
          <h1>{symbol}</h1>
        </div>
        <StatusChip
          graduated={detail.state.graduated}
          migrated={detail.migrated}
          rules={detail.rules}
        />
      </div>
      <p className="sub mono" style={{ fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
        {detail.denom}
      </p>

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

      {hasAnyRule(detail.rules) && (
        <div className="card" style={{ marginTop: 'var(--space-5)' }}>
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

      <div className="cols" style={{ marginTop: 'var(--space-5)' }}>
        <div>
          <div className="card">
            <h2>Price curve</h2>
            <CurveChart config={detail.config} state={detail.state} />
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
                {fmt(price, 18, 10)} {NETWORK.quoteSymbol} / {symbol}
              </span>
            </div>
            <div className="metric-row">
              <span className="k">Raised</span>
              <span className="v mono">
                {fmt(detail.state.injCollected, 18, 3)} {NETWORK.quoteSymbol}
              </span>
            </div>
            <div className="metric-row">
              <span className="k">Graduates at</span>
              <span className="v mono">
                {fmt(detail.config.graduationTarget, 18, 0)} {NETWORK.quoteSymbol}
              </span>
            </div>
            <div className="metric-row">
              <span className="k">Curve ceiling</span>
              <span className="v mono">
                {fmt(ceiling, 18, 2)} {NETWORK.quoteSymbol}
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
              <span className="v mono">{short(detail.creator)}</span>
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
        </div>

        <TradePanel
          config={detail.config}
          state={detail.state}
          symbol={symbol}
          tradingClosed={detail.state.graduated}
          rules={detail.rules}
        />

      <Trades curve={launch.curve} denom={launch.denom} />
      </div>
    </>
  );
}
