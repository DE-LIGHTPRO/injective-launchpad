import type { UnreadableLaunch } from '@/lib/boardRows';
import { symbolOf } from '@/lib/chain';
import { isDevBuild } from '@/lib/config';

/**
 * Names the launches the factory listed and the board could not read.
 *
 * WHY THIS EXISTS AT ALL. `loadRows` used to fan out every launch's detail with a
 * bare `Promise.all`, which rejects on the first failure, so one curve the node
 * would not answer for returned an empty board carrying that one curve's error as
 * the whole launchpad's. Making the read settle per launch fixes the blanking and
 * creates this obligation: the rows that did load are now an INCOMPLETE list, and a
 * board that silently serves a subset is the silently-truncated list `listLaunches`
 * was rewritten to fix, arriving by a different route.
 *
 * So it names the tickers rather than counting them. "3 launches could not be read"
 * tells a holder nothing about whether theirs is one of them, and the whole reason
 * somebody opens a board mid-incident is to find their own token.
 *
 * ONE COMPONENT BECAUSE FIVE SURFACES RENDER THIS. Five copies of this copy is how
 * one of them ends up saying something the others do not, and the only version
 * anyone would notice is the one that went missing.
 */
export function UnreadableNotice({ unreadable }: { unreadable: UnreadableLaunch[] }) {
  if (unreadable.length === 0) return null;
  /*
   * The reasons, not a reason. These come from `translateQueryError`, which tells a
   * pruned height apart from a contract that is not on this network, and collapsing
   * them to the first would hide the case where they differ - which is the case worth
   * seeing, because one bad curve and a failing endpoint look the same from a count.
   */
  const reasons = [...new Set(unreadable.map((u) => u.reason))];
  const one = unreadable.length === 1;
  return (
    <div className="read-gap" role="status">
      <strong>Incomplete</strong>
      {/*
       * "not counted below" rather than "missing from the board", because five surfaces
       * render this: a board, a portfolio, a watchlist, a creator's fee totals and the
       * analytics page. The one thing true of all of them is that a launch nobody could
       * read is absent from the figures, and on the summing pages absent is what makes
       * every total a lower bound.
       */}
      <span>
        The factory lists {one ? 'this launch' : 'these launches'} and{' '}
        {one ? 'its curve' : 'their curves'} did not answer, so{' '}
        {one ? 'it is' : 'they are'} not counted below:{' '}
        <span className="mono">{unreadable.map((u) => symbolOf(u.denom)).join(', ')}</span>.{' '}
        {reasons.join(' ')} Nothing is wrong with the tokens themselves, and a reload may
        reach a node that answers.
      </span>
      {isDevBuild() && (
        <code>
          {unreadable.map((u) => `#${u.id} ${u.denom}: ${u.detail ?? u.reason}`).join(' | ')}
        </code>
      )}
    </div>
  );
}
