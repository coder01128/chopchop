import { useCallback, useEffect, useState } from 'react';
import { getSupabaseClient, useTenant } from '@chopchop/shared';
import { useInstallState } from '../pwa/install';
import {
  CatalogueDeleteError,
  deleteCatalogue,
  loadListed,
  setListed,
  type CatalogueDeleteResult,
} from './settings-data';
import styles from './Settings.module.css';

/**
 * Mostly read-only. Editing business details, branding and fulfilment is
 * wireframe section 07 and a later ticket.
 *
 * What it does show is the resolved tenant config, which is the only visible
 * proof that tenant resolution worked and that two sellers signing into the
 * same deployment get different behaviour. Sign in as each demo tenant and this
 * table should disagree with itself on every row.
 *
 * Two things here are not read-only: the directory listing, and installing the
 * dashboard to a home screen. Both are the seller's own choices about their
 * own business, which is why they are here rather than in a runbook step Brad
 * performs on their behalf.
 */
export function Settings() {
  const tenant = useTenant();

  const rows: [string, string][] = [
    ['slug', tenant.slug],
    ['sale_mode', tenant.saleMode],
    ['stock_mode', tenant.stockMode],
    ['fulfilment_mode', tenant.fulfilmentMode],
    ['whatsapp_number', tenant.whatsappNumber ?? '—'],
    [
      'attribute_schema',
      tenant.attributeSchema.length
        ? tenant.attributeSchema
            .map((a) => `${a.name} (${a.options.length}: ${a.options.join(', ')})`)
            .join(' · ')
        : 'none — single default variant',
    ],
    ['branding.primary', tenant.branding.primary ?? 'unset — neutral default'],
    ['branding.logo_url', tenant.branding.logo_url ?? 'unset — initials block'],
    ['branding.tagline', tenant.branding.tagline ?? '—'],
    [
      'branding.labels',
      Object.entries(tenant.branding.labels ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ') || 'none — defaults used',
    ],
  ];

  return (
    <section className={styles.screen}>
      <h1 className={styles.heading}>Settings</h1>
      <p className={styles.blurb}>
        Everything this business does is driven by these values, not by code. Most of them are
        read only for now.
      </p>

      <DirectoryListing tenantId={tenant.id} />
      <InstallCard />
      <DeleteCatalogue tenantId={tenant.id} />

      <p className="cc-eyebrow">Read only for now</p>
      <dl className={styles.table}>
        {rows.map(([key, value]) => (
          <div className={styles.row} key={key}>
            <dt className={styles.key}>{key}</dt>
            <dd className={styles.value}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The one setting a seller owns today.
 *
 * The sentence matters as much as the switch. A seller who cannot tell what a
 * toggle does will either leave it alone forever or turn it off defensively,
 * and either way they were never really asked.
 */
function DirectoryListing({ tenantId }: { tenantId: string }) {
  const client = getSupabaseClient();

  const [listed, setValue] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    setError(null);
    loadListed(client, tenantId)
      .then((value) => {
        if (active) setValue(value);
      })
      .catch(() => {
        if (active) setError('Could not load this setting.');
      });
    return () => {
      active = false;
    };
  }, [client, tenantId]);

  useEffect(load, [load]);

  async function toggle(next: boolean) {
    // Optimistic, then put it back if the write fails. A switch that lags
    // behind the thumb reads as broken, and this one is a single boolean.
    const previous = listed;
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      await setListed(client, tenantId, next);
    } catch {
      setValue(previous);
      setError('Could not save that. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>Show this business in the ChopChop directory</h2>
          <p className={styles.cardBody}>
            ChopChop plans a page listing the businesses on it, so someone who has never heard of
            you can find your shop. Turn this off and your shop still works exactly as it does
            now — it simply will not appear on that page. Nothing lists anyone yet; this is your
            answer for when it does.
          </p>
        </div>

        <label className={styles.switch}>
          <input
            type="checkbox"
            checked={listed ?? false}
            disabled={listed === null || saving}
            onChange={(event) => void toggle(event.target.checked)}
          />
          <span className={styles.switchLabel}>
            {listed === null ? 'Loading…' : listed ? 'Listed' : 'Not listed'}
          </span>
        </label>
      </div>

      {error && (
        <p className={styles.cardError} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Installing to a home screen. Chrome hands over a one-tap prompt; Safari never
 * will, so that path is a sentence instead of a broken button.
 */
function InstallCard() {
  const state = useInstallState();

  if (state.kind === 'installed') return null;

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>Add to your home screen</h2>
          <p className={styles.cardBody}>
            {state.kind === 'ready'
              ? 'Opens straight into your orders, like any other app on your phone.'
              : 'Open your browser’s menu and choose Add to Home Screen. It then opens straight into your orders, like any other app on your phone.'}
          </p>
        </div>

        {state.kind === 'ready' && (
          <button type="button" className={styles.install} onClick={() => void state.install()}>
            Install
          </button>
        )}
      </div>
    </section>
  );
}

/** Typed to confirm. Not the business name: it must work for every tenant, and "DELETE" is what the seller is about to do. */
const CONFIRM_WORD = 'DELETE';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describeFailure(error: unknown): string {
  if (error instanceof CatalogueDeleteError) {
    if (error.kind === 'open-orders') {
      return `${plural(error.openOrders, 'order is', 'orders are')} still open. Complete or dismiss ${
        error.openOrders === 1 ? 'it' : 'them'
      } in Orders, then try again.`;
    }
    if (error.kind === 'not-owner') return 'Only the owner of this business can delete the catalogue.';
  }
  return 'Could not delete the catalogue. Check your connection and try again.';
}

/**
 * Wipe the catalogue.
 *
 * Irreversible, so it sits under its own heading, asks for a typed word rather
 * than a click, and uses a centred dialog (the same pattern as the category and
 * variant confirmations). Orders are untouched; the dialog says so, because
 * that is the first thing a seller needs to know before pressing it.
 */
function DeleteCatalogue({ tenantId }: { tenantId: string }) {
  const client = getSupabaseClient();

  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CatalogueDeleteResult | null>(null);

  const armed = typed.trim() === CONFIRM_WORD;

  useEffect(() => {
    if (!open || working) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, working]);

  function begin() {
    setTyped('');
    setError(null);
    setResult(null);
    setOpen(true);
  }

  async function confirm() {
    if (!armed || working) return;
    setWorking(true);
    setError(null);
    try {
      setResult(await deleteCatalogue(client, tenantId));
      setOpen(false);
    } catch (caught) {
      setError(describeFailure(caught));
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>Delete all catalogue data</h2>
          <p className={styles.cardBody}>
            Removes every product, variant, category, photo and pending import for this business,
            so you can start again from an empty catalogue. Your orders are kept. This cannot be
            undone.
          </p>
        </div>

        <button type="button" className={styles.danger} onClick={begin}>
          Delete everything
        </button>
      </div>

      {result && (
        <div className={styles.cardResult} role="status">
          <p>
            Deleted {plural(result.itemsDeleted, 'product', 'products')} and{' '}
            {plural(result.categoriesDeleted, 'category', 'categories')}.
          </p>
          {result.itemsKept > 0 && (
            <p>
              {plural(result.itemsKept, 'product appears', 'products appear')} in past orders, so{' '}
              {result.itemsKept === 1 ? 'it was' : 'they were'} hidden from the shop and kept. Order
              history still shows what was sold.
            </p>
          )}
          {result.photosFailed > 0 && (
            <p>{plural(result.photosFailed, 'photo', 'photos')} could not be removed.</p>
          )}
        </div>
      )}

      {open && (
        <div className={styles.backdrop} role="presentation">
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-catalogue-title"
          >
            <h3 id="delete-catalogue-title" className={styles.dialogTitle}>
              Delete all catalogue data?
            </h3>
            <p className={styles.dialogBody}>
              This permanently deletes every product, variant, category, photo and pending import.
              Your shop will be empty.
            </p>
            <p className={styles.dialogBody}>
              Orders are not deleted. A product that appears in a past order cannot be erased
              without breaking that order, so it is hidden from the shop and kept instead.
            </p>

            <label className={styles.confirmLabel} htmlFor="delete-catalogue-confirm">
              Type {CONFIRM_WORD} to confirm
            </label>
            <input
              id="delete-catalogue-confirm"
              className={styles.confirmInput}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={typed}
              disabled={working}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void confirm();
              }}
            />

            {error && (
              <p className={styles.cardError} role="alert">
                {error}
              </p>
            )}

            <div className={styles.dialogActions}>
              <button
                type="button"
                className={styles.secondary}
                disabled={working}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.danger}
                disabled={!armed || working}
                onClick={() => void confirm()}
              >
                {working ? 'Deleting…' : 'Delete everything'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
