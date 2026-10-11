import type { MetadataRoute } from 'next';
import { isDemoMode } from '@/lib/demo';
import { listLaunches } from '@/lib/chain';

const SITE = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'https://injpad.vercel.app';

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
      ...launches.map((l) => ({ url: `${SITE}/launch/${l.id}`, changeFrequency: 'hourly' as const, priority: 0.8 })),
    ];
  } catch {
    return base;
  }
}
