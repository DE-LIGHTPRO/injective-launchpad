import Link from 'next/link';
import { CreateLaunch } from '@/components/CreateLaunch';
import { DemoBanner } from '@/components/DemoBanner';
import { isDeployed } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { EmptyState } from '@/components/EmptyState';
import { MarkLaunches } from '@/components/EmptyMark';
import { NETWORK } from '@/lib/config';

export const metadata = { title: 'Create a launch' };

export default function CreatePage() {
  return (
    <>
      <DemoBanner />
      <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
        <Link href="/">&larr; launches</Link>
      </p>
      {!isDeployed() && !isDemoMode() ? (
        <>
          <h1>Create a launch</h1>
          <EmptyState mark={<MarkLaunches />} title="No factory to create against yet">
            The launchpad is not deployed on {NETWORK.label}, so there is nothing for a
            launch to be created on. The form opens as soon as one is configured.
          </EmptyState>
        </>
      ) : (
        <CreateLaunch />
      )}
    </>
  );
}
