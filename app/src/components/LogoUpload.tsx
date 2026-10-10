'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Drop a logo in, get an `ipfs://` address back.
 *
 * The logo field took a URL and nothing else, so a creator holding a PNG had to go and
 * host it somewhere before they could launch, and the profile is immutable so they get
 * one attempt at getting the address right. nearly.trade takes the file.
 *
 * IT RENDERS NOTHING WHEN THE SERVER HAS NO PINNING KEY. Not a disabled button: a
 * greyed-out control implies a version of this product where it works, and the URL
 * field beneath it is a complete answer on its own. Availability is asked of the
 * server, which either holds the credential or does not, rather than read from a
 * second flag that could disagree with it.
 */
export function LogoUpload({ onUploaded }: { onUploaded: (uri: string) => void }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let live = true;
    void fetch('/api/upload')
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((d) => live && setAvailable(Boolean(d?.configured)))
      // A failed probe is "not available", never "available": offering a control that
      // then fails is worse than not offering it.
      .catch(() => live && setAvailable(false));
    return () => {
      live = false;
    };
  }, []);

  async function send(file: File) {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body });
      const data = (await res.json().catch(() => null)) as { uri?: string; error?: string } | null;
      if (!res.ok || typeof data?.uri !== 'string') {
        setError(data?.error ?? 'That upload did not go through.');
        return;
      }
      onUploaded(data.uri);
    } catch {
      setError('That upload did not go through.');
    } finally {
      setBusy(false);
    }
  }

  // `null` is still probing and `false` is unavailable. Neither draws anything, so the
  // control never flashes in and out while the answer is in flight.
  if (available !== true) return null;

  return (
    <div className="logo-drop-wrap">
      <div
        className={`logo-drop${over ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="Upload a logo image"
        onClick={() => input.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            input.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void send(f);
        }}
      >
        {busy ? 'Pinning to IPFS…' : 'Drop an image here, or pick one'}
        <span className="note">PNG, JPEG, WEBP or GIF, up to 5 MB</span>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void send(f);
          // Cleared so picking the same file twice fires change again, which it
          // otherwise would not after a failed attempt.
          e.target.value = '';
        }}
      />
      {error && <p className="note err-text">{error}</p>}
    </div>
  );
}
