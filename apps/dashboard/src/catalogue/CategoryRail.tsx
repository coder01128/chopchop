import { useState } from 'react';
import { getSupabaseClient, useTenant } from '@chopchop/shared';
import type { CategoryRow, ItemSummary } from './catalogue-data';
import styles from './CategoryRail.module.css';

/**
 * Categories are rows, not components. The nav a seller sees is whatever they
 * typed — "Beesvleis" and "Lam" are data.
 */
export function CategoryRail({
  categories,
  items,
  selectedId,
  onSelect,
  onChanged,
  onError,
}: {
  categories: CategoryRow[];
  items: ItemSummary[];
  selectedId: string | null;
  onSelect: (categoryId: string | null) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const tenant = useTenant();
  const client = getSupabaseClient();

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [pendingDelete, setPendingDelete] = useState<CategoryRow | null>(null);
  const [busy, setBusy] = useState(false);

  function countIn(categoryId: string): number {
    return items.filter((entry) => entry.item.category_id === categoryId).length;
  }

  async function run(work: () => Promise<{ error: { message: string } | null }>, failure: string) {
    setBusy(true);
    const { error } = await work();
    setBusy(false);
    if (error) {
      onError(`${failure}: ${error.message}`);
      return false;
    }
    onChanged();
    return true;
  }

  async function addCategory() {
    const name = newName.trim();
    if (!name) return;
    const sortOrder = categories.reduce((max, entry) => Math.max(max, entry.sort_order), 0) + 1;
    const ok = await run(async () => {
      const { error } = await client
        .from('categories')
        .insert({ tenant_id: tenant.id, name, sort_order: sortOrder, active: true });
      return { error };
    }, 'Could not add the category');
    if (ok) {
      setNewName('');
      setAdding(false);
    }
  }

  async function rename(category: CategoryRow) {
    const name = renameValue.trim();
    if (!name || name === category.name) {
      setRenamingId(null);
      return;
    }
    const ok = await run(async () => {
      const { error } = await client.from('categories').update({ name }).eq('id', category.id);
      return { error };
    }, 'Could not rename the category');
    if (ok) setRenamingId(null);
  }

  /**
   * Reorder by swapping sort_order with the neighbour. Two updates rather than
   * a drag library: it works with a keyboard, works on a phone, and there is
   * nothing to install.
   */
  async function move(index: number, direction: -1 | 1) {
    const current = categories[index];
    const neighbour = categories[index + direction];
    if (!current || !neighbour) return;

    setBusy(true);
    const first = await client
      .from('categories')
      .update({ sort_order: neighbour.sort_order })
      .eq('id', current.id);
    const second = await client
      .from('categories')
      .update({ sort_order: current.sort_order })
      .eq('id', neighbour.id);
    setBusy(false);

    if (first.error || second.error) {
      onError(`Could not reorder: ${(first.error ?? second.error)!.message}`);
      return;
    }
    onChanged();
  }

  async function toggleActive(category: CategoryRow) {
    await run(async () => {
      const { error } = await client
        .from('categories')
        .update({ active: !category.active })
        .eq('id', category.id);
      return { error };
    }, 'Could not update the category');
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const ok = await run(async () => {
      const { error } = await client.from('categories').delete().eq('id', pendingDelete.id);
      return { error };
    }, 'Could not delete the category');
    if (ok) {
      if (selectedId === pendingDelete.id) onSelect(null);
      setPendingDelete(null);
    }
  }

  return (
    <aside className={styles.rail} aria-label="Categories">
      <div className={styles.head}>
        <h2 className={styles.title}>Categories</h2>
        <button type="button" className={styles.addButton} onClick={() => setAdding(true)} disabled={busy}>
          + Category
        </button>
      </div>

      <ul className={styles.list}>
        <li>
          <button
            type="button"
            className={styles.entry}
            data-selected={selectedId === null || undefined}
            onClick={() => onSelect(null)}
          >
            <span className={styles.entryName}>All products</span>
            <span className={styles.count}>{items.length}</span>
          </button>
        </li>

        {categories.map((category, index) => (
          <li key={category.id}>
            {renamingId === category.id ? (
              <div className={styles.renameRow}>
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void rename(category);
                    if (event.key === 'Escape') setRenamingId(null);
                  }}
                />
                <button type="button" className={styles.miniButton} onClick={() => void rename(category)}>
                  Save
                </button>
              </div>
            ) : (
              <div className={styles.entryRow}>
                <button
                  type="button"
                  className={styles.entry}
                  data-selected={selectedId === category.id || undefined}
                  data-inactive={category.active ? undefined : true}
                  onClick={() => onSelect(category.id)}
                >
                  <span className={styles.entryName}>{category.name}</span>
                  <span className={styles.count}>{countIn(category.id)}</span>
                </button>

                <div className={styles.entryTools}>
                  <button type="button" className={styles.tool} title="Move up" disabled={index === 0 || busy} onClick={() => void move(index, -1)}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className={styles.tool}
                    title="Move down"
                    disabled={index === categories.length - 1 || busy}
                    onClick={() => void move(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={styles.tool}
                    title="Rename"
                    disabled={busy}
                    onClick={() => {
                      setRenamingId(category.id);
                      setRenameValue(category.name);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className={styles.tool}
                    title={category.active ? 'Hide from the shop' : 'Show in the shop'}
                    disabled={busy}
                    onClick={() => void toggleActive(category)}
                  >
                    {category.active ? '👁' : '🚫'}
                  </button>
                  <button type="button" className={styles.tool} title="Delete" disabled={busy} onClick={() => setPendingDelete(category)}>
                    ✕
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      {adding && (
        <div className={styles.renameRow}>
          <input
            autoFocus
            placeholder="Category name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void addCategory();
              if (event.key === 'Escape') setAdding(false);
            }}
          />
          <button type="button" className={styles.miniButton} onClick={() => void addCategory()}>
            Add
          </button>
        </div>
      )}

      {pendingDelete && (
        <div className={styles.confirmBackdrop} role="presentation">
          <div className={styles.confirm} role="dialog" aria-modal="true" aria-label="Delete category">
            <h3 className={styles.confirmTitle}>Delete "{pendingDelete.name}"?</h3>
            {/* items.category_id is ON DELETE SET NULL — the products survive,
                uncategorised. Saying so is the difference between a seller
                deleting confidently and never touching the control again. */}
            <p className={styles.confirmBody}>
              {countIn(pendingDelete.id) === 0
                ? 'No products are in this category.'
                : `${countIn(pendingDelete.id)} product(s) are in this category. They will not be deleted — they stay in the shop with no category until you file them somewhere else.`}
            </p>
            <p className={styles.confirmBody}>
              If you only want to hide it from buyers, hide it instead of deleting.
            </p>
            <div className={styles.confirmActions}>
              <button type="button" className={styles.miniButton} onClick={() => setPendingDelete(null)}>
                Cancel
              </button>
              <button type="button" className={styles.dangerButton} onClick={() => void confirmDelete()} disabled={busy}>
                Delete category
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
