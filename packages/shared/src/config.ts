/**
 * Central display/behaviour configuration shared by the app and gateway.
 *
 * Values here are either confirmed requirements or explicitly provisional.
 * Provisional values are tracked in docs/OPEN_ITEMS.md — do not treat them
 * as final.
 */

/** Agronomic target pH (confirmed requirement). */
export const TARGET_PH = 6.0;

/**
 * Age after which robot telemetry is shown as stale.
 * PROVISIONAL: 240 s pending re-check against measured time per cell
 * (OPEN_ITEMS: stale threshold).
 */
export const STALE_THRESHOLD_SECONDS = 240;

/** Field grid cell edge length in metres (confirmed: 2 m × 2 m cells). */
export const CELL_SIZE_METERS = 2;
