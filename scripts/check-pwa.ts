// Content checks for the PWA install rules (lib/pwa.ts). Run with:
//   npm run check:pwa
//
// The Settings "Install as an app" button has two behaviours — replay the
// browser's own install prompt, or walk the person through the platform's
// manual route — and the walkthrough has three variants. Which one applies is
// decided from the user-agent string, and user-agent strings are exactly the
// kind of input that looks right until a real device shows up: iPadOS Safari
// claims to be a Mac, in-app browsers drop the Safari token, Safari on the
// Mac never says which macOS it runs on. Each branch is pinned here against
// a real string so a "small" regex tweak can't silently send iPhones to the
// Dock instructions.

import assert from 'node:assert/strict';
import { installResolveHooks } from './resolve-hooks.mjs';

installResolveHooks();

const { appName, manualInstallGuide } = await import('../lib/pwa.ts');

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE_SAFARI_OLD =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.0.0 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME_16_4 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/112.0.5615.46 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME_16_3 =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/110.0.5481.83 Mobile/15E148 Safari/604.1';
const IPHONE_FIREFOX_OLD =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/107.0 Mobile/15E148 Safari/605.1.15';
// In-app browsers (Slack, Teams, mail apps, Instagram…) leave the Safari token out.
const IPHONE_IN_APP =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0';
const IPAD_OLD =
  'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.0.0 Version/11.1.1 Safari/605.1.15';
const MAC_SAFARI_17 =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const MAC_SAFARI_16 =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const MAC_FIREFOX =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:130.0) Gecko/20100101 Firefox/130.0';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const WINDOWS_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0';

const guide = (userAgent: string, maxTouchPoints = 0, installed = false) =>
  manualInstallGuide({ userAgent, maxTouchPoints, installed });

let n = 0;
const eq = (actual: unknown, expected: unknown, label: string) => {
  assert.equal(actual, expected, label);
  n++;
};

// Safari on iPhone walks through the share sheet on any iOS version.
eq(guide(IPHONE_SAFARI, 5), 'ios', 'iPhone Safari');
eq(guide(IPHONE_SAFARI_OLD, 5), 'ios', 'iPhone Safari, old iOS');

// Third-party iOS browsers are trusted from 16.4, where the share sheet gained
// the action…
eq(guide(IPHONE_CHROME, 5), 'ios', 'iPhone Chrome');
eq(guide(IPHONE_CHROME_16_4, 5), 'ios', 'iPhone Chrome on 16.4 exactly');
// …and sent to Safari first before that.
eq(guide(IPHONE_CHROME_16_3, 5), 'ios-safari-needed', 'iPhone Chrome on 16.3');
eq(guide(IPHONE_FIREFOX_OLD, 5), 'ios-safari-needed', 'iPhone Firefox on 15.7');

// In-app browsers go to Safari — their share menus never offer it.
eq(guide(IPHONE_IN_APP, 5), 'ios-safari-needed', 'iPhone in-app browser');

// A touch-capable "Macintosh" is an iPad: iPadOS Safari hides behind a Mac UA.
eq(guide(MAC_SAFARI_17, 5), 'ios', 'iPad as Mac UA + touch');
eq(guide(IPAD_OLD, 5), 'ios', 'old iPad');

// A desktop-mode third-party browser on iPad hides the iPadOS version, so
// the safe answer is Safari first.
eq(guide(IPAD_DESKTOP_CHROME, 5), 'ios-safari-needed', 'iPad desktop-mode Chrome');

// "Add to Dock" in Safari 17+ on a real Mac (the macOS version is not in the UA).
eq(guide(MAC_SAFARI_17), 'mac-safari', 'Mac Safari 17');
eq(guide(MAC_SAFARI_16), null, 'Mac Safari 16 has no install');

// Where the browser fires beforeinstallprompt itself, the guide stays out of
// the way and the button replays the native prompt instead.
eq(guide(MAC_CHROME), null, 'Mac Chrome');
eq(guide(ANDROID_CHROME, 5), null, 'Android Chrome');
eq(guide(WINDOWS_EDGE), null, 'Windows Edge');

// Nothing to offer where no install exists at all.
eq(guide(MAC_FIREFOX), null, 'Mac Firefox');

// Never inside the installed app.
eq(guide(IPHONE_SAFARI, 5, true), null, 'installed on iPhone');
eq(guide(MAC_SAFARI_17, 0, true), null, 'installed on Mac');

// maxTouchPoints defaults to "not a touch device": a bare Mac Safari 17 UA
// with no touch information reads as a Mac, not an iPad.
eq(manualInstallGuide({ userAgent: MAC_SAFARI_17, installed: false }), 'mac-safari', 'touch default');

// The installed app's name: previews (beta.track.zicha.dev) install under
// their own name so they can sit next to the production install.
eq(appName('production').name, 'Toggl Quick View', 'prod name');
eq(appName('production').shortName, 'Toggl QV', 'prod short name');
eq(appName('preview').name, 'Toggl Quick View (beta)', 'preview name');
eq(appName('preview').shortName, 'Toggl QV beta', 'preview short name');
eq(appName(undefined).name, 'Toggl Quick View', 'no env = production naming');
eq(appName('').name, 'Toggl Quick View', 'empty env (baked outside Vercel) = production naming');
eq(appName('development').name, 'Toggl Quick View', 'vercel dev = production naming');

console.log(`✓ ${n} PWA install checks passed`);
