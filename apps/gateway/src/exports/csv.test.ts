import { describe, expect, it } from 'vitest';

import { parseCsv } from '../test/csv';
import { CsvError, csvField, neutralizeFormula, toCsv } from './csv';

describe('CSV writer (RFC 4180)', () => {
  it('quotes only fields with a comma, quote, CR or LF, and doubles quotes', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
    expect(csvField('cr\rhere')).toBe('"cr\rhere"');
    expect(csvField('pH 6.00 — ñ, ü, 土壌')).toBe('"pH 6.00 — ñ, ü, 土壌"');
    expect(csvField('土壌')).toBe('土壌');
  });

  it('writes missing values as empty fields, booleans as true/false, and refuses non-finite numbers', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(true)).toBe('true');
    expect(csvField(false)).toBe('false');
    expect(csvField(0)).toBe('0');
    expect(csvField(-12.25)).toBe('-12.25');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(() => csvField(bad)).toThrow(CsvError);
  });

  it('ends every record with CRLF and round-trips awkward values exactly', () => {
    const values = ['a,b', 'quote " inside', 'multi\r\nline', '', 'ü土壌'];
    const csv = toCsv(['x', 'y', 'z', 'w', 'v'], [values, [null, 1, true, 'plain', '']]);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(parseCsv(csv)).toEqual([['x', 'y', 'z', 'w', 'v'], values, ['', '1', 'true', 'plain', '']]);
  });

  it('neutralizes text starting with a formula trigger (=, +, -, @) by prefixing a single quote', () => {
    for (const text of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '=HYPERLINK("http://example.invalid","x")']) {
      expect(neutralizeFormula(text), text).toBe(`'${text}`);
    }
  });

  it('also neutralizes triggers hidden behind whitespace or control characters, and a leading tab or CR', () => {
    for (const text of [' =1', '   +1', '\t=1', '\r=1', '\n=1', '\u0000=1', '\u00a0@x', '\ufeff=1', '\u200b-1', '\tplain', '\rplain']) {
      expect(neutralizeFormula(text), JSON.stringify(text)).toBe(`'${text}`);
    }
  });

  it('leaves ordinary text and identifiers readable and unchanged', () => {
    for (const text of ['RUN-1', 'SYNTHETIC-DOSING-0001', 'TEST-ROBOT-1', 'a=b', 'pH 6.00', '2026-03-01T00:00:00.000Z', 'ü土壌', '', ' leading space', "it's"]) {
      expect(neutralizeFormula(text), text).toBe(text);
    }
  });

  it('never changes numbers, booleans or missing values: a negative number stays numeric', () => {
    expect(csvField(-2.5)).toBe('-2.5');
    expect(csvField(-0.01)).toBe('-0.01');
    expect(csvField(0)).toBe('0');
    expect(csvField(true)).toBe('true');
    expect(csvField(null)).toBe('');
    expect(csvField('-2.5')).toBe("'-2.5"); // the same characters as text are neutralized
  });

  it('applies quoting after neutralization, so escaping, CRLF and Unicode still round-trip', () => {
    const tricky = ['=1,2', '@"quoted"', '-multi\r\nline', '+ü土壌', 'safe,"text"'];
    const csv = toCsv(['a', 'b', 'c', 'd', 'e'], [tricky, [null, -3, false, '', '=']]);
    // The quoted field keeps its own CRLF, so the physical line ends inside it.
    expect(csv.split('\r\n')[1]).toBe(`"'=1,2","'@""quoted""","'-multi`);
    expect(parseCsv(csv)).toEqual([
      ['a', 'b', 'c', 'd', 'e'],
      ["'=1,2", "'@\"quoted\"", "'-multi\r\nline", "'+ü土壌", 'safe,"text"'],
      ['', '-3', 'false', '', "'="],
    ]);
  });

  it('refuses a row whose length does not match the header', () => {
    expect(() => toCsv(['a', 'b'], [['only one']])).toThrow(/Row 1 has 1 values but the header has 2 columns/);
  });
});
