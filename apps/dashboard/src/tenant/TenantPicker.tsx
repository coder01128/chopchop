import { initialsFor, inkOn, safeAccent, type TenantRow } from '@chopchop/shared';
import styles from './TenantPicker.module.css';

/**
 * Shown when one login is linked to more than one business.
 *
 * v1 never produces this — Brad creates one login per client — but
 * `tenant_users` is unique on (tenant_id, user_id), not on user_id, so the
 * schema allows it. Rendering a picker costs a screen; discovering the
 * assumption in production costs more.
 *
 * The mark is drawn here rather than with <TenantMark> because no tenant has
 * been resolved yet — there is no context to read from at this point.
 */
export function TenantPicker({
  options,
  onPick,
}: {
  options: TenantRow[];
  onPick: (tenantId: string) => void;
}) {
  return (
    <main className={styles.screen}>
      <div className={styles.card}>
        <p className="cc-eyebrow">ChopChop</p>
        <h1 className={styles.heading}>Choose a business</h1>
        <p className={styles.blurb}>This login is linked to more than one.</p>

        <ul className={styles.list}>
          {options.map((tenant) => {
            const accent = safeAccent((tenant.branding as { primary?: string })?.primary);
            return (
            <li key={tenant.id}>
              <button className={styles.option} type="button" onClick={() => onPick(tenant.id)}>
                <span
                  className={styles.mark}
                  style={{ background: accent, color: inkOn(accent) }}
                  aria-hidden="true"
                >
                  {initialsFor(tenant.name)}
                </span>
                <span className={styles.name}>{tenant.name}</span>
                <span className={styles.slug}>{tenant.slug}</span>
              </button>
            </li>
            );
          })}
        </ul>
      </div>
    </main>
  );
}
