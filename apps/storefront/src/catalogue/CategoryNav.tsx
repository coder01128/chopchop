import type { CategoryRow } from '../storefront-data';
import styles from './CategoryNav.module.css';

export function CategoryNav({
  categories,
  activeId,
  onSelect,
}: {
  categories: Pick<CategoryRow, 'id' | 'name'>[];
  activeId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const sorted = [...categories].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <nav className={styles.nav} aria-label="Categories">
      <button
        type="button"
        className={styles.row}
        data-on={activeId === null || undefined}
        onClick={() => onSelect(null)}
      >
        All
      </button>
      {sorted.map((cat) => (
        <button
          key={cat.id}
          type="button"
          className={styles.row}
          data-on={activeId === cat.id || undefined}
          onClick={() => onSelect(cat.id)}
        >
          {cat.name}
        </button>
      ))}
    </nav>
  );
}
