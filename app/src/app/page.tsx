import { CurveGlyph } from '@/components/CurveGlyph';
import type { LaunchRules } from '@/lib/launchRules';
import Link from 'next/link';
import { listLaunches, getLaunchDetail, symbolOf, short, type Launch } from '@/lib/chain';
import { graduationProgress, fmt, type CurveConfig } from '@/lib/curve';
import { isDeployed, isDevBuild, NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { DemoBanner } from '@/components/DemoBanner';
import { LaunchList, type LaunchRow } from '@/components/LaunchList';

export const dynamic = 'force-dynamic';

/*
 * The shape the create form starts from, so the empty state shows what this product
 * actually makes rather than an invented flourish. Kept beside the page that draws it
 * rather than imported from the form, because the form's defaults are a creator's
 * starting point and may reasonably change without this illustration following.
 */
const ONE_TOKEN = 10n ** 18n;
const DEFAULT_SHAPE = {
  virtualInj: 30n * ONE_TOKEN,
  virtualTokens: 1_073_000_000n * ONE_TOKEN,
  curveSupply: 800_000_000n * ONE_TOKEN,
  graduationTarget: 85n * ONE_TOKEN,
  feeBps: 100n,
};
const FRESH = { injCollected: 0n, tokensSold: 0n, graduated: false };

interface Row {
  launch: Launch;
  raised: bigint;
  target: bigint;
  progress: number;
  graduated: boolean;
  rules: LaunchRules;
  config: CurveConfig;
  tokensSold: bigint;
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
          config: d.config,
          tokensSold: d.state.tokensSold,
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
    curve: {
      virtualInj: r.config.virtualInj.toString(),
      virtualTokens: r.config.virtualTokens.toString(),
      curveSupply: r.config.curveSupply.toString(),
      graduationTarget: r.config.graduationTarget.toString(),
      feeBps: r.config.feeBps.toString(),
    },
    tokensSold: r.tokensSold.toString(),
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
        /*
         * The empty state of a live launchpad with nothing on it is, right now, the
         * entire front page. A bordered box reading "no launches yet" is a dead end:
         * it reports a fact and offers nothing, on the one screen where the only
         * useful action is obvious.
         *
         * The curve is drawn at the real default shape a launch gets, so someone
         * arriving sees what the product makes before they have anything to look at.
         */
        <div className="empty-hero" style={{ marginTop: 'var(--space-5)' }}>
          <CurveGlyph config={DEFAULT_SHAPE} state={FRESH} height={120} showMarker={false} />
          <h2>Nothing has launched yet</h2>
          <p className="note">
            Every token here starts on a curve like this one. The creator supplies the
            tokens, buyers bring {NETWORK.quoteSymbol}, and the price rises along the
            curve until it graduates to a pool.
          </p>
          <Link href="/create" className="go empty-cta">
            Create the first launch
          </Link>
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
