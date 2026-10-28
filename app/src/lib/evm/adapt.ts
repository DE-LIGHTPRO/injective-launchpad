/**
 * EVM reads, in the shapes `chain.ts` already returns.
 *
 * The adapter layer, deliberately separate from `read.ts`: that file speaks EVM and
 * this one speaks the app's vocabulary. Keeping them apart is what stops the UI's
 * types leaking into the transport, and it is why the CosmWasm path needed no
 * changes at all when this was added.
 */
import type { Address } from 'viem';

import type { Launch, LaunchDetail } from '../chain.ts';
import { NO_RULES } from '../launchRules.ts';

import { getEvmDetail, listEvmLaunches } from './read.ts';

/**
 * A launch row.
 *
 * `denom` carries the token's CONTRACT ADDRESS here, where the CosmWasm side carries
 * a tokenfactory denom string. Both are "the identifier the chain knows this token
 * by", which is the only thing anything downstream does with it, and the alternative
 * was a second field that 184 files would have to learn about.
 *
 * The symbol is appended in the `factory/.../SYMBOL` shape the UI already parses, so
 * the board shows a ticker rather than an address without any component changing.
 */
export async function listLaunchesEvm(): Promise<Launch[]> {
  const rows = await listEvmLaunches();
  return rows.map((r) => ({
    id: r.id,
    denom: r.symbol ? `evm/${r.token}/${r.symbol}` : r.token,
    creator: r.creator,
    curve: r.curve,
    /*
     * EMPTY RATHER THAN INVENTED. The EVM contracts carry no profile: no image, no
     * website, no socials. Every field is null, which the UI already renders as
     * absent, where a made-up placeholder would render as content the creator never
     * supplied.
     */
    profile: {
      image: null,
      website: null,
      x: null,
      telegram: null,
      description: null,
    },
  }));
}

export async function getLaunchEvm(id: number): Promise<Launch | null> {
  const all = await listLaunchesEvm();
  return all.find((l) => l.id === id) ?? null;
}

export async function getLaunchDetailEvm(curveAddress: string): Promise<LaunchDetail> {
  const d = await getEvmDetail(curveAddress as Address);
  return {
    denom: d.token,
    quoteDenom: 'inj',
    creator: d.creator,
    lpReserve: d.lpReserve,
    rewardRoute: d.rewardRoute,
    config: d.config,
    state: d.state,
    migrated: d.migrated,
    pool: d.pool,
    platformOwed: d.platformOwed,
    creatorOwed: d.creatorOwed,
    platformPaid: d.platformPaid,
    creatorPaid: d.creatorPaid,
    /*
     * The EVM contracts carry no launch rules: no wallet cap, no allowlist, no
     * start-time gate beyond `tradeStart`. NO_RULES is the honest value, not an
     * empty object that would render as "rules: none configured" and read as though
     * the feature existed and was switched off.
     */
    rules: NO_RULES,
  };
}
