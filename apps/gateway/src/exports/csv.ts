/**
 * Minimal RFC 4180 CSV writer for the research exports (decision D32).
 *
 * - Fields containing a comma, double quote, CR or LF are quoted, and quotes
 *   are doubled. Everything else is written as is (UTF-8, no BOM).
 * - Records end with CRLF, including the last one.
 * - A missing value is an empty field (`null` → ``); there is no other
 *   placeholder and no numeric default.
 * - Numbers must be finite; `NaN` or `Infinity` is a programming error.
 * - Spreadsheet formula injection: text that a spreadsheet could read as a
 *   formula is prefixed with a single quote (see `neutralizeFormula`). CSV
 *   quoting alone does not prevent this. Only `string` values are text:
 *   measurements and counts are numbers and are never altered.
 */
export type CsvValue = string | number | boolean | null;

export class CsvError extends Error {
  override name = 'CsvError';
}

/** Formula triggers, possibly after whitespace or control characters that spreadsheets may skip. */
const FORMULA_AFTER_PADDING = /^[\s\u0000-\u001f\u007f\u00a0\u200b\ufeff]*[=+\-@]/;
/** Tab and carriage return are themselves treated as formula triggers by some applications. */
const FORMULA_LEADING_CONTROL = /^[\t\r]/;

/**
 * Prefixes text that could be read as a spreadsheet formula with `'`, which
 * spreadsheet applications treat as "this cell is text". The original text
 * follows unchanged, so a reader can recover it by removing exactly one
 * leading `'`. Applied to every text field when writing; the database is not
 * changed. Not a guarantee for every application: it follows the common
 * OWASP guidance for Excel, LibreOffice and Google Sheets.
 */
export function neutralizeFormula(text: string): string {
  return FORMULA_AFTER_PADDING.test(text) || FORMULA_LEADING_CONTROL.test(text) ? `'${text}` : text;
}

export function csvField(value: CsvValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CsvError(`Cannot write the non-finite number ${String(value)} to CSV.`);
    return String(value);
  }
  const text = neutralizeFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [header.map(csvField).join(',')];
  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length) {
      throw new CsvError(`Row ${index + 1} has ${row.length} values but the header has ${header.length} columns.`);
    }
    lines.push(row.map(csvField).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
