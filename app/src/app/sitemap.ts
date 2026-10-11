import type { MetadataRoute } from 'next';
import { isDemoMode } from '@/lib/demo';
import { listLaunches } from '@/lib/chain';
import { launchPath } from '@/lib/launchPath';

import { SITE_URL as SITE } from '@/lib/brand';

/**
 * Every launch page, so a token can be found by name. Empty in demo mode, for the same
 * reason robots.ts disallows everything there: demo prices are not market prices.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (isDemoMode()) return [];
  const base: MetadataRoute.Sitemap = [
    { url: `${SITE}/`, changeFrequency: 'hourly', priority: 1 },
    { url: `${SITE}/create`, changeFrequency: 'monthly', priority: 0.6 },
  ];
  try {
    const launches = await listLaunches(100);
    return [
      ...base,
      /*
       * The canonical slug, resolved against the same list, so the sitemap submits
       * the URL the page serves rather than the numeric form it redirects away from.
       * A sitemap full of redirects is a sitemap a crawler discounts.
       */
      ...launches.map((l) => ({
        url: `${SITE}${launchPath(l, launches)}`,
        changeFrequency: 'hourly' as const,
        priority: 0.8,
      })),
    ];
  } catch {
    return base;
  }
}
