import type { Metadata } from 'next';
import { ClaimFees } from '@/components/ClaimFees';

export const metadata: Metadata = {
  title: 'Claim fees · Vetta',
  description: 'Fees your launches have earned, claimable in one transaction.',
};

export default function ClaimPage() {
  return (
    <>
      <h1>Claim your fees</h1>
      <p className="note">
        70% of every trading fee on a launch you created is yours. It accrues on the
        curve and is claimable at any time, whether or not the launch has graduated.
      </p>
      <div className="card" style={{ marginTop: 'var(--space-4)' }}>
        <ClaimFees />
      </div>
    </>
  );
}
