import type { CellReading } from '@robolime/shared';

import { NEAR_TARGET_CUTOFF, NEAR_TARGET_CUTOFF_IS_PLACEHOLDER, PH_BAND_PLACEHOLDER_NOTE, PH_TARGET, phBand } from '../config/phBands';
import { buildFieldMap, buildLimeSummary, buildRunTiles, cellLabel, latestPerCell, shownPh } from './fieldView';

/** D54: pH bands, field map layout, the needed-lime summary and the run tiles. */
const r = (cellIndex: number, seq: number, ph: number, dose: number, expected: number | null = null): CellReading => ({
  runId: 'run', runType: 'dosing', cellIndex, seq, attemptCount: 1, ph, ec: 0.3, moisturePercent: 25, temperatureC: 27,
  doseVolumeMl: dose, expectedPostCorrectionPh: expected, gps: null, rawFlags: 0,
  timestamps: { robotAt: '2026-01-15T00:00:00Z', gatewayReceivedAt: null, cloudSyncedAt: null },
});

describe('pH bands', () => {
  it('splits at the placeholder cut-off and the confirmed target, inclusive at each lower edge', () => {
    expect(PH_TARGET).toBe(6);
    expect(NEAR_TARGET_CUTOFF_IS_PLACEHOLDER).toBe(true);
    expect(phBand(5.49)).toBe('too-acidic');
    expect(phBand(NEAR_TARGET_CUTOFF)).toBe('near-target');
    expect(phBand(5.99)).toBe('near-target');
    expect(phBand(6)).toBe('at-target');
    expect(PH_BAND_PLACEHOLDER_NOTE).toMatch(/placeholder/);
  });
});

describe('field view', () => {
  it('labels cells 1-based and keeps the latest record per cell', () => {
    expect(cellLabel(0)).toBe('C1');
    const latest = latestPerCell([r(2, 0, 5, 0), r(2, 1, 5.3, 50), r(0, 0, 6.1, 0)]);
    expect(latest.get(2)?.seq).toBe(1);
    expect(latest.size).toBe(2);
  });

  it('lays out a placeholder 5-column grid without a provisioned field, and marks the next cell', () => {
    const map = buildFieldMap({ field: null, cells: [], readings: [r(0, 0, 4.6, 50)], mode: 'measured', nextCellIndex: 1 });
    expect(map.placeholderLayout).toBe(true);
    expect([map.rows, map.columns, map.cells.length]).toEqual([4, 5, 20]);
    expect(map.cells[0]).toMatchObject({ label: 'C1', valueText: '4.60', band: 'too-acidic', limed: true, isNext: false });
    expect(map.cells[1]).toMatchObject({ label: 'C2', band: null, isNext: true });
  });

  it('uses surveyed grid positions when the field provides them', () => {
    const map = buildFieldMap({
      field: null,
      cells: [{ cellIndex: 0, gridRow: 1, gridColumn: 0, center: null }, { cellIndex: 1, gridRow: 0, gridColumn: 0, center: null }],
      readings: [], mode: 'measured', nextCellIndex: null,
    });
    expect(map.placeholderLayout).toBe(false);
    expect(map.cells.map((c) => [c.label, c.row, c.column])).toEqual([['C1', 1, 0], ['C2', 0, 0]]);
  });

  it('shows expected-after-lime pH only for limed cells with an expected value', () => {
    expect(shownPh(r(0, 0, 5.2, 100, 6), 'expected')).toBe(6);
    expect(shownPh(r(0, 0, 5.2, 0, 6), 'expected')).toBe(5.2);
    expect(shownPh(r(0, 0, 5.2, 100, null), 'expected')).toBe(5.2);
    expect(shownPh(r(0, 0, 5.2, 100, 6), 'measured')).toBe(5.2);
  });

  it('summarises needed lime from the records, never inventing counts', () => {
    expect(buildLimeSummary([], 20).headline).toBe('No cells measured yet');
    const s = buildLimeSummary([r(0, 0, 5, 50), r(1, 0, 6.2, 0), r(2, 0, 5.5, 25)], 20);
    expect(s.headline).toBe('2 of 3 measured cells needed lime');
    expect(s.detail).toBe('17 cells left · cells fill in as the robot reports');
    expect(buildLimeSummary([r(0, 0, 5, 50)], null).detail).toBe('Cells fill in as the robot reports');
  });

  it('computes run tiles from the latest record per cell', () => {
    const t = buildRunTiles([r(0, 0, 5.0, 100, 6.0), r(1, 0, 6.2, 0), r(2, 0, 5.4, 50, 5.9), r(2, 1, 5.5, 60, 6.1)], 20);
    expect(t).toEqual({ cellsLimed: '2', cellsLimedOf: 'of 20', limeCommanded: '160 mL', medianMeasured: '5.50', medianExpected: '6.10' });
  });
});
