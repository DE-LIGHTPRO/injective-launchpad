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
        <h2 id="how-heading" className="sr-only">
          How a launch works
        </h2>
        <ol className="steps">
          <li>
            <span className="step-n">1</span>
            <div>
              <strong>Create</strong>
              <p className="note">
                The creator mints a fixed 1B supply and hands all of it, and the mint key,
                to the launch contract.
              </p>
            </div>
          </li>
          <li>
            <span className="step-n">2</span>
            <div>
              <strong>Trade on the curve</strong>
              <p className="note">
                Buyers pay {q}. A fixed bonding curve sets every price; there is no order
                book and no market maker.
              </p>
            </div>
          </li>
          <li>
            <span className="step-n">3</span>
            <div>
              <strong>Graduate</strong>
              <p className="note">
                At the target, the reserve seeds a pool inside the same contract. It has no
                withdraw function and no upgrade key.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section className="explain" aria-labelledby="guarantees-heading">
        <h2 id="guarantees-heading">Enforced by the contract</h2>
        <div className="guarantees">
          <div>
            <strong>Non-custodial</strong>
            <p className="note">Reserves back the token. Fees are held apart and paid only to who earned them.</p>
          </div>
          <div>
            <strong>Fixed supply</strong>
            <p className="note">The mint key ends with the launch contract, which cannot mint.</p>
          </div>
          <div>
            <strong>Locked liquidity</strong>
            <p className="note">Graduated liquidity has no withdrawal path, for anyone.</p>
          </div>
          <div>
            <strong>Anti-sniping</strong>
            <p className="note">
              Optional opening fee up to {MAX_EARLY_FEE_PCT}%, wallet caps and start times. No
              exemptions, including the creator.
            </p>
          </div>
          <div>
            <strong>Same terms for all</strong>
            <p className="note">One supply, one curve and one fee split on every launch.</p>
          </div>
          <div>
            <strong>Costs shown up front</strong>
            <p className="note">Fee, price impact and minimum received are quoted before you sign.</p>
          </div>
        </div>
      </section>
    </>
  );
}
