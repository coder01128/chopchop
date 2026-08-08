import styles from './NotFound.module.css';

/**
 * Unknown slug, inactive tenant, or no slug at all. All three render this —
 * plainly, and without naming a business that may not exist.
 *
 * No tenant has resolved, so there is no branding to apply: this is the one
 * screen in either app that renders in the neutral default palette.
 */
export function NotFound({ slug }: { slug: string | null }) {
  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.heading}>Shop not found</h1>
        <p className={styles.body}>
          {slug
            ? 'This link does not point at a shop that is open right now.'
            : 'This link is missing the shop it should open.'}
        </p>
      </div>
    </main>
  );
}
