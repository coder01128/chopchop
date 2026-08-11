/**
 * Installing the dashboard to a home screen.
 *
 * Two jobs, both small, kept out of the component so the Settings screen holds
 * no browser trivia.
 *
 * The storefront has none of this and gets none of it. That asymmetry is
 * deliberate — see HANDOFF. A butchery's customers will not install anything,
 * and an install prompt on a shop link is friction with no return.
 */

import { useEffect, useState } from 'react';

/**
 * Chrome's `beforeinstallprompt`. Not in TypeScript's DOM library, because it
 * is not in any standard — Safari and Firefox never fire it.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Already installed: the app is running from its own icon, not a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's own, which predates the standard and is still the only
    // signal there.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export type InstallState =
  | { kind: 'installed' }
  /** Chrome or Edge, criteria met — a button can do it in one tap. */
  | { kind: 'ready'; install: () => Promise<void> }
  /** Safari, or criteria not met yet. The browser's own menu is the only path. */
  | { kind: 'manual' };

export function useInstallState(): InstallState {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => isStandalone());

  useEffect(() => {
    const onPrompt = (event: Event) => {
      // Chrome shows its own mini-infobar unless this is called, and we want
      // the tap to be the button on this screen.
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed) return { kind: 'installed' };
  if (!prompt) return { kind: 'manual' };

  return {
    kind: 'ready',
    install: async () => {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      // A prompt is single-use whatever the answer. Dropping it means the
      // button disappears rather than throwing on a second tap; Chrome fires
      // the event again on a later visit if the seller changes their mind.
      setPrompt(null);
      if (outcome === 'accepted') setInstalled(true);
    },
  };
}

/**
 * Registers the service worker, which exists only so `beforeinstallprompt`
 * fires — it caches nothing. See `public/sw.js`.
 *
 * Production only: in development it would sit between Vite and the browser
 * for no benefit.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    // A failed registration must never take the dashboard down with it. The
    // seller's order queue does not depend on this.
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
