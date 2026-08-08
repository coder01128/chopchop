import type { ReactNode } from 'react';
import styles from './Notice.module.css';

/**
 * Every non-screen state the dashboard can be in: loading, empty, blocked,
 * broken. One component so they cannot drift apart, and so none of them is the
 * white screen that a thrown error would otherwise produce.
 */
export function Notice({
  title,
  tone = 'neutral',
  action,
  children,
}: {
  title: string;
  tone?: 'neutral' | 'error';
  action?: { label: string; onClick: () => void };
  children?: ReactNode;
}) {
  return (
    <main className={styles.screen}>
      <div className={styles.card} data-tone={tone}>
        <h1 className={styles.title}>{title}</h1>
        {children && <p className={styles.body}>{children}</p>}
        {action && (
          <button className={styles.action} type="button" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
    </main>
  );
}
