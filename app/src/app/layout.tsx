import { BrandMark } from '@/components/BrandMark';
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { PlusIcon } from '@/components/Icons';
import { BRAND_NAME, BRAND_TAGLINE } from '@/lib/brand';
import { NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { ConnectWallet } from '@/components/ConnectWallet';
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

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'https://injpad.vercel.app';

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
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
            <nav className="top-nav" aria-label="Primary">
              <Link href="/">Launches</Link>
              <Link href="/watchlist">Watchlist</Link>
              <Link href="/portfolio">Portfolio</Link>
              <Link href="/claim">Claim</Link>
            </nav>
            <span className="spacer" />
            {/*
                Hidden below 640px. On a phone these two chips pushed the wallet button
                off the right edge, so a phone user could not connect at all; the demo
                banner and the network line in the footer still say both things.
              */}
            {isDemoMode() && <span className="chip warn hide-sm">demo</span>}
            <span className="chip hide-sm">{NETWORK.name}</span>
            <Link href="/create" className="nav-create">
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
              <Link href="/">Launches</Link>
              <Link href="/create">Create a launch</Link>
              <Link href="/watchlist">Watchlist</Link>
              <Link href="/portfolio">Portfolio</Link>
              <Link href="/claim">Claim</Link>
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
