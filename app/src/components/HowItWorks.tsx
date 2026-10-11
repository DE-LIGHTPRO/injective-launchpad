import { NETWORK } from '@/lib/config';
import { MAX_EARLY_FEE_PCT } from '@/lib/boardMetrics';

/**
 * What this is, for someone who arrives before there is anything to look at.
 *
 * An empty launchpad is a page with one job, and "no launches yet" is not it. A
 * visitor who has never seen a bonding curve cannot tell what they are being offered,
 * and a visitor who has seen fifty launchpads cannot tell what is different here.
 * Both questions have real answers and neither was on the page.
 *
 * It stays below the board once launches exist rather than being removed: the
 * guarantees are the reason to use this over the alternatives, and a differentiator
 * that only shows while the product is empty is a differentiator nobody reads.
 *
 * EVERY CLAIM HERE IS ENFORCED BY THE CONTRACT, not by intent. That constraint is the
 * point of the section and the reason it is short: anything that would need a promise
 * from an operator is left out.
 */
export function HowItWorks() {
  const q = NETWORK.quoteSymbol;

  return (
    <>
      <section className="explain" aria-labelledby="how-heading">
        <h2 id="how-heading">How a launch works</h2>
        <ol className="steps">
          <li>
            <span className="step-n">1</span>
            <div>
              <strong>The creator supplies the tokens</strong>
              <p className="note">
                All of them, in one transaction. The whole supply goes to the curve and
                nothing can mint more afterwards, because the launch hands away the
                denom&rsquo;s entire issuance at creation.
              </p>
            </div>
          </li>
          <li>
            <span className="step-n">2</span>
            <div>
              <strong>Buyers bring {q}, and the curve sets the price</strong>
              <p className="note">
                There is no order book and no market maker. Each purchase moves along a
                fixed curve the creator chose and cannot edit, so the price of the next
                token is arithmetic rather than a quote from anyone.
              </p>
            </div>
          </li>
          <li>
            <span className="step-n">3</span>
            <div>
              <strong>It graduates to a locked pool</strong>
              <p className="note">
                The buy that reaches the target seeds a pool with the {q} the curve
                collected and the tokens held back, in the same transaction. The pool
                lives in the launch&rsquo;s own contract, which has no withdraw function
                and no upgrade key, so that liquidity can never be pulled. Trading
                continues there, and the launch rules below stop applying.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section className="explain" aria-labelledby="guarantees-heading">
        <h2 id="guarantees-heading">What the contract enforces</h2>
        <p className="note">
          Each of these is checked on chain on every trade. None of them is a policy an
          operator could change without deploying a different contract.
        </p>
        <div className="guarantees">
          <div>
            <strong>Nothing is held for you</strong>
            <p className="note">
              The curve holds the reserve that backs sells and nothing else. Fees accrue
              separately and are claimed by whoever earned them; no contract here takes
              custody of a trade in flight.
            </p>
          </div>
          <div>
            <strong>Supply is fixed at creation</strong>
            <p className="note">
              The whole issuance is minted once and handed over. There is no mint
              function left to call and no admin who could add to it later.
            </p>
          </div>
          <div>
            <strong>An opening fee with no exemptions</strong>
            <p className="note">
              A creator can make the first minutes expensive, up to {MAX_EARLY_FEE_PCT}%,
              decaying to the curve&rsquo;s own fee. No wallet can be exempted, including
              the creator&rsquo;s, and the extra goes into the pool at graduation rather
              than to anyone.
            </p>
          </div>
          <div>
            <strong>Caps and start times, or neither</strong>
            <p className="note">
              A launch can limit what one address takes from the curve and can open at a
              set time. Both are optional, both are shown on the launch, and a cap that
              could never bind is refused rather than displayed as protection.
            </p>
          </div>
          <div>
            <strong>The creator&rsquo;s position is published</strong>
            <p className="note">
              Every launch page shows what the creator still holds at their launch
              address, and how much of the supply was taken in the opening blocks. Both
              are read from the chain, not reported by the creator.
            </p>
          </div>
          <div>
            <strong>Every cost is named before you sign</strong>
            <p className="note">
              The trading fee, the opening fee if one is running, the price impact of
              your own order and the minimum you will receive, all quoted from the same
              arithmetic the contract runs.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
