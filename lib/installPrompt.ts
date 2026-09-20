/**
 * Holds the browser's deferred install prompt for the Settings "Install as an
 * app" button.
 *
 * Chromium fires `beforeinstallprompt` once, early in the page's life, long
 * before anyone opens Settings — a listener mounted with the settings panel
 * would miss it every time. So the event is caught by a component that lives
 * in the root layout (components/ServiceWorkerRegister.tsx) and parked here,
 * and the button reads it through `useSyncExternalStore`.
 *
 * The event is kept, not cancelled: no `preventDefault()`, so the browser's
 * own install affordances (Chrome's omnibox icon, Android's banner) stay
 * exactly as they were. The Settings button is an extra way in, not the only
 * one — it sits behind a gear, so it should not be the sole entry either.
 */

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let armed = false;
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

/** Start listening. Idempotent; a no-op outside the browser. */
export function captureInstallPrompt(): void {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    deferred = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

export function getInstallPrompt(): BeforeInstallPromptEvent | null {
  return deferred;
}

/**
 * Take the event out of the store to prompt with it. A
 * BeforeInstallPromptEvent can be prompted ONCE: after that `prompt()`
 * rejects, and a dismissed dialog fires no `appinstalled`, so keeping the
 * event would leave a button that looks live and does nothing. Consuming it
 * hides the button until the browser hands out a fresh event (Chromium does,
 * after a while, when the person dismissed rather than installed).
 */
export function consumeInstallPrompt(): BeforeInstallPromptEvent | null {
  const event = deferred;
  deferred = null;
  if (event) notify();
  return event;
}

export function subscribeInstallPrompt(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Server snapshot: nothing to install during SSR. */
export function getServerInstallPrompt(): null {
  return null;
}
