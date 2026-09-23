'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { appName, manualInstallGuide, type ManualInstallGuide } from '@/lib/pwa';
import {
  consumeInstallPrompt,
  getInstallPrompt,
  getServerInstallPrompt,
  subscribeInstallPrompt,
} from '@/lib/installPrompt';
import InstallGuideSheet from '@/components/InstallGuideSheet';

/**
 * "Install as an app" block at the bottom of Settings. On Chromium the button
 * replays the parked `beforeinstallprompt` (lib/installPrompt.ts); on WebKit
 * it opens InstallGuideSheet. `manualInstallGuide` (lib/pwa.ts) decides which
 * guide, if any. Renders nothing where neither applies, including inside the
 * installed app.
 */

/** The platform's "standalone display mode" (see lib/pwa.ts for the naming). */
function runningInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

const APP_NAME = appName(process.env.NEXT_PUBLIC_VERCEL_ENV).name;

export default function InstallAppBlock() {
  const installEvent = useSyncExternalStore(
    subscribeInstallPrompt,
    getInstallPrompt,
    getServerInstallPrompt
  );
  const [guide, setGuide] = useState<ManualInstallGuide | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    // Client-only; a captured beforeinstallprompt takes precedence
    setGuide(
      manualInstallGuide({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
        installed: runningInstalled(),
      })
    );
  }, []);

  const closeGuide = useCallback(() => setGuideOpen(false), []);

  if (!installEvent && !guide) return null;

  return (
    <div className="field install-app">
      <label>Install as an app</label>
      <div className="row" style={{ justifyContent: 'flex-start' }}>
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (!installEvent) {
              setGuideOpen(true);
              return;
            }
            // An event can be prompted once (see lib/installPrompt.ts)
            const event = consumeInstallPrompt();
            if (event) void event.prompt().catch(() => {});
          }}
        >
          {installEvent
            ? 'Install app…'
            : guide === 'mac-safari'
              ? 'How to add it to your Dock…'
              : 'How to add it to your home screen…'}
        </button>
      </div>
      <p className="hint">
        Open {APP_NAME} from its own icon, in its own window. No app store needed.
      </p>
      {guideOpen && guide && (
        <InstallGuideSheet guide={guide} appName={APP_NAME} onClose={closeGuide} />
      )}
    </div>
  );
}
