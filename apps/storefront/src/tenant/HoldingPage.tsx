import { useEffect } from 'react';
import styles from './HoldingPage.module.css';

/**
 * The bare apex, `chopchoporder.co.za` with no slug.
 *
 * This is the address someone types after seeing a link, so it must never be
 * an error, a blank screen, or a redirect into whichever client's shop happens
 * to be first. It names ChopChop and stops there.
 *
 * It deliberately lists nothing. Every client on the platform is reachable
 * from this deployment, and a directory is a decision the clients get told
 * about first — `tenants.listed` exists so that conversation can happen before
 * anything renders here.
 */
export function HoldingPage() {
  // No tenant resolved, so nothing else sets the title. Left alone it stays on
  // the index.html placeholder, and the browser tab is part of this page.
  useEffect(() => {
    document.title = 'ChopChop';
  }, []);

  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.wordmark}>
          Chop<span className={styles.mark}>Chop</span>
        </h1>
        <p className={styles.body}>Catalogues and orders for small businesses.</p>
      </div>
    </main>
  );
}
