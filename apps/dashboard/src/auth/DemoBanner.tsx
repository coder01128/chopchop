import styles from './DemoBanner.module.css';

export function DemoBanner() {
  return (
    <div className={styles.banner} role="status">
      Demo Mode — exploring as a demo seller
    </div>
  );
}
