import { BrandMark } from '@/components/BrandMark';
import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { Inter, JetBrains_Mono, Space_Grotesk } from 'next/font/google';
import { NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { ConnectWallet } from '@/components/ConnectWallet';
import './globals.css';

/*
 * Three faces, each with one job.
 *
 * The site used the platform's system stack and its system monospace for every
 * number, so prices looked like a terminal and headings looked like a settings page.
 * Space Grotesk carries the display weight (headings, headline figures), Inter carries
 * reading, and JetBrains Mono is kept for the things that genuinely are code: addresses
 * and denoms.
 *
 * `next/font` downloads them at BUILD time and serves them from this origin, so a
 * visitor's browser never contacts Google, the CSP can stay `font-src 'self'`, and there
 * is no layout shift while a web font swaps in.
 */
const display = Space_Grotesk({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'https://injpad.vercel.app';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'inj·pad · Fair launches on Injective', template: '%s · inj·pad' },
  description:
    'Launch a token on Injective with a fixed supply, a bonding curve, and liquidity that locks itself at graduation. No presale, no team allocation, no mint key.',
  openGraph: {
    type: 'website',
    siteName: 'inj·pad',
    title: 'inj·pad · Fair launches on Injective',
    description:
      'Fixed supply, one curve for everyone, and liquidity that locks itself at graduation.',
  },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = {
  themeColor: '#05070d',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="top">
          <div className="wrap inner">
            <Link href="/" className="brand" aria-label="inj·pad home">
              <BrandMark />
              <span className="wordmark">
                inj<em>·</em>pad
              </span>
            </Link>
            <nav className="top-nav" aria-label="Primary">
              <Link href="/">Launches</Link>
              <Link href="/watchlist">Watchlist</Link>
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
              <span aria-hidden="true">+</span> Create
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
                <BrandMark size={18} />
                <span className="wordmark">
                  inj<em>·</em>pad
                </span>
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
