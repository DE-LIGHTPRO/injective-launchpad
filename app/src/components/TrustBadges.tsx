import type { CodeStatus } from '@/lib/codeCheck';

/**
 * The guarantees, as badges, and only when they have been CHECKED for this launch.
 *
 * Both comparable launchpads lead with their guarantees (locked liquidity, fixed
 * supply); here they are also verified per launch by `lib/codeCheck.ts` against the
 * chain. When the check could not run (`unknown`), nothing is claimed: a badge that
 * renders without evidence is marketing, and on this page it would be a lie of exactly
 * the kind the code check exists to catch.
 */
export function TrustBadges({
  status,
  migrated,
  demo,
}: {
  status: CodeStatus;
  migrated: boolean;
  demo: boolean;
}) {
  const checked = demo || status.kind === 'verified' || status.kind === 'unpinned';
  if (!checked) return null;
  return (
    <div className="trust" aria-label="Verified properties">
      <span>Fixed supply, no mint key</span>
      <span>No upgrade key</span>
      <span className="locked">{migrated ? 'Liquidity locked forever' : 'Liquidity locks at graduation'}</span>
      {status.kind === 'verified' && <span>Audited code {status.codeId}</span>}
    </div>
  );
}
