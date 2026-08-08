// Create a seller login for a tenant.
//
//   npm run create-seller -- --email ross@example.com --password '…' --tenant demo-butchery
//   npm run create-seller -- --email ross@example.com --password '…' --tenant demo-butchery --role owner
//
// There is no self-serve signup in this product and there is no invite flow
// either: email confirmation is on and the built-in SMTP is not production
// grade, so an invite mail would land in spam or not at all. The admin API
// creates the user with the address already confirmed, which is why this runs
// with the secret key and never from the browser.
//
// Re-running for an existing email links that user to the tenant rather than
// failing — handing an existing seller a second business is a real case, and
// the unique constraint on (tenant_id, user_id) stops a duplicate link.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;

if (!url || !secret) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SECRET_KEY in .env');
  process.exit(1);
}

/** Minimal --flag value parser; no dependency worth adding for four flags. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const email = typeof args.email === 'string' ? args.email.trim() : null;
const password = typeof args.password === 'string' ? args.password : null;
const slug = typeof args.tenant === 'string' ? args.tenant.trim() : null;
const role = args.role === 'owner' || args.role === 'staff' ? args.role : 'owner';

if (!email || !password || !slug) {
  console.error(
    'Usage: npm run create-seller -- --email <email> --password <password> --tenant <slug> [--role owner|staff]',
  );
  process.exit(1);
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const db = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --- tenant ----------------------------------------------------------------

const { data: tenant, error: tenantError } = await db
  .from('tenants')
  .select('id, name, slug, active')
  .eq('slug', slug)
  .maybeSingle();

if (tenantError) {
  console.error(`Could not look up tenant: ${tenantError.message}`);
  process.exit(1);
}
if (!tenant) {
  console.error(`No tenant with slug "${slug}". Create the tenants row first.`);
  process.exit(1);
}

// --- auth user -------------------------------------------------------------

let userId;

const { data: created, error: createError } = await db.auth.admin.createUser({
  email,
  password,
  // The seller never sees a confirmation mail; they are handed the login.
  email_confirm: true,
});

if (created?.user) {
  userId = created.user.id;
  console.log(`Created auth user for ${email}`);
} else if (createError && /already|registered|exists/i.test(createError.message)) {
  const { data: page, error: listError } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) {
    console.error(`Could not list users: ${listError.message}`);
    process.exit(1);
  }
  const existing = page.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (!existing) {
    console.error(`${email} is registered but could not be found in the first 1000 users.`);
    process.exit(1);
  }
  userId = existing.id;
  console.log(`${email} already exists — linking the existing user.`);
} else {
  console.error(`Could not create the auth user: ${createError?.message ?? 'unknown error'}`);
  process.exit(1);
}

// --- link ------------------------------------------------------------------

const { error: linkError } = await db
  .from('tenant_users')
  .upsert({ tenant_id: tenant.id, user_id: userId, role }, { onConflict: 'tenant_id,user_id' });

if (linkError) {
  console.error(`Could not link the user to ${tenant.slug}: ${linkError.message}`);
  process.exit(1);
}

console.log(`
  ${email}
  -> ${tenant.name} (${tenant.slug})${tenant.active ? '' : '  [tenant is INACTIVE]'}
  role: ${role}

  They can sign in at the dashboard now. The password is not printed here — it
  is the one you passed in.
`);
