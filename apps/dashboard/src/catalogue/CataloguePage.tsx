import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabaseClient, useTenant } from '@chopchop/shared';
import {
  loadCategories,
  loadItems,
  type CategoryRow,
  type ItemSummary,
} from './catalogue-data';
import { CategoryRail } from './CategoryRail';
import { ItemGrid } from './ItemGrid';
import { ProductModal } from './ProductModal';
import styles from './CataloguePage.module.css';

type ModalState = { open: false } | { open: true; item: ItemSummary | null };

export function CataloguePage() {
  const tenant = useTenant();
  const client = getSupabaseClient();

  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<ModalState>({ open: false });

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [nextCategories, nextItems] = await Promise.all([
        loadCategories(client, tenant.id),
        loadItems(client, tenant.id),
      ]);
      setCategories(nextCategories);
      setItems(nextItems);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [client, tenant.id]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = items.filter((summary) => {
      if (categoryId !== null && summary.item.category_id !== categoryId) return false;
      if (term && !summary.item.name.toLowerCase().includes(term)) return false;
      return true;
    });

    const catOrder = new Map(categories.map((cat, i) => [cat.id, i]));
    return filtered.sort((a, b) => {
      const aIdx = a.item.category_id ? catOrder.get(a.item.category_id) ?? Infinity : Infinity;
      const bIdx = b.item.category_id ? catOrder.get(b.item.category_id) ?? Infinity : Infinity;
      return aIdx - bIdx;
    });
  }, [items, categories, categoryId, search]);

  async function reorderItems(fromIndex: number, toIndex: number) {
    const reordered = [...visible];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);

    for (let i = 0; i < reordered.length; i++) {
      if (reordered[i].item.sort_order !== i) {
        const { error: reorderError } = await client
          .from('items')
          .update({ sort_order: i })
          .eq('id', reordered[i].item.id);
        if (reorderError) {
          setError(`Could not reorder: ${reorderError.message}`);
          void refresh();
          return;
        }
      }
    }
    void refresh();
  }

  async function toggleActive(summary: ItemSummary) {
    // Optimistic: the toggle is the most-pressed control on the screen and a
    // round trip per press makes it feel broken.
    setItems((current) =>
      current.map((entry) =>
        entry.item.id === summary.item.id
          ? { ...entry, item: { ...entry.item, active: !entry.item.active } }
          : entry,
      ),
    );

    const { error: updateError } = await client
      .from('items')
      .update({ active: !summary.item.active })
      .eq('id', summary.item.id);

    if (updateError) {
      setError(`Could not update ${summary.item.name}: ${updateError.message}`);
      void refresh();
    }
  }

  return (
    <section className={styles.page}>
      <header className={styles.head}>
        <div>
          <p className="cc-eyebrow">Catalogue</p>
          <h1 className={styles.heading}>Products</h1>
        </div>
        <button type="button" className={styles.addButton} onClick={() => setModal({ open: true, item: null })}>
          + Add product
        </button>
      </header>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && <p className={styles.notice}>{notice}</p>}

      <div className={styles.layout}>
        <CategoryRail
          categories={categories}
          items={items}
          selectedId={categoryId}
          onSelect={setCategoryId}
          onChanged={() => void refresh()}
          onError={setError}
        />

        <div className={styles.main}>
          <label className={styles.search}>
            <span className="cc-visually-hidden">Search products</span>
            <input
              type="search"
              value={search}
              placeholder="Search products by name"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>

          {loading ? (
            <p className={styles.loading}>Loading…</p>
          ) : (
            <ItemGrid
              items={visible}
              hasAnyItems={items.length > 0}
              onEdit={(summary) => setModal({ open: true, item: summary })}
              onToggleActive={(summary) => void toggleActive(summary)}
              onAdd={() => setModal({ open: true, item: null })}
              onReorder={(from, to) => void reorderItems(from, to)}
            />
          )}
        </div>
      </div>

      {modal.open && (
        <ProductModal
          item={modal.item?.item ?? null}
          categories={categories}
          onClose={() => setModal({ open: false })}
          onSaved={(message) => {
            setModal({ open: false });
            setNotice(message);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
