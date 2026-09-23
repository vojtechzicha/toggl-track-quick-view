/**
 * Holds Chromium's deferred `beforeinstallprompt` event for the Settings
 * "Install as an app" button.
 *
 * The event fires once, early, long before Settings opens, so the root layout
 * catches it (components/ServiceWorkerRegister.tsx) and parks it here.
 *
 * It is not `preventDefault()`ed, so the browser's own install affordances
 * (omnibox icon, Android banner) stay available.
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
 * Take the event out of the store to prompt with it. An event can be prompted
 * once; after that `prompt()` rejects, and a dismissed dialog fires no
 * `appinstalled`. Removing it hides the button until Chromium issues a new
 * event.
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
