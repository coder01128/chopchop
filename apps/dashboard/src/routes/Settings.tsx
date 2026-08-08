import { useTenant } from '@chopchop/shared';
import styles from './Settings.module.css';

/**
 * Read-only for now. Editing business details, branding and fulfilment is
 * wireframe section 07 and a later ticket.
 *
 * What it does do is show the resolved tenant config, which is the only visible
 * proof that tenant resolution worked and that two sellers signing into the
 * same deployment get different behaviour. Sign in as each demo tenant and this
 * table should disagree with itself on every row.
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
      <p className="cc-eyebrow">Read only for now</p>
      <h1 className={styles.heading}>Settings</h1>
      <p className={styles.blurb}>
        Everything this business does is driven by these values, not by code. Editing them is a
        later ticket.
      </p>

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
