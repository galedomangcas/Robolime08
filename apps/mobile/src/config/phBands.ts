/**
 * pH map bands (CLAUDE.md §4 Screen 3, D54). Central configuration so no
 * screen hard-codes a boundary.
 * - Target pH 6.00 is the confirmed agronomic target.
 * - The "near target" lower cut-off 5.50 is a DEMO PLACEHOLDER: it is not in any
 *   approved rule configuration (OPEN_ITEMS #4). Every place that shows the
 *   bands says so. Replace this value when the research team confirms it.
 */
export const PH_TARGET = 6.0;
export const NEAR_TARGET_CUTOFF = 5.5;
export const NEAR_TARGET_CUTOFF_IS_PLACEHOLDER = true;

export type PhBand = 'too-acidic' | 'near-target' | 'at-target';

export function phBand(ph: number): PhBand {
  if (ph >= PH_TARGET) return 'at-target';
  if (ph >= NEAR_TARGET_CUTOFF) return 'near-target';
  return 'too-acidic';
}

export const PH_BAND_LABEL: Record<PhBand, string> = {
  'too-acidic': 'Too acidic',
  'near-target': 'Near target',
  'at-target': 'At target',
};

/** Legend ranges, e.g. "below 5.50", "5.50–5.99", "6.00 and up". */
export const PH_BAND_RANGE: Record<PhBand, string> = {
  'too-acidic': `below ${NEAR_TARGET_CUTOFF.toFixed(2)}`,
  'near-target': `${NEAR_TARGET_CUTOFF.toFixed(2)}–${(PH_TARGET - 0.01).toFixed(2)}`,
  'at-target': `${PH_TARGET.toFixed(2)} and up`,
};

export const PH_BAND_PLACEHOLDER_NOTE = `Target pH ${PH_TARGET.toFixed(2)} · near-target cut-off ${NEAR_TARGET_CUTOFF.toFixed(2)} is a placeholder`;
