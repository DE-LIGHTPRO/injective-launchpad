import { NETWORK, isDevBuild } from '@/lib/config';
import type { CodeStatus } from '@/lib/codeCheck';

/**
 * What code this launch runs, said where a buyer looks before trading.
 *
 * Verified is a quiet line; a mismatch or an admin is a loud card, because either one
 * means the contract holding the reserve and the locked pool is not the one we audited,
 * or can be swapped for one that is not. The trade panel is disabled in those cases.
 */
export function CodeCheck({ status, curve }: { status: CodeStatus; curve: string }) {
  const link = (
    <a href={`${NETWORK.explorer}/contract/${curve}`} target="_blank" rel="noopener noreferrer">
      view on explorer
    </a>
  );
  switch (status.kind) {
    case 'verified':
      return (
        <p className="note">
          Audited contract (code {status.codeId}), no upgrade key, and the launch contract
          holds the only mint key: the supply is fixed and the liquidity cannot be moved by
          anyone. {link}
        </p>
      );
    case 'unpinned':
      // Only a dev build says anything: an unpinned production build is our mistake to
      // fix, and telling users "unverified" about every launch would train them to
      // ignore the warning that matters.
      return isDevBuild() ? (
        <p className="note">
          Code {status.codeId}, no upgrade key. Set NEXT_PUBLIC_CURVE_CODE_IDS to pin the
          audited code id.
        </p>
      ) : null;
    case 'unexpected-code':
      return (
        <div className="card" role="alert">
          <h2 className="danger-text">Unrecognised contract code</h2>
          <p className="note">
            This launch runs code {status.codeId}, which is not an audited version (
            {status.expected.join(', ')}). Trading is disabled here. {link}
          </p>
        </div>
      );
    case 'has-admin':
      return (
        <div className="card" role="alert">
          <h2 className="danger-text">This contract can be replaced</h2>
          <p className="note">
            It has an upgrade key ({status.admin}), so whoever holds it could change the code
            holding the reserve. Trading is disabled here. {link}
          </p>
        </div>
      );
    case 'mint-key-held':
      return (
        <div className="card" role="alert">
          <h2 className="danger-text">Someone can mint more of this token</h2>
          <p className="note">
            The right to mint is held by {status.holder}, not by the launch contract. Whoever
            holds it can create tokens without limit and sell them into the pool. Trading is
            disabled here. {link}
          </p>
        </div>
      );
    case 'unknown':
      return null;
  }
}
