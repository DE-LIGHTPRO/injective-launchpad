import Link from 'next/link';
import { getLaunch, getLaunchDetail, symbolOf, short } from '@/lib/chain';
import { graduationProgress, fmt, spotPrice, maxCollectable } from '@/lib/curve';
import { NETWORK, isDeployed, isDevBuild } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { CurveChart } from '@/components/CurveChart';
import { DemoBanner } from '@/components/DemoBanner';
import { TradePanel } from '@/components/TradePanel';

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
        <h1>{symbol}</h1>
        <span className={`chip ${detail.state.graduated ? 'warn' : 'accent'}`}>
          {detail.state.graduated ? (detail.migrated ? 'migrated' : 'graduated') : 'live'}
        </span>
      </div>
      <p className="sub mono" style={{ fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
        {detail.denom}
      </p>

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
        />
      </div>
    </>
  );
}
