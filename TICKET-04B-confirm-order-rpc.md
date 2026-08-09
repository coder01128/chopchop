# TICKET 04B — `confirm_order` RPC

Closes the one contract item ticket 04 deliberately left open: stock does not
decrement on confirm, though `SCHEMA.md` says it should when `stock_mode =
counted`. Also makes confirmation atomic across lines.

Runs before ticket 05. The storefront decides what a buyer can order by reading
stock; building it against stock that never moves means testing against a shop
where nothing ever sells out.

Depends on: 04, committed and pushed.

---

## Decisions already taken — do not relitigate

**Stock decrements once, at `confirm`, and never again.** Not at `sent`, or a
phantom order eats stock it never took. Not at `ready` or `completed`, which
move an order the seller already committed to. Nothing restores stock on any
later transition — by `confirm` the goods have left the shelf.

**A confirm never fails on insufficient stock.** The count is allowed to go
negative. The seller has already cut the meat; a database refusal doesn't un-cut
it, it leaves them unable to record what happened. A negative count is a visible
prompt to recount; a blocked confirm is a dead end.

**An `availability` tenant's confirm touches no stock at all.** No count exists to
move. A decrement path running against a null count is how a seller's shop
silently empties itself.

---

## §1 — The migration

One migration, one function. Follow `save_product` exactly — it is the
established pattern in this repo and 04B should not invent a second one.

`public.confirm_order(tenant_id, order_id, lines)`:

- **`SECURITY INVOKER`.** RLS applies as it does to the PostgREST calls this
  replaces. If a `SECURITY DEFINER` string appears anywhere in the file, it is a
  comment explaining why it isn't one.
- **Rejects a foreign `tenant_id` explicitly with `42501`**, rather than letting
  RLS filter to zero rows. "Confirmed nothing" and "you may not do that" must
  not look the same.
- **Reads `stock_mode` from the tenant row**, never from a client flag.
  `confirmOrder()` takes no mode options. It does not need `sale_mode` — whether
  a quantity was adjusted is answered by `qty_confirmed` being present, not by
  what the tenant sells.
- In one transaction: writes `qty_confirmed` and `line_total` per line, sets the
  order status to `confirmed` and stamps `confirmed_at`, and decrements
  `variants.stock` — only when the tenant is `counted`.
- **Returns the saved order with its lines**, so the detail screen reconciles
  without a second trip. Same reason as `save_product`.

Decrement amount: the quantity actually taken, which is `qty_confirmed` where the
seller entered one and `qty` where they did not. Never both, never `qty` when a
confirmed quantity exists — that is the whole point of the column.

**Refuses to confirm an order not in `received`.** Forward-only still holds, and
a double-tap must not decrement twice. Re-confirming an already-`confirmed`
order returns it unchanged rather than throwing — idempotent, not an error the
seller has to interpret.

## §2 — Wiring the dashboard to it

`OrderDetail` calls the RPC instead of its current per-line writes. The
confirmation arithmetic already tested in `order-model.ts` stays where it is —
the RPC executes the decision, it does not make it, same division as the
variant classifier.

No visible change for the seller. The running total, the quantity fields on a
weight tenant, the single-tap confirm on a unit tenant all behave exactly as
verified in 04.

## §3 — Surfacing a negative count

A variant whose stock has gone below zero must be visible as such in the
catalogue — the seller needs a prompt to recount. Minimal treatment: the count
renders as the negative number it is, marked, not clamped to zero and not
hidden. No new screen, no alerts, no separate report.

## §4 — Tests

Extend `tests/` in the pattern of `save-product-rpc.test.ts`:

- decrements on a `counted` tenant, by `qty_confirmed` where present and `qty`
  where not
- does not touch stock on an `availability` tenant
- allows the count to go negative rather than throwing
- refuses a payload carrying another tenant's id (`42501`)
- refuses to confirm an order belonging to another tenant
- refuses an order not in `received`
- re-confirming a `confirmed` order changes nothing and does not decrement twice
- rolls back completely when one line is invalid — no partial confirm, no
  half-decremented stock, order still `received`

Extend the leak test: a seller of tenant A cannot call `confirm_order` against
tenant B's order, and a buyer session cannot call it at all.

**Check first whether either demo tenant is `availability`.** `counted` is the
default and both demo tenants may be on it, in which case the no-decrement case
has nothing to run against. If so, flip a mode inside the test and restore it, or
create a third fixture tenant the test tears down. Do not skip the case, and do
not leave the seed altered.

## Out of scope

Restoring stock on any transition · low-stock warnings or thresholds · a
recount screen · backward transitions · anything in ticket 05.

## Done means

- `npm test` green, existing 115 still passing
- typecheck and build clean
- verified in a browser on both demo tenants: a weight-tenant confirm writes
  quantities and moves stock; a unit-tenant confirm moves stock with no weight
  language anywhere; an `availability` tenant's confirm leaves stock untouched
- one confirm driven past zero, with the negative count visible in the catalogue
- seed left in its exact original state
- nothing committed until Brad has run the leak test himself
