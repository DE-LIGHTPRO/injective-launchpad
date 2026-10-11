import type { NextConfig } from 'next';

/*
 * Security headers. There was no next.config at all, so the site sent none: no CSP,
 * nothing stopping it being framed, no HSTS. For a page that asks a wallet to sign, framing
 * is the one that matters most: a hostile page can overlay this one inside an iframe and
 * steer clicks onto "Create" or "Buy" (clickjacking). `frame-ancestors 'none'` and
 * `X-Frame-Options: DENY` close that.
 *
 * The CSP lists exactly where the browser talks to:
 *   - this origin (pages, the /api/upload route, self-hosted fonts from next/font);
 *   - Injective's own endpoints for chain reads and broadcast, plus the LCD override when
 *     an operator set one (`NEXT_PUBLIC_LCD_URL`);
 *   - images from any https origin, because token logos are creator-supplied URLs (they
 *     are scheme-allowlisted and loaded with no-referrer in TokenLogo).
 * Wallet extensions are not affected: their content scripts are outside the page's CSP.
 *
 * `'unsafe-inline'` for scripts is required by the App Router's inline bootstrap without
 * a nonce middleware; it is the remaining gap, listed in docs/AUDIT.md.
 */
const isDev = process.env.NODE_ENV !== 'production';

function lcdOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_LCD_URL?.trim();
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  `connect-src 'self' https://*.injective.network ${lcdOrigin()}${isDev ? ' ws:' : ''}`.trim(),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  // Production only: on http://localhost it would rewrite the dev server's own requests.
  ...(isDev ? [] : ['upgrade-insecure-requests']),
].join('; ');

const config: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default config;
