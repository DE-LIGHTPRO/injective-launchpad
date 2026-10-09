import Link from 'next/link';

/**
 * A launch id that does not exist, which is an ordinary thing to type or to follow
 * from a stale link. Without this it rendered as an unhandled error, so a wrong number
 * in a URL looked like the site breaking.
 */
export default function NotFound() {
  return (
    <div className="card" style={{ marginTop: 'var(--space-6)' }}>
      <h1>No such launch</h1>
      <p className="note">
        There is nothing at this address. The launch may not exist on the network this
        app is pointed at, or the link may be from a different one.
      </p>
      <p style={{ marginTop: 'var(--space-4)' }}>
        <Link href="/" className="nav-create">
          Back to launches
        </Link>
      </p>
    </div>
  );
}
