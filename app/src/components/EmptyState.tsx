import type { ReactNode } from 'react';

/**
 * What a page shows when it has nothing to show, in one shape.
 *
 * WHY A COMPONENT. There were three empty states and three different treatments. The
 * watchlist had a heading, a sentence and a button inside a panel. Portfolio had a bare
 * `<p>`. Claim had a bare `<p>` inside a dashed box with no heading at all, which made
 * it the thinnest page in the product - a reader arriving there saw one grey sentence
 * and nothing else. The same situation should not look like three different products.
 *
 * `action` is optional AND IS LEFT OUT ON PURPOSE where the only useful action is
 * connecting a wallet. The header's connect button is sticky and always in view, so a
 * second one here is the same control twice on one screen; that reasoning was already
 * written down in `Portfolio` and it still holds. The watchlist's "Browse launches" is
 * a different destination, so it stays.
 */
export function EmptyState({
  mark,
  title,
  children,
  action,
}: {
  /** The page's own mark. See `EmptyMark` on why these are not one shared asset. */
  mark: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {mark}
      <h3>{title}</h3>
      <p className="note">{children}</p>
      {action}
    </div>
  );
}
