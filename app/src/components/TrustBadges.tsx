import type { CodeStatus } from '@/lib/codeCheck';
import { CheckIcon } from './Icons';

/**
 * The guarantees, and only when they have been CHECKED for this launch.
 *
 * Verified per launch by `lib/codeCheck.ts` against the chain. When the check could
 * not run (`unknown`), nothing is claimed: a badge that renders without evidence is
 * marketing, and here it would be exactly the lie the code check exists to catch.
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
  const items = [
    'Fixed supply',
    'No upgrade key',
    migrated ? 'Liquidity locked' : 'Liquidity locks at graduation',
    ...(status.kind === 'verified' ? [`Audited code ${status.codeId}`] : []),
  ];
  return (
    <ul className="trust" aria-label="Verified on chain">
      {items.map((t) => (
        <li key={t}>
          <span>
            <CheckIcon size={13} />
            {t}
          </span>
        </li>
      ))}
    </ul>
  );
}
