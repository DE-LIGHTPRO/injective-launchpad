import Link from 'next/link';
import { listLaunches, getLaunchDetail, symbolOf, short, type Launch } from '@/lib/chain';
import { graduationProgress, fmt } from '@/lib/curve';
import { isDeployed, isDevBuild, NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { DemoBanner } from '@/components/DemoBanner';

export const dynamic = 'force-dynamic';

interface Row {
  launch: Launch;
  raised: bigint;
  target: bigint;
  progress: number;
  graduated: boolean;
}

async function loadRows(): Promise<{ rows: Row[]; error?: string; errorDetail?: string }> {
  try {
    const launches = await listLaunches();
    const rows = await Promise.all(
      launches.map(async (launch) => {
        const d = await getLaunchDetail(launch.curve);
        return {
          launch,
          raised: d.state.injCollected,
          target: d.config.graduationTarget,
          progress: graduationProgress(d.config, d.state),
          graduated: d.state.graduated,
        };
      }),
    );
    return { rows };
  } catch (e) {
    const err = e as Error & { detail?: string };
    return { rows: [], error: err.message, errorDetail: err.detail };
  }
}

export default async function Home() {
  const live = isDeployed() || isDemoMode();

  if (!live) {
    return (
      <>
        <h1>Launches</h1>
        <p className="sub">One-sided bonding curve launches on Injective.</p>
        <div className="empty" style={{ marginTop: 'var(--space-5)' }}>
          <p>No launches yet. Check back shortly.</p>
          {isDevBuild() && (
            <>
              <p className="note">
                Dev: nothing configured. Deploy to {NETWORK.name} and set the factory address, or
                run with NEXT_PUBLIC_DEMO=1 to explore the interface.
              </p>
              <code>NEXT_PUBLIC_FACTORY_ADDRESS=inj1…</code>
            </>
          )}
        </div>
      </>
    );
  }

  const { rows, error, errorDetail } = await loadRows();

  return (
    <>
      <DemoBanner />

      <h1>Launches</h1>
      <p className="sub">
        The creator supplies only tokens. Buyers bring {NETWORK.quoteSymbol}, and the curve
        prices every trade until it graduates.
      </p>

      {error && (
        <div className="empty" style={{ marginTop: 'var(--space-5)' }}>
          <p className="danger-text">{error}</p>
          {isDevBuild() && errorDetail && <code>{errorDetail}</code>}
        </div>
      )}

      {!error && rows.length === 0 && (
        <div className="empty" style={{ marginTop: 'var(--space-5)' }}>
          <p>No launches yet. The first one is waiting to be created.</p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="grid" style={{ marginTop: 'var(--space-5)' }}>
          {rows.map(({ launch, raised, target, progress, graduated }) => (
            <Link key={launch.id} href={`/launch/${launch.id}`} className="card">
              <div className="card-head">
                <div>
                  <div className="sym">{symbolOf(launch.denom)}</div>
                  <div className="denom mono">{launch.denom}</div>
                </div>
                <span className={`chip ${graduated ? 'warn' : 'accent'}`}>
                  {graduated ? 'graduated' : 'live'}
                </span>
              </div>

              <div className="bar">
                <i style={{ width: `${Math.min(100, progress * 100).toFixed(1)}%` }} />
              </div>

              <div style={{ marginTop: 'var(--space-4)' }}>
                <div className="metric-row">
                  <span className="k">Raised</span>
                  <span className="v mono">
                    {fmt(raised, 18, 2)} / {fmt(target, 18, 0)} {NETWORK.quoteSymbol}
                  </span>
                </div>
                <div className="metric-row">
                  <span className="k">Progress</span>
                  <span className="v mono">{(progress * 100).toFixed(1)}%</span>
                </div>
                <div className="metric-row">
                  <span className="k">Creator</span>
                  <span className="v mono">{short(launch.creator)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
