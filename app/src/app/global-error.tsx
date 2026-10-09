'use client';

/**
 * The boundary of last resort: a throw in the root layout itself.
 *
 * `error.tsx` renders INSIDE the layout, so it cannot catch the layout throwing. This
 * one replaces the whole document, which is why it carries its own `<html>` and
 * `<body>` and why it cannot use any of the app's styles: the stylesheet is loaded by
 * the layout that just failed. Everything here is inline for that reason, not for
 * expedience.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#070910',
          color: '#eef1f7',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          padding: '24px',
        }}
      >
        <div style={{ maxWidth: '32rem' }}>
          <h1 style={{ fontSize: '1.375rem', marginBottom: '0.75rem' }}>inj·pad could not load</h1>
          <p style={{ color: '#9aa3b8', lineHeight: 1.6 }}>
            <strong style={{ color: '#eef1f7' }}>Nothing was signed and no transaction was sent.</strong>{' '}
            The page itself failed to start. Reloading usually clears it.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1rem',
              font: 'inherit',
              padding: '0.5rem 1rem',
              borderRadius: '10px',
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(255,255,255,0.06)',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
          {error.digest && (
            <p style={{ color: '#68718a', fontSize: '0.75rem', marginTop: '1rem' }}>
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
