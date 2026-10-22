import type { RobotTimestamps } from './time';

/**
 * A dosing run treats the field; a verification run remeasures it afterwards.
 * Verification data is research-only and never shown on farmer-facing screens.
 */
export type RunType = 'dosing' | 'verification';

export interface GpsFix {
  latitude: number;
  longitude: number;
}

/**
 * One decoded cell reading record. Unique key: (runId, cellIndex, seq).
 *
 * Units: pH (unitless), moisture %, temperature °C, volume mL. The EC unit is
 * not yet confirmed by the hardware team (OPEN_ITEMS: EC unit), so `ec` is
 * stored as the raw sensor value and its unit is supplied at display time.
 */
export interface CellReading {
  runId: string;
  runType: RunType;
  cellIndex: number;
  seq: number;
  attemptCount: number;
  ph: number;
  ec: number;
  moisturePercent: number;
  temperatureC: number;
  /** Commanded lime volume for this cell, in mL. */
  doseVolumeMl: number;
  /** Robot-calculated expected post-correction pH; null if not reported. */
  expectedPostCorrectionPh: number | null;
  /** Null when the robot had no GPS fix. Map placement uses cellIndex, not GPS. */
  gps: GpsFix | null;
  /** Undecoded flags field, preserved for research exports. */
  rawFlags: number;
  timestamps: RobotTimestamps;
}
