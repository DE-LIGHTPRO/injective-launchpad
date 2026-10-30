import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND_NAME } from '@/lib/brand';
import { NETWORK } from '@/lib/config';
import {
  CREATOR_FEE_SHARE_BPS,
  PLATFORM_FEE_SHARE_BPS,
  MAX_FEE_BPS,
  FIXED_TOTAL_SUPPLY_TOKENS,
  CURVE_SUPPLY_TOKENS,
  LP_RESERVE_TOKENS,
} from '@/lib/launchLimits';
import { FORM_MAX_EARLY_FEE_BPS, MAX_EARLY_FEE_BPS } from '@/lib/launchRules';

export const metadata: Metadata = {
  title: 'Risks',
  description:
    'What this launchpad guarantees, what it does not, and how you can lose money here.',
};

/**
 * What can go wrong, said by the people who built it.
 *
 * WHY THIS IS NOT A TERMS PAGE. Terms need an entity and a jurisdiction to say
 * anything true, and this product has neither yet; a page of legal-sounding text
 * naming nobody is worse than no page, because it implies a company stands behind
 * it. See `docs/LEGAL-DRAFTS.md`. What CAN be written honestly today is the
 * mechanical truth: what the contracts enforce, what they cannot, and which of the
 * usual protections are simply absent here.
 *
 * EVERY CLAIM ON THIS PAGE IS ONE THE CONTRACTS ACTUALLY MAKE, and the figures come
 * from the same constants the contracts are built from rather than being typed out
 * again. The whole value of a risk page is that it is not marketing; a page that
 * overstates the protections is worse than silence, because somebody will rely on it.
 */
export default function RisksPage() {
  return (
    <>
      <h1>Risks</h1>
      <p className="sub">
        What this launchpad enforces, what it cannot, and how you can lose money here.
      </p>

      {/*
          THE WARNING LOOKS LIKE A WARNING NOW. This was `className="card"`, identical
          to "Costs" and "What the contracts do enforce" below it, so the most important
          sentence in the product was styled exactly like the least. On a page whose
          whole job is to say you can lose your money, every section carrying equal
          visual weight means none of them carries any.
        */}
      <div className="card card-warning" style={{ marginTop: 'var(--space-5)' }}>
        <h2>You can lose everything you put in</h2>
        <p className="note">
          A token launched here has no business behind it, no revenue, and no promise
          from anybody. Its price is set entirely by what people pay on a curve. Most
          launches on every launchpad like this one end up worth very little, and that
          is the normal outcome rather than the exceptional one. Spend only what you
          can lose completely.
        </p>
        <p className="note">
          Nothing here is investment advice, and nobody involved in this site is
          advising you.
        </p>
      </div>

      <div className="card" style={{ marginTop: 'var(--space-4)' }}>
        <h2>What the contracts do enforce</h2>
        <p className="note">
          These are properties of the code, verifiable on chain, and they hold whatever
          anybody says:
        </p>
        <ul className="risk-list">
          <li>
            <strong>The supply is fixed.</strong> Exactly{' '}
            {FIXED_TOTAL_SUPPLY_TOKENS.toLocaleString('en-US')} tokens are minted at
            creation and the right to mint passes to the launch contract, which has no
            code that mints. Nobody can create more, including us.
          </li>
          <li>
            <strong>The launch contract cannot be changed.</strong> Each launch is
            deployed with no upgrade key, so the code holding the reserve is the code
            it was created with, permanently.
          </li>
          <li>
            <strong>Liquidity locks at graduation.</strong>{' '}
            {CURVE_SUPPLY_TOKENS.toLocaleString('en-US')} tokens sell on the curve and{' '}
            {LP_RESERVE_TOKENS.toLocaleString('en-US')} are held back to pair with the
            raised amount in a pool inside the same contract. That pool has no
            withdrawal path, for anyone.
          </li>
          <li>
            <strong>The fee split is fixed at creation.</strong> A creator sets the
            launch&rsquo;s own fee rate, capped at {MAX_FEE_BPS / 100}% per side, and{' '}
            {CREATOR_FEE_SHARE_BPS / 100}% of it is the creator&rsquo;s while{' '}
            {PLATFORM_FEE_SHARE_BPS / 100}% runs this launchpad. Neither share can be
            changed afterwards.
          </li>
          <li>
            <strong>
              An opening fee can reach {MAX_EARLY_FEE_BPS / 100}%, and it is the highest
              a buy can ever pay.
            </strong>{' '}
            A launch may start with a fee above its own rate, falling to that rate over a
            window it fixes at creation. That ceiling is deliberately double the{' '}
            {MAX_FEE_BPS / 100}% cap on the base rate, so being first is not free. Every
            wallet pays it, including the creator&rsquo;s. It applies to sells as well as
            buys, so leaving during the opening window costs more too. On a buy the
            amount above the base rate goes into the pool at graduation rather than to the
            creator or to us; on a sell the whole fee is split like any other. The launch
            page quotes the fee in force at the moment you trade. Launches created here
            are capped at {FORM_MAX_EARLY_FEE_BPS / 100}%, which is the most the deployed
            curve can price.
          </li>
          <li>
            <strong>The launchpad never holds your funds.</strong> Trades settle
            against the launch contract directly. The factory forwards everything it
            touches within the same transaction.
          </li>
        </ul>
      </div>

      <div className="card" style={{ marginTop: 'var(--space-4)' }}>
        <h2>What it does not, and cannot</h2>
        <ul className="risk-list">
          <li>
            <strong>The contracts have not been audited by a third party.</strong> They
            have been reviewed internally and tested extensively, and that is not the
            same thing and should not be read as the same thing. A bug in them could
            cost you everything in a launch.
          </li>
          <li>
            <strong>A creator can sell.</strong> Creators can buy their own launch at
            the opening price and sell it back at any time. The opening buy is capped
            and shown on the launch page, and their position is reported where it can
            be read, but nothing stops them selling.
          </li>
          <li>
            <strong>Holdings cannot be fully seen.</strong> Injective does not provide
            a holder list for this kind of token, so the launch page reports the
            creator&rsquo;s position at the launching address only. Anybody can hold
            more in other wallets, and that is invisible here.
          </li>
          <li>
            <strong>Anti-sniping rules raise the cost, they do not prevent it.</strong>{' '}
            A wallet cap applies per address, and one person with twenty addresses gets
            twenty times the cap. No on-chain rule fixes that.
          </li>
          <li>
            <strong>Nobody is screening the tokens.</strong> Anyone can launch anything
            with any name, image or description. A token using a familiar name has no
            connection to whatever it resembles. Read the contract address, not the
            ticker.
          </li>
          <li>
            <strong>Graduation is not an endorsement.</strong> It means the curve
            reached its target. It says nothing about whether the token is worth
            anything afterwards.
          </li>
        </ul>
      </div>

      <div className="card" style={{ marginTop: 'var(--space-4)' }}>
        <h2>Costs</h2>
        <p className="note">
          Creating a launch costs Injective&rsquo;s own one-off charge for a new token
          plus network gas, and a launchpad fee where one is configured. The create
          form itemises all of them before you sign, and refuses rather than letting
          you sign something your wallet cannot pay for.
        </p>
        <p className="note">
          Every trade pays the launch&rsquo;s own fee, shown on its page and quoted
          before you sign. Your own trade moves the price on a bonding curve, which is
          why the quote shows price impact: a large buy fills above the spot price by
          design, not by error.
        </p>
      </div>

      <div className="card" style={{ marginTop: 'var(--space-4)' }}>
        <h2>This is {NETWORK.label}</h2>
        {/*
            `realFunds`, NOT A NAME TEST, and this is the sentence that made the field
            necessary. `NETWORK.name === 'mainnet'` is false on the EVM deployment -
            which is Injective mainnet, chain 1776, holding real INJ - so this page told
            a user with money on the line that their balances were test assets with no
            value and the chain could be reset. On the one page whose entire job is to
            state the risk, as far understated as it can be stated.
          */}
        <p className="note">
          {NETWORK.realFunds
            ? 'Launches here involve real funds on Injective mainnet.'
            : 'This deployment runs on Injective testnet. Tokens and balances here are test assets with no value, and the chain can be reset.'}
        </p>
        <p className="note" style={{ marginTop: 'var(--space-4)' }}>
          <Link href="/">Back to launches</Link>
        </p>
      </div>
    </>
  );
}
