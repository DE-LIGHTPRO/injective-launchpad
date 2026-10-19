import { BrandMark } from '@/components/BrandMark';
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { PlusIcon } from '@/components/Icons';
import { SITE_URL, BRAND_NAME, BRAND_TAGLINE } from '@/lib/brand';
import { NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { ConnectWallet } from '@/components/ConnectWallet';
import { MobileNav } from '@/components/MobileNav';
import { ChainMismatchBanner } from '@/components/ChainMismatchBanner';
import { PrimaryNav } from '@/components/PrimaryNav';
import { CREATE_NAV, FOOTER_NAV } from '@/lib/navItems';
import './globals.css';

/*
 * Two faces. Inter for everything a person reads, with tabular figures for numbers;
 * JetBrains Mono only for strings a person might copy (addresses, denoms). A separate
 * display face was tried and dropped: one well-set family reads as more considered
 * than two competing ones.
 *
 * `next/font` downloads them at BUILD time and serves them from this origin, so a
 * visitor's browser never contacts Google, the CSP can stay `font-src 'self'`, and there
 * is no layout shift while a web font swaps in.
 */
const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });



export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${BRAND_NAME} · ${BRAND_TAGLINE}`, template: `%s · ${BRAND_NAME}` },
  description:
    'Launch a token on Injective with a fixed supply, a bonding curve, and liquidity that locks itself at graduation. No presale, no team allocation, no mint key.',
  openGraph: {
    type: 'website',
    siteName: BRAND_NAME,
    title: `${BRAND_NAME} · ${BRAND_TAGLINE}`,
    description:
      'Fixed supply, one curve for everyone, and liquidity that locks itself at graduation.',
  },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = {
  themeColor: '#0a0b0d',
  colorScheme: 'dark',
};

/**
 * `data-scroll-behavior` is not decoration. `globals.css` sets
 * `html { scroll-behavior: smooth }` for in-page anchors, and today Next
 * temporarily forces `auto` during a route change so a navigation does not
 * animate-scroll the page. In v16 that stops being automatic: without this
 * attribute the forcing is skipped entirely and every route change smooth
 * scrolls the whole board. Read out of `disable-smooth-scroll.js`, which falls
 * through to the same style manipulation whether or not the attribute is set -
 * so this changes nothing today and keeps the current behaviour after the
 * upgrade, which is the opposite of what the warning's wording suggests.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="top">
          <div className="wrap inner">
            <Link href="/" className="brand" aria-label={`${BRAND_NAME} home`}>
              <BrandMark size={26} id="hdr" />
              <span className="wordmark">{BRAND_NAME}</span>
            </Link>
            {/*
                One list, three navigations. This nav, the phone menu beside it and the
                footer nav were three hand-written copies of the same six links; see
                `navItems.ts` for why that is the shape of defect that ships.

                It is its own component because marking the current page needs
                `usePathname`, and this layout is a server component. The links still
                come from `PRIMARY_NAV`.
              */}
            <PrimaryNav />
            {/*
                The same destinations on a phone, where the nav above is `display: none`.
                Before this there was nothing in its place: the six destinations were
                reachable only from the footer, and `display: none` takes the nav out of
                the accessibility tree too, so a screen-reader user had no primary nav at
                all. It hides itself above 720px, which is where `.top-nav` appears.
              */}
            <MobileNav />
            <span className="spacer" />
            {/*
                Hidden below 640px. On a phone these two chips pushed the wallet button
                off the right edge, so a phone user could not connect at all; the demo
                banner and the network line in the footer still say both things.
              */}
            {isDemoMode() && <span className="chip warn hide-sm">demo</span>}
            <span className="chip hide-sm">{NETWORK.name}</span>
            {/* The destination comes from the same place the footer's reads it from; the
                label is shorter here because the header has a button's worth of room. */}
            <Link href={CREATE_NAV.href} className="nav-create">
              <PlusIcon size={14} /> Create
            </Link>
            {/*
                The wallet sits in the header because it is page-independent: a
                connection made on a launch page is the same connection on the
                create form, and asking for it twice is how people end up with two
                accounts connected and no idea which one is about to sign.
              */}
            <ConnectWallet />
          </div>
        </header>
        <main id="main" className="wrap">
          {/*
              Here rather than per page, and above the content rather than in the header,
              because the claim it makes is about everything below it: when the endpoint
              being read is not the chain being signed for, every launch, balance and
              price on the page is the other chain's. A page added later would not know
              to ask. It renders nothing unless the probe came back and disagreed.
            */}
          <ChainMismatchBanner />
          {children}
        </main>
        <footer className="site-footer">
          <div className="wrap footer-inner">
            <div>
              <Link href="/" className="brand">
                <BrandMark size={20} id="ftr" />
                <span className="wordmark">{BRAND_NAME}</span>
              </Link>
              <p className="micro" style={{ marginTop: 'var(--space-2)', maxWidth: '44ch' }}>
                {/*
                    No ticker. This is the site footer, under every launch including ones
                    priced in something else.
                  */}
                Fixed supply, one curve for everyone, liquidity that locks itself. The
                creator supplies the tokens; buyers bring whatever the pair is priced in.
              </p>
            </div>
            <nav className="footer-nav" aria-label="Footer">
              {FOOTER_NAV.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
              <a href={NETWORK.explorer} target="_blank" rel="noopener noreferrer">
                Injective {NETWORK.name} explorer
              </a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
