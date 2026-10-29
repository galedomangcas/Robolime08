/**
 * Provisional app-side timings (decision D33). They only change how quickly the
 * screen notices new data or a dead connection. They do not change radio
 * timing or the gateway's own request timeout (15 s), and should be revisited
 * once the time per cell is measured (OPEN_ITEMS #3).
 */

/** Abort a gateway request after this long; below the gateway's 15 s timeout so the app reports first. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Wait this long after one status request FINISHES before starting the next (never overlapping). */
export const STATUS_POLL_INTERVAL_MS = 10_000;

/** Manual control tab (D57): refresh the bridge connection and log this often while the tab is open. Laptop-local request only. */
export const MANUAL_STATUS_POLL_MS = 2_000;

/** Re-render the "x s ago" age labels this often. Local only: no network request. */
export const AGE_REFRESH_MS = 1_000;
