'use client';

import { useEffect, useRef, useState } from 'react';

import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, oversizeMessage } from '@/lib/uploadSize';

/**
 * Drop a logo in, get a URL back.
 *
 * The logo field took a URL and nothing else, so a creator holding a PNG had to go and
 * host it somewhere before they could launch, and the profile is immutable so they get
 * one attempt at getting the address right.
 *
 * IT RENDERS NOTHING WHEN THE SERVER HAS NO STORAGE CREDENTIAL. Not a disabled button:
 * a greyed-out control implies a version of this product where it works, and the URL
 * field beneath it is a complete answer on its own. Availability is asked of the
 * server, which either holds the credential or does not, rather than read from a
 * second flag that could disagree with it.
 *
 * IT SAID IPFS, AND IT HAS NOT BEEN IPFS FOR A WHILE. This docblock promised an
 * `ipfs://` address and the drop zone said "Pinning to IPFS" while the route returned
 * an `https://` Blob URL, because the route was rewritten and its label was not. That
 * is a false statement about where a creator's file goes, which is worth more care
 * than a stale comment: the field still accepts an `ipfs://` address typed by hand, so
 * a creator who wanted IPFS had every reason to believe this control gave them it.
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
    /*
     * MEASURED HERE BECAUSE THE SERVER MAY NEVER SEE IT. Audit F-16. The host refuses a
     * body over 4,500,000 bytes before the route is invoked, so for a file past that the
     * route's own size message does not exist to be sent: what comes back is a
     * `text/plain` platform page, `res.json()` fails, and the creator was told "That
     * upload did not go through." about a file the label above said was fine.
     *
     * So this is not an optimisation, it is the only place a correct sentence can be
     * produced for the largest files. It saves the upload too, which on a phone is the
     * creator's own bandwidth spent to be refused.
     *
     * In `send` rather than in the two callers, because the picker and the drop target
     * both arrive here and a check written twice is a check that will be written once.
     */
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(oversizeMessage(file.size));
      return;
    }
    if (file.size === 0) {
      setError('That file is empty.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body });
      const data = (await res.json().catch(() => null)) as { uri?: string; error?: string } | null;
      if (!res.ok || typeof data?.uri !== 'string') {
        /*
         * A 413 with no JSON body is the host refusing the request, not our route
         * answering, so there is no `error` to read and the generic sentence is wrong
         * about why. The check above should have caught this, which is exactly why this
         * branch says something true rather than being left as the fallback: the
         * envelope rides along with the file, so a file just under the limit can still
         * put the request over it, and that is the creator this branch is for.
         */
        if (res.status === 413 && !data) {
          setError(`That image is too large to upload. The limit is ${MAX_UPLOAD_LABEL}.`);
          return;
        }
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
        {busy ? 'Uploading…' : 'Drop an image here, or pick one'}
        <span className="note">PNG, JPEG, WEBP or GIF, up to {MAX_UPLOAD_LABEL}</span>
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
