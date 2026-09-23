import type { Metadata, Viewport } from 'next';
import './globals.css';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';
import UpdateHint from '@/components/UpdateHint';
import { appName } from '@/lib/pwa';

// Must match app/manifest.ts: iOS takes the home-screen title from the Apple
// meta tag, not the manifest.
const { name: APP_NAME, shortName: APP_SHORT_NAME } = appName(process.env.VERCEL_ENV);

export const metadata: Metadata = {
  applicationName: APP_NAME,
  title: 'Toggl Quick View',
  description:
    'Single-screen quick view for tracking your work day on one or more Toggl Track projects.',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: APP_SHORT_NAME,
    statusBarStyle: 'black-translucent',
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#0d1117',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorkerRegister />
        <UpdateHint />
      </body>
    </html>
  );
}
