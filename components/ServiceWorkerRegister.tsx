'use client';

import { useEffect } from 'react';
import { captureInstallPrompt } from '@/lib/installPrompt';

/**
 * Registers the pass-through service worker so the app can be installed as a
 * PWA. Renders nothing. The worker itself caches nothing (see public/sw.js),
 * so this does not add offline support — it only unlocks installability.
 *
 * It also parks the browser's `beforeinstallprompt` event for the Settings
 * "Install as an app" button (lib/installPrompt.ts): the event fires once,
 * early, so the listener has to live here in the root layout rather than in
 * the panel that gets opened later.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    captureInstallPrompt();

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        // Non-fatal: the app works fine without the worker, it just may not
        // show the install prompt on some browsers.
        console.error('Service worker registration failed:', err);
      });
    };

    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
      return () => window.removeEventListener('load', register);
    }
  }, []);

  return null;
}
