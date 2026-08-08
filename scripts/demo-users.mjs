// Demo dashboard logins, shared by the seed script and the leak test.
//
// These are demo-tenant credentials for a development project, not production
// secrets. Override the password with DEMO_USER_PASSWORD in .env if you want.
// There is no self-serve signup in this product — Brad creates real logins
// directly, and the seed creates these two.

export const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD ?? 'chopchop-demo-2026';

export const DEMO_USERS = {
  butchery: {
    slug: 'demo-butchery',
    email: 'demo-butchery-owner@example.com',
  },
  shoes: {
    slug: 'demo-shoes',
    email: 'demo-shoes-owner@example.com',
  },
};

export const DEMO_SLUGS = Object.values(DEMO_USERS).map((u) => u.slug);
