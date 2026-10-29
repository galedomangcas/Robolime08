import { formatPh, formatVolumeMl, type CellReading, type Field, type FieldCell } from '@robolime/shared';

import { phBand, type PhBand } from '../config/phBands';

/**
 * Pure view logic for the field map, the "needed lime" summary and the run
 * tiles (D54; mockup pages 3–5). Readings are placed by CELL INDEX, never by
 * GPS (GPS error is about one cell). Displayed cell numbers are 1-based
 * (C1 = cell index 0); exports keep the raw `cell_index`.
 */
export const cellLabel = (cellIndex: number) => `C${cellIndex + 1}`;

/** Columns used when the field has no surveyed grid positions (demo layout). */
export const PLACEHOLDER_COLUMNS = 5;
/** Grid shown when no field is provisioned: a clearly labelled placeholder. */
export const PLACEHOLDER_CELL_COUNT = 20;

/** The latest record per cell (highest seq; retries of a cell share the index). */
export function latestPerCell(readings: readonly CellReading[]): Map<number, CellReading> {
  const out = new Map<number, CellReading>();
  for (const r of readings) {
    const prev = out.get(r.cellIndex);
    if (prev === undefined || r.seq > prev.seq) out.set(r.cellIndex, r);
  }
  return out;
}

export type MapMode = 'measured' | 'expected';

export interface MapCell {
  cellIndex: number;
  label: string;
  row: number;
  column: number;
  reading: CellReading | null;
  /** The value shown (measured pH, or expected-after-lime pH), if any. */
  value: number | null;
  valueText: string | null;
  band: PhBand | null;
  limed: boolean;
  /** Next cell, assuming the robot visits cells in number order (placeholder). */
  isNext: boolean;
}

export interface FieldMapView {
  cells: MapCell[];
  rows: number;
  columns: number;
  /** True when the layout is not from a provisioned field. */
  placeholderLayout: boolean;
  totalCells: number;
}

/** Expected pH after lime: the robot's expected value for limed cells, the measured pH otherwise. */
export function shownPh(reading: CellReading, mode: MapMode): number {
  if (mode === 'expected' && reading.doseVolumeMl > 0 && reading.expectedPostCorrectionPh !== null) return reading.expectedPostCorrectionPh;
  return reading.ph;
}

export function buildFieldMap(input: {
  field: Field | null;
  cells: readonly FieldCell[];
  readings: readonly CellReading[];
  mode: MapMode;
  /** From the latest status while WORKING; null otherwise. */
  nextCellIndex: number | null;
}): FieldMapView {
  const latest = latestPerCell(input.readings);
  const placeholderLayout = input.cells.length === 0;
  const total = placeholderLayout
    ? Math.max(input.field?.totalCells ?? PLACEHOLDER_CELL_COUNT, latest.size === 0 ? 0 : Math.max(...latest.keys()) + 1)
    : input.cells.length;
  const defs: { cellIndex: number; row: number; column: number }[] = placeholderLayout
    ? Array.from({ length: total }, (_, i) => ({ cellIndex: i, row: Math.floor(i / PLACEHOLDER_COLUMNS), column: i % PLACEHOLDER_COLUMNS }))
    : [...input.cells]
        .sort((a, b) => a.cellIndex - b.cellIndex)
        .map((c, i) => ({
          cellIndex: c.cellIndex,
          row: c.gridRow ?? Math.floor(i / PLACEHOLDER_COLUMNS),
          column: c.gridColumn ?? i % PLACEHOLDER_COLUMNS,
        }));
  const cells = defs.map((d): MapCell => {
    const reading = latest.get(d.cellIndex) ?? null;
    const value = reading === null ? null : shownPh(reading, input.mode);
    return {
      ...d,
      label: cellLabel(d.cellIndex),
      reading,
      value,
      valueText: value === null ? null : formatPh(value),
      band: value === null ? null : phBand(value),
      limed: reading !== null && reading.doseVolumeMl > 0,
      isNext: reading === null && input.nextCellIndex === d.cellIndex,
    };
  });
  const rows = cells.reduce((m, c) => Math.max(m, c.row + 1), 0);
  const columns = cells.reduce((m, c) => Math.max(m, c.column + 1), 0);
  return { cells, rows, columns, placeholderLayout, totalCells: total };
}

export interface LimeSummary {
  measured: number;
  limed: number;
  remaining: number | null;
  headline: string;
  detail: string;
}

/** "6 of 7 measured cells needed lime · 13 cells left", computed from the records. */
export function buildLimeSummary(readings: readonly CellReading[], totalCells: number | null): LimeSummary {
  const latest = [...latestPerCell(readings).values()];
  const limed = latest.filter((r) => r.doseVolumeMl > 0).length;
  const remaining = totalCells === null ? null : Math.max(0, totalCells - latest.length);
  if (latest.length === 0) {
    return { measured: 0, limed: 0, remaining, headline: 'No cells measured yet', detail: 'Cells fill in as the robot reports' };
  }
  return {
    measured: latest.length,
    limed,
    remaining,
    headline: `${limed} of ${latest.length} measured cell${latest.length === 1 ? '' : 's'} needed lime`,
    detail: remaining === null ? 'Cells fill in as the robot reports' : `${remaining} cell${remaining === 1 ? '' : 's'} left · cells fill in as the robot reports`,
  };
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

export interface RunTiles {
  cellsLimed: string;
  cellsLimedOf: string;
  limeCommanded: string;
  medianMeasured: string;
  medianExpected: string;
}

/** The four run tiles of mockup page 5, from the latest record per cell. */
export function buildRunTiles(readings: readonly CellReading[], totalCells: number | null): RunTiles {
  const latest = [...latestPerCell(readings).values()];
  const limed = latest.filter((r) => r.doseVolumeMl > 0);
  const measured = median(latest.map((r) => r.ph));
  const expected = median(latest.map((r) => shownPh(r, 'expected')));
  return {
    cellsLimed: String(limed.length),
    cellsLimedOf: `of ${totalCells ?? latest.length}`,
    limeCommanded: formatVolumeMl(latest.reduce((s, r) => s + r.doseVolumeMl, 0)),
    medianMeasured: measured === null ? '—' : formatPh(measured),
    medianExpected: expected === null ? '—' : formatPh(expected),
  };
}
