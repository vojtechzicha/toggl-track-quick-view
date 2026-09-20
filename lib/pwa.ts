/**
 * PWA install rules: where the "Install as an app" entry in Settings can
 * trigger the browser's own install dialog, and where it has to walk the
 * person through the platform's manual route instead.
 *
 * Chromium (Chrome, Edge, Android) fires `beforeinstallprompt`, and the
 * button replays it as the native dialog. WebKit never fires it — on iPhone
 * and iPad every browser is WebKit, and Safari on the Mac is too — so there
 * the same button opens a short walkthrough:
 *
 * - `ios`: Share button → "Add to Home Screen" from the browser the person
 *   is in. Safari has always had it; other browsers got it as a system
 *   share-sheet action in iOS 16.4. iPadOS Safari reports a Mac user agent,
 *   so a touch-capable "Macintosh" counts as iPadOS.
 * - `ios-safari-needed`: the same walkthrough, prefixed with "open this page
 *   in Safari" — for a third-party browser on iOS before 16.4 (or one whose
 *   iOS version the UA hides, the iPad desktop-mode case), and for in-app
 *   browsers (no `Safari/` token: Slack, Teams, mail apps), whose share
 *   menus never offer it on any version.
 * - `mac-safari`: File → "Add to Dock", available since Safari 17. Older
 *   Safari has no install at all, and Chromium-based Mac browsers take the
 *   native path, so both yield null. The command also needs macOS Sonoma,
 *   which the UA cannot tell: Safari freezes its platform string at
 *   "Mac OS X 10_15_7" on every macOS since Catalina, so Ventura and Sonoma
 *   look identical here. The sheet states the requirement instead of
 *   pretending to know.
 *
 * Inside the installed app there is nothing left to install, so the guide
 * never shows there. That state is `installed` here on purpose: the web
 * platform calls it "standalone display mode", but in this app "standalone"
 * already means the no-Toggl store mode (lib/source), and the two must not
 * be confused.
 *
 * Pure and browser-free, so `pnpm check:pwa` can pin every branch against
 * real user-agent strings.
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
  // An in-app browser announces itself by leaving out the Safari token
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
 * The name the installed app carries. Previews live on a stable host of
 * their own (beta.track.zicha.dev, see README → Getting started), so a
 * preview install is a real thing that sits next to the production one on
 * the same home screen — it needs its own name to be told apart.
 */
export function appName(vercelEnv: string | undefined | null): { name: string; shortName: string } {
  return vercelEnv === 'preview'
    ? { name: 'Toggl Quick View (beta)', shortName: 'Toggl QV beta' }
    : { name: 'Toggl Quick View', shortName: 'Toggl QV' };
}
