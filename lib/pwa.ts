/**
 * Which install route the Settings "Install as an app" button offers.
 *
 * Chromium fires `beforeinstallprompt` and the button replays it. WebKit
 * (every browser on iPhone/iPad, Safari on the Mac) never fires it, so the
 * button opens a walkthrough instead:
 *
 * - `ios`: Share → "Add to Home Screen". Safari always had it; other iOS
 *   browsers since 16.4. iPadOS Safari reports a Mac user agent, so a
 *   touch-capable "Macintosh" counts as iPadOS.
 * - `ios-safari-needed`: the same, after "open this page in Safari". For
 *   third-party browsers before iOS 16.4 (or with the version hidden, as in
 *   iPad desktop mode) and for in-app browsers (no `Safari/` token), which
 *   never offer it.
 * - `mac-safari`: File → "Add to Dock", Safari 17+. It also needs macOS
 *   Sonoma, which the UA cannot show (Safari reports "Mac OS X 10_15_7" on
 *   every macOS since Catalina), so the sheet states the requirement.
 *   Older Safari has no install; Chromium on the Mac takes the native path.
 *
 * Returns null inside the installed app. The platform calls that "standalone
 * display mode"; here it is `installed`, because "standalone" already means
 * the no-Toggl store mode (lib/source).
 *
 * Pure, so `pnpm check:pwa` can test it against real user-agent strings.
 */

export type ManualInstallGuide = 'ios' | 'ios-safari-needed' | 'mac-safari';

export interface InstallEnvironment {
  userAgent: string;
  /** navigator.maxTouchPoints — tells iPadOS apart from a real Mac. */
  maxTouchPoints?: number;
  /** Already running as the installed app (display-mode: standalone). */
  installed: boolean;
}

/** Browser vendor tokens that mean "WebKit, but not Safari itself". */
const NON_SAFARI_BROWSERS = /Chrome|Chromium|CriOS|Edg|OPR|OPT|Firefox|FxiOS|DuckDuckGo/i;

/** iOS/iPadOS version from "CPU iPhone OS 16_4 like" / "CPU OS 16_4 like". */
function iosVersion(userAgent: string): [number, number] | null {
  const match = / OS (\d+)_(\d+)/.exec(userAgent);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** iOS 16.4 opened "Add to Home Screen" to every browser's share sheet. */
function shareSheetInstallAvailable(userAgent: string): boolean {
  const version = iosVersion(userAgent);
  if (!version) return false;
  const [major, minor] = version;
  return major > 16 || (major === 16 && minor >= 4);
}

function iosGuide(userAgent: string): ManualInstallGuide {
  // In-app browsers leave out the Safari token
  if (!/Safari\//.test(userAgent)) return 'ios-safari-needed';
  if (!NON_SAFARI_BROWSERS.test(userAgent)) return 'ios';
  return shareSheetInstallAvailable(userAgent) ? 'ios' : 'ios-safari-needed';
}

export function manualInstallGuide({
  userAgent,
  maxTouchPoints = 0,
  installed,
}: InstallEnvironment): ManualInstallGuide | null {
  if (installed) return null;
  if (/iPhone|iPad|iPod/i.test(userAgent)) return iosGuide(userAgent);
  if (!/Macintosh/i.test(userAgent)) return null;
  if (maxTouchPoints > 1) return iosGuide(userAgent);
  if (!/Safari\//.test(userAgent) || NON_SAFARI_BROWSERS.test(userAgent)) return null;
  const version = Number(/Version\/(\d+)/.exec(userAgent)?.[1]);
  return version >= 17 ? 'mac-safari' : null;
}

/**
 * Preview installs (beta.track.zicha.dev) get their own name so they can sit
 * next to the production install on one home screen.
 */
export function appName(vercelEnv: string | undefined | null): { name: string; shortName: string } {
  return vercelEnv === 'preview'
    ? { name: 'Toggl Quick View (beta)', shortName: 'Toggl QV beta' }
    : { name: 'Toggl Quick View', shortName: 'Toggl QV' };
}
