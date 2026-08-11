#!/usr/bin/env node
/**
 * Fails the build if anything secret reached a client bundle.
 *
 * CLAUDE.md says secrets never reach the client bundle. That sentence is a
 * convention, and a convention is not a control — this script is the control.
 * It runs as the second half of every `vite build`, so it runs locally, on
 * Vercel, and on any future CI, and there is no build path that skips it.
 *
 * Why the patterns are key-SHAPED and not literal strings
 * ------------------------------------------------------
 * supabase-js carries its own key-prefix check, so the bare literal
 * `sb_secret_` appears in every bundle we will ever ship:
 *
 *     a.startsWith("sb_publishable_") || a.startsWith("sb_secret_")
 *
 * A grep for the literal therefore fails every build, gets switched off within
 * a week, and leaves no control at all. Every pattern below requires the
 * characters a real key would carry after the prefix.
 *
 * Nothing here ever prints a match. A build log is not a private place, and a
 * control that leaks the value it caught is worse than no control. Failures
 * report the file, the byte offset and the name of the rule — enough to find
 * it, nothing anyone can use.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const RULES = [
  {
    name: 'supabase secret key (sb_secret_…)',
    pattern: /sb_secret_[A-Za-z0-9_-]{8,}/g,
  },
  {
    // The legacy JWT pair is deprecated end of 2026 and unused here, so any
    // three-segment JWT in a bundle is either a service_role key somebody
    // pasted or a session token somebody hardcoded. Neither belongs.
    name: 'legacy JWT key or hardcoded token (eyJ….….…)',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    // Not a key, but the role name only appears in a bundle if someone is
    // constructing a privileged client in front-end code.
    name: 'service_role reference',
    pattern: /service_role/g,
  },
];

/** Binary assets cannot carry a pasted key in a form a bundler would produce. */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm', '.pdf', '.zip',
]);

function filesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path));
      continue;
    }
    const dot = entry.lastIndexOf('.');
    const extension = dot === -1 ? '' : entry.slice(dot).toLowerCase();
    if (!SKIP_EXTENSIONS.has(extension)) found.push(path);
  }
  return found;
}

const target = resolve(process.argv[2] ?? 'dist');

let files;
try {
  files = filesUnder(target);
} catch {
  console.error(`\nSecret check: cannot read build output at ${target}.`);
  console.error('The build produced nothing to check, which is itself a failure.\n');
  process.exit(1);
}

if (files.length === 0) {
  console.error(`\nSecret check: ${target} is empty. Refusing to pass a build with no output.\n`);
  process.exit(1);
}

const failures = [];

for (const file of files) {
  const contents = readFileSync(file, 'utf8');
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(contents)) !== null) {
      failures.push({
        file: relative(process.cwd(), file),
        offset: match.index,
        rule: rule.name,
      });
    }
  }
}

if (failures.length > 0) {
  console.error(`\n  BUILD FAILED — secret material found in ${target}\n`);
  for (const failure of failures) {
    console.error(`  ${failure.rule}`);
    console.error(`    ${failure.file}, byte ${failure.offset}`);
  }
  console.error('\n  The value is deliberately not printed. Open the file at that offset.');
  console.error('  Only VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY belong in a bundle.');
  console.error('  If a secret key was set as a Vercel environment variable, remove it there too —');
  console.error('  a variable that reached a build is disclosed and must be rotated in Supabase.\n');
  process.exit(1);
}

console.log(`Secret check: ${files.length} files in ${target}, clean.`);
