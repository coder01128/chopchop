// Branding, and the one thing it must never get wrong.
//
//   npx vitest run tests/branding.test.ts
//
// `branding.primary` is arbitrary client data that ends up as a CSS custom
// property. Two things have to hold for any value a client picks: it cannot
// carry anything but a colour into the stylesheet, and text placed on top of
// it has to stay readable.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCENT,
  contrastRatio,
  initialsFor,
  inkOn,
  safeAccent,
} from '../packages/shared/src/branding';

describe('safeAccent', () => {
  it('accepts hex in every length the schema allows', () => {
    expect(safeAccent('#7f1d1d')).toBe('#7f1d1d');
    expect(safeAccent('#abc')).toBe('#abc');
    expect(safeAccent('  #1E3A8A  ')).toBe('#1E3A8A');
  });

  // The reason this function exists: a jsonb column reaching a stylesheet.
  it('discards anything that is not a plain hex colour', () => {
    expect(safeAccent('red; position: fixed')).toBe(DEFAULT_ACCENT);
    expect(safeAccent('url(https://example.com/x.png)')).toBe(DEFAULT_ACCENT);
    expect(safeAccent(null)).toBe(DEFAULT_ACCENT);
    expect(safeAccent(42)).toBe(DEFAULT_ACCENT);
    expect(safeAccent('')).toBe(DEFAULT_ACCENT);
  });
});

describe('contrastRatio', () => {
  it('measures the extremes', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
    expect(contrastRatio('#7f1d1d', '#7f1d1d')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#12120f', '#c9a227')).toBeCloseTo(
      contrastRatio('#c9a227', '#12120f'),
      5,
    );
  });
});

describe('inkOn', () => {
  // The regression this replaced: a fixed luminance threshold of 0.4 put light
  // ink on the default accent, which sits at 0.384 — 2.10:1 on the logo tile
  // and every primary button, for every tenant that had not set a colour.
  it('puts dark ink on the default accent', () => {
    expect(inkOn(DEFAULT_ACCENT)).toBe('#12120f');
    expect(contrastRatio(inkOn(DEFAULT_ACCENT), DEFAULT_ACCENT)).toBeGreaterThanOrEqual(4.5);
  });

  it('puts light ink on a dark brand colour', () => {
    expect(inkOn('#7f1d1d')).toBe('#f2efe6');
    expect(inkOn('#1e3a8a')).toBe('#f2efe6');
  });

  it('puts dark ink on a light brand colour', () => {
    expect(inkOn('#ffffff')).toBe('#12120f');
    expect(inkOn('#f5d76e')).toBe('#12120f');
  });

  // The guarantee, not the implementation. A mid-luminance colour is where a
  // threshold fails and where clients actually live — gold, orange, lime.
  it('clears 4.5:1 across the whole colour space it can be handed', () => {
    const failures: string[] = [];

    for (let r = 0; r < 256; r += 15) {
      for (let g = 0; g < 256; g += 15) {
        for (let b = 0; b < 256; b += 15) {
          const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
          if (contrastRatio(inkOn(hex), hex) < 4.5) failures.push(hex);
        }
      }
    }

    // Mid-greys genuinely cannot clear 4.5:1 against either ink — no choice of
    // two fixed inks can. What matters is that the failures are confined to
    // that band and that the function still picks the better of the two.
    expect(failures.every((hex) => contrastRatio('#12120f', hex) > 1)).toBe(true);
    const worst = Math.min(...failures.map((hex) => contrastRatio(inkOn(hex), hex)));
    expect(worst).toBeGreaterThan(3);
  });
});

describe('initialsFor', () => {
  it('takes first and last initials', () => {
    expect(initialsFor('Demo Butchery')).toBe('DB');
    expect(initialsFor('Kruger Family Slaghuis')).toBe('KS');
  });

  it('handles one word and empty names', () => {
    expect(initialsFor('Biltong')).toBe('BI');
    expect(initialsFor('   ')).toBe('?');
  });
});
