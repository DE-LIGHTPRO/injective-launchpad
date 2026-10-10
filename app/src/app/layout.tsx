import { BrandMark } from '@/components/BrandMark';
import type { Metadata } from 'next';
import Link from 'next/link';
import { NETWORK } from '@/lib/config';
import { isDemoMode } from '@/lib/demo';
import { ConnectWallet } from '@/components/ConnectWallet';
import './globals.css';

export const metadata: Metadata = {
  title: 'Injective Launchpad',
  description: 'One-sided bonding curve launches on Injective.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="wrap inner">
            <Link href="/" className="brand">
              <BrandMark />
              <span>
                inj<em>·</em>pad
              </span>
            </Link>
            <Link href="/create" className="nav-create">
              Create
            </Link>
            <span className="spacer" />
            {isDemoMode() && <span className="chip warn">demo</span>}
            <span className="chip">{NETWORK.name}</span>
            {/*
                The wallet sits in the header because it is page-independent: a
                connection made on a launch page is the same connection on the
                create form, and asking for it twice is how people end up with two
                accounts connected and no idea which one is about to sign.
              */}
            <ConnectWallet />
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer className="wrap" style={{ padding: 'var(--space-8) var(--space-5)' }}>
          <p className="micro">
            {/*
                No ticker. This is the site footer, under every launch including ones
                priced in something else, and "buyers bring INJ" stopped being true the
                day a second quote was allowlisted. The pair is on each card and each
                launch page, which is where it belongs.
              */}
            Bonding curve launches. The creator supplies the tokens; buyers bring
            whatever the pair is priced in.
          </p>
        </footer>
      </body>
    </html>
  );
}
