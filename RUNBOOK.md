# RUNBOOK — onboarding a client

Steps, in order, for putting a new business on ChopChop. Follow it at the
client's counter without reading anything else.

Nothing here is self-serve. The seller never creates a tenant, never configures
a schema, never builds a storefront. You do all of it; they end up with a link
and a login.

**Before you start, have:**

- the business's trading name and the short name for the URL
- their WhatsApp number, the one they actually answer
- an email address for their login
- their price list, in whatever form it exists — a spreadsheet, a photo of a
  chalkboard, a WhatsApp broadcast
- whether they sell by weight or by the item
- whether they want customers to collect, or they deliver locally

Roughly 30 minutes if the price list is a spreadsheet.

---

## 1. Pick the slug

The slug is the last part of the shop link: `chopchoporder.co.za/<slug>`.

- lower case, hyphens, no spaces, no accents
- short enough to read aloud over a phone — `kruger-slaghuis`, not
  `kruger-family-butchery-pretoria-north`
- it is permanent in practice: it goes into QR codes and WhatsApp broadcasts,
  and changing it breaks every link already out there

Say it to them and get a yes before you type it anywhere.

## 2. Decide the four switches

These four values are the entire difference between one client and another.
Get them wrong and the shop is wrong in a way no code change fixes.

| switch | ask them | value |
|---|---|---|
| `sale_mode` | "Do you sell by weight, or by the item?" | by weight → `weight` · by the item → `unit` |
| `stock_mode` | "Do you also sell over a counter to walk-ins?" | yes → `availability` · no, orders only → `counted` |
| `fulfilment_mode` | "Do customers collect, or do you deliver?" | collect → `collect` · deliver → `local_delivery` |
| `attribute_schema` | "What choices does a customer make?" | see below |

**`sale_mode = weight`** means quantities can be decimals and the total the
buyer sees is an estimate until you confirm the real weight. A butchery, a
biltong maker, a cheese counter.

**`stock_mode = counted`** decrements a count when you confirm an order. It
stays accurate only if every sale goes through the app. A seller with a walk-in
trade wants `availability` — a simple in-stock switch — because their count
drifts wrong within hours.

**`attribute_schema`** is the list of choices on a product. Shoes have size and
colour. A butchery usually has one: per kg or per pack. A vacuum cleaner has
none, which is valid — the product is just a product.

```json
[{ "name": "size", "label": "Size", "options": ["7", "8", "9"] },
 { "name": "colour", "label": "Colour", "options": ["white", "black"] }]
```

It is a palette, not a rule: it lists what is *available* to this client. A
product uses only the attributes you actually put on it, so adding an option
later never disturbs existing products.

## 3. Write the tenant row

In the Supabase SQL editor, on project `sxzyhqzqavivmolcbdyj`.

This is the one place a dashboard write is correct — it is data, not schema.
Schema changes are still migration files, always.

Open https://supabase.com/dashboard/project/sxzyhqzqavivmolcbdyj/sql/new

Paste, edit every value, run:

```sql
insert into public.tenants
  (slug, name, whatsapp_number, sale_mode, stock_mode, fulfilment_mode,
   attribute_schema, branding)
values
  ('kruger-slaghuis',
   'Kruger Slaghuis',
   '27821234567',
   'weight',
   'availability',
   'collect',
   '[{"name":"unit","label":"Sold by","options":["per kg","per pack"]}]'::jsonb,
   '{"primary":"#7f1d1d","tagline":"Vars vleis, elke dag"}'::jsonb)
returning id, slug;
```

`whatsapp_number`: international, **no `+`, no leading zero**. `082 123 4567`
becomes `27821234567`. Get this wrong and every order message goes nowhere.

It should print one row. If it errors on the slug, that slug is already taken —
go back to step 1.

## 4. Create their login, linked to the business

One command does both: it creates the auth user with the address already
confirmed, and writes the `tenant_users` row that every RLS policy resolves
through. Nothing works without that row — a login without one sees "No business
linked to this login".

In a terminal, in `C:\ccode\git-repos\chopchop`:

```bash
npm run create-seller -- --email owner@example.com --password 'a-real-password' --tenant kruger-slaghuis --role owner
```

Replace all three values. `--tenant` is the slug from step 1, not the id.

Use an email the client actually reads — it is how a password reset reaches
them. Choose a password you can say over the phone, and tell them to change it.
Do not send a password over WhatsApp.

It prints the email, the business and the role. Read that back before moving on.

Re-running for an email that already exists links that person to this business
instead of failing, which is how a seller ends up with two shops on one login.

## 5. Sign in as them and check the switches

Open https://app.chopchoporder.co.za and sign in with the login you just made.

Go to **Settings**. The table there is the tenant row as the app resolved it.
Read it against step 2, line by line. If `sale_mode` says `unit` and they sell
meat by the kilo, fix it now — not after they have loaded 200 products.

## 6. Categories

**Catalogue → the category rail → Add.**

Their words, not yours. Beesvleis, not Beef, if that is what is on their board.
Four to eight is right. Categories are the storefront's whole navigation.

## 7. Their price list, imported

**Import.**

1. **Choose file** — opens the phone's file picker, which reaches Drive,
   Dropbox and anything saved out of a WhatsApp chat.
2. **Map the columns** — the screen shows only the attributes this client has.
   It names any column it is ignoring, so read that line.
3. **Review** — a table on a laptop, one card per product on a phone. Fix
   anything wrong here; this is the last stop before it is real.
4. **Commit** — the button counts what will be created and updated.

The count on the review screen is products, not rows. It is the number their
catalogue will grow by, so they can check it against their own list.

If the file is a mess, import what parses and fix the rest by hand. Re-importing
the same file later is safe: rows that already match come back as unchanged.

**No spreadsheet?** Enter five or ten products by hand in Catalogue, get them
trading, and import later. Do not spend an hour typing at their counter.

## 8. Photographs

**Catalogue → a product → the image area.**

On a phone there is a **Take photo** button that opens the camera directly. The
app shrinks every image before it uploads, so a 4 MB phone photo lands around
300 KB and works on their data.

Do three or four with them, so they see how it is done, then leave the rest to
them. A shop with photos on its ten best sellers looks finished; one with 200
grey blocks does not.

## 9. Place one real order in front of them

Open the shop link on your own phone, add something to the cart, check out, and
send the WhatsApp message. Then show them the order arriving in their dashboard
and walk it forward: **Received → Confirmed → Ready → Completed.**

Say this out loud, because it is the one thing that costs them money if they get
it wrong:

> **Received** means you have seen it. **Confirmed** means you have promised it.
> Only confirm once you know you have the stock.

If they are on `counted` stock, confirming is also what takes the item off their
count.

Dismiss the test order when you are done, or leave it — it is theirs to clear.

## 10. The listing conversation

In **Settings** there is a switch: *Show this business in the ChopChop
directory*.

Say this, plainly:

> ChopChop is going to have a page listing the businesses on it, so someone who
> has never heard of you can find your shop. You are on it by default. If you
> would rather not be, this switch turns it off and nothing else changes — your
> shop works exactly the same either way.

Then leave it as they answer. Do not talk them into it. The switch exists so
they are asked before anything lists them, not after.

## 11. Hand over the link

The shop link, which is the only URL their customers ever need:

```
https://chopchoporder.co.za/<slug>
```

Their dashboard:

```
https://app.chopchoporder.co.za
```

Tell them, in this order:

1. Put the shop link in their WhatsApp group and their WhatsApp Business
   profile, and in their Instagram or Facebook bio.
2. On their phone, open the dashboard, go to Settings and tap **Add to home
   screen**. It then opens straight into their orders like any other app. (On an
   iPhone it is the Share button, then *Add to Home Screen*.)
3. Orders arrive as WhatsApp messages, the same as now. The dashboard is where
   they keep track of them.

## 12. Check on them in a week

Look at their order queue. `sent` orders piling up unacknowledged means they are
not opening the dashboard, and the fix is a phone call, not a feature.

---

## When something is wrong

**"My shop link says Shop not found."** The slug is wrong, or `active` is false
on their tenants row.

**"No orders are coming through."** Check `whatsapp_number` on the tenant row —
international format, no `+`, no leading zero.

**"The wrong choices show on my products."** `attribute_schema` on their tenant
row. Adding an option is safe; existing products keep what they already have.

**"My stock counts are nonsense."** They are on `counted` and selling over a
counter. Switch them to `availability`.

**A count showing below zero** is not a bug. They confirmed more than they had
on record and the catalogue is telling them to recount. The meat was already
cut; refusing the confirm would not have un-cut it.
