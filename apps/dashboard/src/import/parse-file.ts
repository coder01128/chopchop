import type { SheetTable } from './import-model';

/**
 * The parser, and the only file in this feature that knows what a spreadsheet
 * is.
 *
 * It runs in the browser: the file never leaves the seller's machine, there is
 * no upload, no Edge Function and no new secret. On a phone the same file input
 * opens the Files picker, which reaches Drive, Dropbox and anything saved out
 * of a WhatsApp chat.
 *
 * Everything downstream consumes `SheetTable` and knows nothing about this
 * file. Ticket 06B's vision extraction produces the same shape and enters at
 * the mapping step — that seam is the reason this module exports exactly one
 * function.
 */

export const ACCEPTED_FILE_TYPES = '.csv,.xlsx,.xls';

export async function parseFile(file: File): Promise<SheetTable> {
  // Loaded on demand. SheetJS is around 430 kB — half the dashboard bundle —
  // and a seller opening the order queue on their phone should not pay for a
  // spreadsheet parser they are not using. Vite splits it into its own chunk,
  // fetched the moment a file is chosen.
  const XLSX = await import('xlsx');

  const buffer = await file.arrayBuffer();

  // `raw: false` returns cells as the seller sees them, formatting included.
  // A price cell formatted as `R 89,50` must arrive as that text — parseNumber
  // handles the money, and a raw float would silently lose a currency symbol
  // the seller may have meant as a signal.
  const book = XLSX.read(buffer, { type: 'array', raw: false });

  const sheetName = book.SheetNames[0];
  if (!sheetName) throw new Error('That file has no sheets in it.');

  const sheet = book.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });

  if (grid.length === 0) throw new Error('That file is empty.');

  const [headerRow, ...rest] = grid;
  const headers = headerRow.map((cell) => String(cell ?? '').trim());

  // Trailing empty header columns are Excel's, not the seller's.
  let width = headers.length;
  while (width > 0 && headers[width - 1] === '') width -= 1;

  return {
    headers: headers.slice(0, width),
    rows: rest.map((row) =>
      Array.from({ length: width }, (_, index) => String(row[index] ?? '')),
    ),
  };
}

/** More than this and the review screen stops being reviewable. */
export const MAX_ROWS = 2000;
