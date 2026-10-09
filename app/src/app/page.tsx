import type { LaunchRules } from '@/lib/launchRules';
import Link from 'next/link';
import { listLaunches, getLaunchDetail, symbolOf, short, type Launch } from '@/lib/chain';
import { graduationProgress, fmt } from '@/lib/curve';
import { isDeployed, isDevBuild, NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { DemoBanner } from '@/components/DemoBanner';
import { LaunchList, type LaunchRow } from '@/components/LaunchList';

export const dynamic = 'force-dynamic';

interface Row {
  launch: Launch;
  raised: bigint;
  target: bigint;
  progress: number;
  graduated: boolean;
  rules: LaunchRules;
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
          rules: d.rules,
        };
      }),
    );
    return { rows };
  } catch (e) {
    const err = e as Error & { detail?: string };
    return { rows: [], error: err.message, errorDetail: err.detail };
  }
}

/**
 * Base units cross the server boundary as decimal strings.
 *
 * These are bigints on the server and bigints again in the list, but a bigint is
 * not serialisable as a server-component prop: passing one throws at render, and
 * passing it as a Number would silently lose precision at 18 decimals, which is
 * the quieter failure and the worse one.
 */
function toRow(r: Row): LaunchRow {
  return {
    id: r.launch.id,
    denom: r.launch.denom,
    creator: r.launch.creator,
    // Already normalised by `parseProfile` at the chain boundary. Plain strings and
    // nulls, so it crosses the server-component boundary without the bigint problem
    // described above.
    profile: r.launch.profile,
    // The list needs the rules only to label the status honestly; the row stays
    // serialisable because rules are a bigint-free shape by the time they get here.
    rules: r.rules,
    raised: r.raised.toString(),
    target: r.target.toString(),
    progress: r.progress,
    graduated: r.graduated,
  };
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
        <div style={{ marginTop: 'var(--space-5)' }}>
          <LaunchList rows={rows.map(toRow)} />
        </div>
      )}
    </>
  );
}
