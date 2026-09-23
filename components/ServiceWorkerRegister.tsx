'use client';

import { useEffect } from 'react';
import { captureInstallPrompt } from '@/lib/installPrompt';

/**
 * Registers the pass-through service worker (public/sw.js), which makes the
 * app installable. No offline support.
 *
 * Also starts capturing `beforeinstallprompt` (lib/installPrompt.ts). The
 * event fires once, early, so the listener must live in the root layout.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    captureInstallPrompt();

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        // Non-fatal: without the worker some browsers won't offer install
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
