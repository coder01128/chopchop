import type { TenantBranding } from './tenant';

/**
 * Branding is applied as CSS custom properties on the document root, which is
 * why no component carries a tenant's colour. One deployment serves every
 * tenant; the stylesheet is identical for all of them and only these variables
 * change.
 */

/** Neutral accent for a tenant that has not set one. */
export const DEFAULT_ACCENT = '#c9a227';

/** Dark and light inks, matching the shell palette. */
const INK_DARK = '#12120f';
const INK_LIGHT = '#f2efe6';

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * `branding.primary` is tenant data, and it is about to be written into a CSS
 * custom property. Anything that is not a plain hex colour is discarded rather
 * than trusted — a stray `red; position:fixed` in a jsonb column should not be
 * able to reach the stylesheet.
 */
export function safeAccent(primary: unknown): string {
  return typeof primary === 'string' && HEX.test(primary.trim())
    ? primary.trim()
    : DEFAULT_ACCENT;
}

/**
 * Same reasoning for the logo. Only http(s) and data: images are rendered;
 * anything else falls back to the initials block.
 */
export function safeLogoUrl(logoUrl: unknown): string | null {
  if (typeof logoUrl !== 'string' || !logoUrl.trim()) return null;
  try {
    const parsed = new URL(logoUrl, window.location.origin);
    return ['http:', 'https:', 'data:'].includes(parsed.protocol) ? logoUrl : null;
  } catch {
    return null;
  }
}

function expandHex(hex: string): [number, number, number] {
  const raw = hex.slice(1);
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw.slice(0, 6);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * Relative luminance, so text on an accent-filled surface stays readable
 * whether the tenant picked oxblood or mustard. CLAUDE.md: on dark backgrounds
 * text is off-white or accent, never grey-on-grey — this is the accent-filled
 * half of that rule.
 */
export function inkOn(accent: string): string {
  const [r, g, b] = expandHex(accent).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? INK_DARK : INK_LIGHT;
}

/** Initials for a tenant with no logo. "Demo Butchery" -> "DB". */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * Writes the tenant's accent onto the document. Call it once the tenant
 * resolves, and again if it changes (the tenant picker).
 */
export function applyBranding(branding: TenantBranding | null | undefined): void {
  const accent = safeAccent(branding?.primary);
  const root = document.documentElement;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-ink', inkOn(accent));
}
