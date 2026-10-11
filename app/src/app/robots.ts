import type { MetadataRoute } from 'next';
import { isDemoMode } from '@/lib/demo';

/**
 * Keep a demo out of search results, and emit the rule rather than describing it.
 *
 * While `NEXT_PUBLIC_DEMO` is set, every launch on the site is generated locally from
 * the curve maths and no contract is deployed. The banner says so to anyone who opens
 * the page, but a search result has no banner: someone finding the site through a
 * query would land on prices that nothing backs, with the explanation one scroll above
 * wherever the snippet cut off.
 *
 * Derived from the SAME variable that puts the banner there, deliberately. A sibling
 * project shipped HTML carrying the comment "keep out of search indexes until the
 * launch review clears" with no robots tag under it and a 404 at /robots.txt, and an
 * external reviewer reported an intent nobody had implemented. Two signals a crawler
 * reads must not be able to disagree, and the only way to guarantee that is for one
 * value to produce both.
 */
export default function robots(): MetadataRoute.Robots {
  if (isDemoMode()) {
    return { rules: { userAgent: '*', disallow: '/' } };
  }
  return { rules: { userAgent: '*', allow: '/' } };
}
