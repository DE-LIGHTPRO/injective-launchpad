import { NETWORK, isDevBuild } from '@/lib/config';
import type { CodeStatus } from '@/lib/codeCheck';

/**
 * What code this launch runs, said where a buyer looks before trading.
 *
 * Verified is a quiet line; a mismatch or an admin is a loud card, because either one
 * means the contract holding the reserve and the locked pool is not the one this
 * launchpad published, or can be swapped for one that is not. The trade panel is
 * disabled in those cases.
 *
 * IT DOES NOT SAY "AUDITED", AND IT USED TO.
 *
 * `docs/AUDIT.md` opens with "Not a third-party audit" and `docs/AUDIT_SCOPE.md` is a
 * document written FOR an auditor who has not been engaged. Meanwhile this line read
 * "Audited contract (code 39974)" and the badge beside it read "Audited code 39974",
 * on the screen where somebody decides to spend money. To a trader "audited" means a
 * third party reviewed this and signed their name to it, and nobody has.
 *
 * What the check actually establishes is worth saying plainly and is all stated here:
 * the code id matches the one this launchpad published, the contract has no upgrade
 * key, and the launch contract holds the denom's mint key. Those are three facts read
 * off the chain at page load. "Audited" was a fourth claim, read off nothing.
 *
 * AND "PUBLISHED" IS TWO DIFFERENT CLAIMS, so it is now two different sentences.
 * `pin: 'hash'` means the running bytes are the bytes in this repository, which anyone
 * can rebuild and check. `pin: 'code-id'` means only that the id is one this build
 * names, which nobody outside can check against anything. The second was rendering the
 * first's wording. Both are real checks and only one of them is reproducible, and the
 * difference belongs on the screen rather than in the operator's head.
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
          {status.pin === 'hash'
            ? `Runs this launchpad's published contract byte for byte (code ${status.codeId}, hash checked against the release), with no`
            : `Runs code ${status.codeId}, the version this launchpad pins, with no`}{' '}
          upgrade key, and the launch contract holds the only mint key: the supply is
          fixed and the liquidity cannot be moved by anyone. {link}
        </p>
      );
    case 'unpinned':
      // Only a dev build says anything: an unpinned production build is our mistake to
      // fix, and telling users "unverified" about every launch would train them to
      // ignore the warning that matters.
      return isDevBuild() ? (
        <p className="note">
          Code {status.codeId}, no upgrade key. Set NEXT_PUBLIC_CURVE_CODE_HASHES to pin the
          published code by hash, which is the pin a reader can reproduce from the repository.
        </p>
      ) : null;
    case 'unexpected-code':
      return (
        <div className="card" role="alert">
          <h2 className="danger-text">Unrecognised contract code</h2>
          <p className="note">
            This launch runs code {status.codeId}, which is not a version this launchpad
            published ({status.expected.join(', ')}). Trading is disabled here. {link}
          </p>
        </div>
      );
    case 'unexpected-hash':
      /*
       * Worded harder than `unexpected-code` on purpose. An unexpected id can be an
       * upgrade the operator published and forgot to add to the list. An unexpected
       * hash cannot: it is the chain reporting that the code holding this reserve is
       * not the code that was released, under an id that was meant to be it.
       */
      return (
        <div className="card" role="alert">
          <h2 className="danger-text">This is not the published contract</h2>
          <p className="note">
            The code holding this launch&rsquo;s reserve (code {status.codeId}) does not match
            any release this launchpad published. Its hash is {status.hash.slice(0, 16)}… and
            the published ones are {status.expected.map((h) => `${h.slice(0, 16)}…`).join(', ')}.
            Trading is disabled here. {link}
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
