# TICKET 06 — Import (file)

Dashboard-only. A spreadsheet in, a reviewed set of items and variants out.
Nothing is written to `items`, `variants` or `categories` until the seller
presses Commit on the review screen.

Photo / vision extraction is **06B**, a separate ticket. This one has no cloud
dependency beyond Supabase itself.

Read `CLAUDE.md` and `SCHEMA.md` first. This ticket does not restate the schema;
where it needs a column it says so as a pre-check, not as an assumption.

---

## Why this is in v1

A seller importing their existing price list is a large part of why the package
is worth buying. Onboarding a WhatsApp-group business means taking the
spreadsheet they already have and turning it into a catalogue in one sitting.
Deferring this has been proposed and rejected.

---

## Pre-checks — run these and report before writing any code

Do not assume any of the following. Read them, state what you found, and stop if
anything contradicts this ticket.

1. **`import_batches` columns, constraints and RLS policies.** Read them from the
   DB, not from memory. This ticket assumes the table exists and is
   tenant-scoped; it does not assume any particular column set. Report the
   columns and say which of them this ticket needs and which it does not.
2. **`save_product` signature and return shape.** The commit step calls it per
   item rather than writing its own inserts — atomicity, tenant checking and
   `stock_mode` resolution are already solved there and must not be
   reimplemented. Confirm whether it takes one item or an array, and what it
   returns.
3. **`categories` columns.** Specifically whether a category needs anything
   beyond a name and a tenant (a slug, a sort position, a parent), because
   create-on-import has to supply all of it.
4. **Whether any existing dashboard code already parses files.** Grep before
   adding a dependency.

---

## Local vs cloud

**Fully local.** `.csv` and `.xlsx` are parsed in the browser with SheetJS. No
upload, no network call, no new secret, no new deployment surface. The file never
leaves the seller's machine.

---

## Scope

### 1. Input

One entry point on the Import screen: a file picker accepting `.csv` and
`.xlsx`. Parsed client-side into a headers-plus-rows structure.

**That structure is the seam for 06B.** Vision extraction will produce the same
headers-plus-rows shape and enter at the mapping step. Build the mapping screen
against that structure, not against the parser — nothing downstream of the parse
may know where the rows came from.

### 2. Column mapping

Raw rows carry the seller's own headers. The mapping step maps each header to a
field:

- item name (required)
- price (required)
- category
- stock
- sku
- one column per attribute

Guess by header name, then let the seller correct every mapping. Unmapped
columns are ignored, and the screen says so — a silently dropped column is a
seller's missing data.

For a tenant with `stock_mode = 'availability'` the stock column is ignored:
`save_product` reads the mode off the tenant row and writes no stock figure for
them. The mapping screen must say this, naming the column it is ignoring.
Silent is not acceptable — the seller mapped that column and has to be told it
goes nowhere.

Attribute columns are offered from the tenant's `attribute_schema`. This is the
one place `attribute_schema` is read as a palette for mapping, and it does not
change the rule that a product's selectors are rendered from its own variants'
keys. Never from `attribute_schema`.

### 3. Row model

**One row is one variant.** Rows sharing an item name collapse into one item
with several variants, keyed by their attribute values. A row with no attribute
columns is an item with a single variant — the vacuum-cleaner case.

`sale_mode` decides what price means (per unit or per kg) for display and for
labels. It does not change the row model.

### 4. Category mapping

Collect the **distinct** category names in the file, not the rows. Show each one
once with a target: attach to an existing category, or create it. Default to
create, because a first import has nothing to match against.

Eight categories across two hundred rows is eight decisions. Nothing is written
to `categories` without a tap.

### 5. Matching against what already exists

A re-import of a grown spreadsheet is the normal case, not the exception. A
seller who imported 20 items and comes back two months later with 34 must end
with 34 items, not 54.

Match order, scoped to the tenant:

1. **SKU**, when the row has one.
2. Otherwise **item name**, normalised — lowercased, whitespace collapsed,
   trimmed.

Then per matched item, match the variant by its attribute value set, or by SKU.

Outcomes per row:

- **no match** → new
- **one match, no field differences** → unchanged
- **one match, differences** → update, differences listed
- **two or more matches** → ambiguous. The seller resolves it in review. Never
  guess.

**A row that is absent from the file means nothing.** No delete, no retire, no
deactivate, no flag. A seller who uploads only the 14 new lines must not lose the
20 that aren't in it. This is the single most damaging thing this feature could
do and there is no setting that turns it on.

A renamed product imports as a new item. The import cannot distinguish a rename
from a new product, and the review screen shows it as new, which is where the
seller catches it.

### 6. Review screen

The commit gate. Shows, before anything is written:

- counts — new, updated, unchanged, ambiguous, error
- every price change as old → new
- the category mapping decisions
- error rows with the reason, excluded from the commit but visible

The seller can commit with errors present; those rows are skipped. The seller
can cancel, and nothing has been written.

Renders as a table above 48rem and a card stack below it. A seller doing this on
a phone in their shop is the expected case.

### 7. Commit

- Per item, through `save_product`. No direct inserts into `items` or `variants`.
- Categories created first, so items have something to attach to.
- The `import_batches` row follows the lifecycle the table already has, and no
  migration is added for this ticket. Written when the review screen opens:
  `source = 'spreadsheet'`, `raw` = the parsed rows, `status = 'pending'`.
  Updated to `applied` on commit, or `discarded` if the seller cancels.
- Per-item failures are reported on the commit screen, not stored. Re-importing
  the same file is the recovery path, and it is safe because matching is in this
  ticket — the rows that succeeded come back as `unchanged`.
- Report per-item failures in the result. Do not roll the whole batch back —
  a seller who imported 190 of 200 rows wants the 190.

---

## Out of scope

- Photo / PDF / vision extraction — 06B
- Per-variant images
- Deleting, retiring or deactivating anything via import
- Scheduled or automatic imports
- Undo of a committed import — `import_batches` records what happened, but there
  is no reverse button in v1. Flagged as an open question, not built.
- Self-serve anything

---

## Code shape

Follow `variant-model.ts` and `order-model.ts`: every rule as a pure function in
`import-model.ts`, with the screens holding no logic.

- `import-model.ts` — normalisation, row collapsing, matching, classification,
  diffing, error detection
- `import-data.ts` — the Supabase calls
- `apps/dashboard/src/import/` — mapping, review and commit screens

---

## Tests

Extend the existing suite; do not start a new pattern.

`import-model` unit tests, at minimum:

- match by SKU when present, ignoring name
- match by normalised name — case, trailing space, double space
- no match → new
- two matches → ambiguous, never auto-resolved
- rows sharing a name collapse into one item with several variants
- a row with no attribute columns yields a single variant
- absence: an existing item not present in the file is untouched and appears in
  no outcome list
- price change detected and reported old → new
- missing name and missing price are errors, and an error row does not abort the
  others
- distinct category names collected once, not per row

Leak test additions:

- a seller cannot import into another tenant
- `anon` cannot write `import_batches`

Report the new total against the current 167 and confirm `skipped 0`.

---

## Definition of done

- A spreadsheet reaches the mapping screen, the review screen, and commits
- A re-import of a grown list produces the right totals with no duplicates
- Nothing is removed by an import under any circumstances
- The review screen shows every write before it happens
- The mapping step consumes headers-plus-rows and knows nothing about the parser
- Tests pass, typecheck clean, build clean
- Nothing committed until Brad has run the leak test himself and read the output
  with `--reporter=verbose`
