import type { MetadataRoute } from 'next';
import { appName } from '@/lib/pwa';

export default function manifest(): MetadataRoute.Manifest {
  // Preview deployments install as "Toggl Quick View (beta)" — they live on a
  // stable host of their own (beta.track.zicha.dev), so a preview install can
  // sit next to the production one on the same home screen. See lib/pwa.ts.
  const { name, shortName } = appName(process.env.VERCEL_ENV);
  return {
    // Fixed identity, so reinstalling after a deploy updates the existing app
    // instead of adding a second one.
    id: '/',
    name,
    short_name: shortName,
    description:
      'Single-screen quick view for tracking your work day on one or more Toggl Track projects.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0d1117',
    theme_color: '#0d1117',
    orientation: 'any',
    categories: ['productivity', 'business'],
    icons: [
      {
        src: '/icon.svg',
        type: 'image/svg+xml',
        sizes: 'any',
        purpose: 'any',
      },
      {
        src: '/icons/icon-192.png',
        type: 'image/png',
        sizes: '192x192',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        type: 'image/png',
        sizes: '512x512',
        purpose: 'any',
      },
      {
        src: '/icons/maskable-192.png',
        type: 'image/png',
        sizes: '192x192',
        purpose: 'maskable',
      },
      {
        src: '/icons/maskable-512.png',
        type: 'image/png',
        sizes: '512x512',
        purpose: 'maskable',
      },
    ],
  };
}
