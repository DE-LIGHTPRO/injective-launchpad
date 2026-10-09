'use client';

import { useCallback, useState } from 'react';

/**
 * Copy a value, and say whether it worked.
 *
 * A contract address is the thing people verify a token with, and selecting 60
 * characters of monospace by hand on a phone is the reason they do not.
 *
 * The confirmation is not decoration. `navigator.clipboard` REJECTS outside a secure
 * context and when the document is not focused, and a button that silently does
 * nothing in those cases is worse than no button: the user believes they have the
 * address and pastes whatever was there before.
 */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('done');
    } catch {
      /*
       * Reported rather than swallowed. The usual causes are an insecure origin or an
       * unfocused document, and the user can act on "could not copy" by selecting the
       * text themselves. They cannot act on nothing happening.
       */
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 2_000);
  }, [value]);

  return (
    <button
      type="button"
      className="copy-btn"
      onClick={() => void copy()}
      /* The live region announces the result; without it a screen reader user gets no
         feedback at all, since the only change is the visible word. */
      aria-live="polite"
    >
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Could not copy' : label}
    </button>
  );
}
