import type { TenantConfig } from '@chopchop/shared';
import { DEFAULT_MESSAGE_LABELS, type MessageLabels } from '../storefront-model';

/**
 * The words in the WhatsApp message, in the client's own vocabulary.
 *
 * `branding.labels` is the storefront's customer-facing vocabulary — the seed
 * sets `catalogue` and `cart`, and every other key here is optional with a
 * sensible default, which is what `label()` is for. A client who trades in
 * Afrikaans writes `{"order": "Bestelling", "collect": "Haal self op"}` on their
 * tenant row and nothing in this codebase changes.
 *
 * This is deliberately the only place that maps label keys to message wording,
 * so the keys a client may set are listed once rather than scattered through
 * the components.
 */
export function messageLabelsFor(tenant: TenantConfig): MessageLabels {
  return {
    order: tenant.label('order', DEFAULT_MESSAGE_LABELS.order),
    estimate: tenant.label('estimate', DEFAULT_MESSAGE_LABELS.estimate),
    total: tenant.label('total', DEFAULT_MESSAGE_LABELS.total),
    collect: tenant.label('collect', DEFAULT_MESSAGE_LABELS.collect),
    delivery: tenant.label('delivery', DEFAULT_MESSAGE_LABELS.delivery),
  };
}
