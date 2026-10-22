/** ISO 8601 date-time string with an explicit offset, e.g. "2026-10-23T08:15:00Z". */
export type IsoDateTime = string;

/**
 * The three clocks a record can carry. They answer different questions and
 * must never be conflated:
 * - robotAt: when the robot measured/reported — the only user-facing time.
 * - gatewayReceivedAt: when the laptop gateway durably stored the record.
 * - cloudSyncedAt: when hosted Supabase confirmed persistence; null until then.
 */
export interface RobotTimestamps {
  robotAt: IsoDateTime;
  gatewayReceivedAt: IsoDateTime | null;
  cloudSyncedAt: IsoDateTime | null;
}
