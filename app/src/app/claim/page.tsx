import type { Metadata } from 'next';
import { ClaimFees } from '@/components/ClaimFees';
import { CREATOR_FEE_SHARE_BPS } from '@/lib/launchLimits';

export const metadata: Metadata = {
  title: 'Claim fees',
  description: 'Fees your launches have earned, claimable in one transaction.',
};

export default function ClaimPage() {
  return (
    <>
      <h1>Claim your fees</h1>
      {/*
        * Was "70% of every trading fee", typed rather than derived and wrong about
        * "every": an opening fee's premium is carved off before the split and goes to
        * the locked pool, so it is not part of what accrues here.
        */}
      <p className="note">
        {CREATOR_FEE_SHARE_BPS / 100}% of a launch&rsquo;s own trading fee is the
        creator&rsquo;s. It accrues on the curve and is claimable at any time, whether
        or not the launch has graduated.
      </p>
      <div className="card" style={{ marginTop: 'var(--space-4)' }}>
        <ClaimFees />
      </div>
    </>
  );
}
