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

import { createdAtOf, getEvmDetail, listEvmLaunches } from './read.ts';
import { evmDenom } from './denom.ts';

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
    denom: evmDenom(r.token, r.symbol),
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
  /*
   * In parallel: the detail comes off the curve and the creation time off the factory,
   * and neither needs the other. Serial they would be two round trips for one page.
   */
  const [d, createdAt] = await Promise.all([
    getEvmDetail(curveAddress as Address),
    createdAtOf(curveAddress as Address),
  ]);
  return {
    /*
     * THE SAME FORM THE BOARD USES. This returned the bare address, so the board
     * said PAD and the launch page said 0x97bc…deEA about one token, and the page
     * heading rendered the address uppercased as the token's name.
     */
    denom: evmDenom(d.token, d.symbol),
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
     * REAL RULES NOW. The EVM contracts carry MAX_PER_WALLET and enforce it on every
     * curve buy, freeing allowance on a sell, so this reads them rather than
     * returning NO_RULES.
     *
     * `0` on chain means no cap, and `null` is how the app says that: zero would
     * render as "max 0 per wallet", a cap nobody could buy under.
     */
    rules: {
      ...NO_RULES,
      maxPerWallet: d.maxPerWallet > 0n ? d.maxPerWallet : null,
      tradeStart: d.tradeStart > 0n ? Number(d.tradeStart) : null,
      /*
       * From the FACTORY's row, not the curve, which is why it needed a second read:
       * the curve contract has no creation timestamp and the factory's `launches`
       * struct does. The page was showing "not recorded" for an age the chain records.
       * `null` on a failed read, which that fallback is the right answer for.
       */
      openedAt: createdAt,
    },
  };
}
