import Link from 'next/link';
import { CreateLaunch } from '@/components/CreateLaunch';
import { DemoBanner } from '@/components/DemoBanner';
import { isDeployed } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';

export const metadata = { title: 'Create a launch' };

export default function CreatePage() {
  return (
    <>
      <DemoBanner />
      <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
        <Link href="/">&larr; launches</Link>
      </p>
      {!isDeployed() && !isDemoMode() ? (
        <div className="card">
          <h1>Create a launch</h1>
          <p className="note">
            The launchpad is not deployed yet, so there is no factory to create against. The form
            opens as soon as one is configured.
          </p>
        </div>
      ) : (
        <CreateLaunch />
      )}
    </>
  );
}
