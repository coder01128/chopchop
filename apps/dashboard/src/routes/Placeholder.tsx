import { useTenant } from '@chopchop/shared';
import styles from './Placeholder.module.css';

/**
 * Empty screens for the four nav sections. Ticket 02 builds the skeleton only —
 * anything that would render a product or an order belongs to a later ticket,
 * so these stop at the route.
 */
export function Placeholder({
  labelKey,
  fallback,
  ticket,
  blurb,
}: {
  labelKey: string;
  fallback: string;
  ticket: string;
  blurb: string;
}) {
  const tenant = useTenant();
  return (
    <section className={styles.screen}>
      <p className="cc-eyebrow">{ticket}</p>
      <h1 className={styles.heading}>{tenant.label(labelKey, fallback)}</h1>
      <p className={styles.blurb}>{blurb}</p>
    </section>
  );
}

export const Orders = () => (
  <Placeholder
    labelKey="orders"
    fallback="Orders"
    ticket="Not built yet"
    blurb="The order queue, its status flow and the prefilled WhatsApp reply land in a later ticket."
  />
);

export const Catalogue = () => (
  <Placeholder
    labelKey="catalogue"
    fallback="Catalogue"
    ticket="Not built yet"
    blurb="Categories, items and the variant editor generated from attribute_schema land in a later ticket."
  />
);

export const Import = () => (
  <Placeholder
    labelKey="import"
    fallback="Import"
    ticket="Not built yet"
    blurb="Spreadsheet import first, then vision — both behind a review gate — land in a later ticket."
  />
);
