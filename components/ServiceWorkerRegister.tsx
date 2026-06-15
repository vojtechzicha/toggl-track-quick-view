'use client';

import { useEffect } from 'react';

/**
 * Registers the pass-through service worker so the app can be installed as a
 * PWA. Renders nothing. The worker itself caches nothing (see public/sw.js),
 * so this does not add offline support — it only unlocks installability.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

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
