import { NETWORK } from '@/lib/config';
import { MAX_EARLY_FEE_BPS } from '@/lib/launchRules';
import { StepCreate, StepTrade, StepGraduate } from './StepArt';
import Image from 'next/image';
import { CheckIcon } from './Icons';

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
            {/*
                THE NUMBER BECAME A WORD, AND GAINED A PICTURE. `1` in a badge is an
                ordinal and nothing else; "STEP ONE" above a drawing of the step reads
                as a stage in a process, which is what this list is. The art is a
                diagram rather than decoration - see `StepArt` on why each shape is the
                shape it is - so it carries meaning rather than filling space.
              */}
            <StepCreate />
            <span className="step-n">Step one</span>
            <div>
              <strong>Create</strong>
              <p className="note">
                The creator mints a fixed 1B supply and hands all of it, and the mint key,
                to the launch contract.
              </p>
            </div>
          </li>
          <li>
            <StepTrade />
            <span className="step-n">Step two</span>
            <div>
              <strong>Trade on the curve</strong>
              <p className="note">
                Buyers pay {q}. A fixed bonding curve sets every price; there is no order
                book and no market maker.
              </p>
            </div>
          </li>
          <li>
            <StepGraduate />
            <span className="step-n">Step three</span>
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
        {/*
            ART BESIDE THE LIST, NOT ABOVE IT. Six cards in an auto-fit grid read as six
            equal cards and nothing more. These six are the product's argument - the
            reasons to use this pad rather than one that can pull liquidity - so they get
            the weight of a panel with a subject beside them.

            A closed ring, because that is what the list is about: liquidity with no way
            out of it. Decorative and `aria-hidden`, since all six claims are already
            stated in words beside it.
          */}
        <div className="guarantees-panel">
          <div className="guarantees-art">
            <Image
              src="/locked-ring.png"
              alt=""
              aria-hidden="true"
              width={520}
              height={520}
              sizes="(max-width: 900px) 70vw, 32vw"
            />
          </div>
          <div className="guarantees">
          <div>
            <strong>
              <CheckIcon size={15} />
              Non-custodial</strong>
            <p className="note">Reserves back the token. Fees are held apart and paid only to who earned them.</p>
          </div>
          <div>
            <strong>
              <CheckIcon size={15} />
              Fixed supply</strong>
            <p className="note">The mint key ends with the launch contract, which cannot mint.</p>
          </div>
          <div>
            <strong>
              <CheckIcon size={15} />
              Locked liquidity</strong>
            <p className="note">Graduated liquidity has no withdrawal path, for anyone.</p>
          </div>
          <div>
            <strong>
              <CheckIcon size={15} />
              Anti-sniping</strong>
            <p className="note">
              Optional opening fee up to {MAX_EARLY_FEE_BPS / 100}%, wallet caps and start times. No
              exemptions, including the creator.
            </p>
          </div>
          <div>
            <strong>
              <CheckIcon size={15} />
              Same terms for all</strong>
            <p className="note">One supply, one curve and one fee split on every launch.</p>
          </div>
          <div>
            <strong>
              <CheckIcon size={15} />
              Costs shown up front</strong>
            <p className="note">Fee, price impact and minimum received are quoted before you sign.</p>
          </div>
        </div>
        </div>
      </section>
    </>
  );
}
