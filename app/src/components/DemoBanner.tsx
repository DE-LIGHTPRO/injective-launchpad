import { isDemoMode } from '@/lib/demo';

/**
 * Says plainly that these launches are not real. It is deliberately
 * unmissable and never styled down: a demo that reads as live data is worse
 * than no demo at all.
 */
export function DemoBanner() {
  if (!isDemoMode()) return null;
  return (
    <div className="demo-banner" role="status">
      <strong>Demo</strong>
      <span>
        These launches are generated locally from the real curve maths. No contracts are
        deployed and nothing here is a market price.
      </span>
    </div>
  );
}
