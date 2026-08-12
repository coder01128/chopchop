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

/** WCAG relative luminance. */
function relativeLuminance(hex: string): number {
  const [r, g, b] = expandHex(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio between two hex colours, 1:1 to 21:1. */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Ink for text sitting ON an accent-filled surface — the logo tile, a primary
 * button — so it stays readable whether the tenant picked oxblood or mustard.
 *
 * It picks whichever of the two inks contrasts better, rather than testing
 * luminance against a fixed threshold. The threshold version chose light ink
 * for anything under 0.4, and the default accent #c9a227 sits at 0.384 — so
 * every tenant that had not set `branding.primary` got #f2efe6 on gold at
 * **2.10:1**, on their own logo tile and every primary button. Dark ink on the
 * same gold is 7.37:1. Any mid-luminance brand colour — gold, orange, lime —
 * landed in the same hole, and a threshold cannot be positioned to avoid it:
 * only comparing the two candidates can.
 */
export function inkOn(accent: string): string {
  return contrastRatio(INK_DARK, accent) >= contrastRatio(INK_LIGHT, accent)
    ? INK_DARK
    : INK_LIGHT;
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
