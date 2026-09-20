'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { appName, manualInstallGuide, type ManualInstallGuide } from '@/lib/pwa';
import {
  getInstallPrompt,
  getServerInstallPrompt,
  subscribeInstallPrompt,
} from '@/lib/installPrompt';
import InstallGuideSheet from '@/components/InstallGuideSheet';

/**
 * "Install as an app" block at the bottom of Settings. Two ways in, one
 * button:
 *
 * - Chromium fires `beforeinstallprompt`; lib/installPrompt.ts parks the event
 *   from page load and the click replays it as the native install dialog.
 * - WebKit never fires it (iPhone/iPad in any browser, Safari on the Mac), so
 *   there the click opens InstallGuideSheet, a walkthrough of the Share →
 *   "Add to Home Screen" / File → "Add to Dock" route. Which one, and whether
 *   at all, is `manualInstallGuide` (lib/pwa.ts).
 *
 * Renders nothing anywhere else, and never inside the installed app. It sits
 * in Settings rather than the footer because Settings is the one surface all
 * three pages share (see components/AppSettings.tsx), and because the other
 * per-device knob, the refresh interval, already lives there.
 */

/** Running as the installed app — the platform's "standalone display mode",
 *  named differently here because "standalone" is the no-Toggl mode in this
 *  app (see lib/pwa.ts). */
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
    // Client-only sniff: decided once per mount, and a captured
    // beforeinstallprompt simply takes precedence
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
            if (installEvent) void installEvent.prompt().catch(() => {});
            else setGuideOpen(true);
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
        {APP_NAME} opens from its own icon, in its own window, without the browser around it.
        Same live data, no app store.
      </p>
      {guideOpen && guide && (
        <InstallGuideSheet guide={guide} appName={APP_NAME} onClose={closeGuide} />
      )}
    </div>
  );
}
