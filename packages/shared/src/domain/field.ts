import type { GpsFix } from './reading';
import type { IsoDateTime } from './time';

/**
 * The deployment field. Geometry values (area, cell count, cell centres) are
 * provisioned by the operator from the real survey; nothing here is assumed.
 */
export interface Field {
  id: string;
  name: string;
  locationLabel: string;
  /** Null until the operator provisions the surveyed area. */
  areaSquareMeters: number | null;
  /** Cell edge length; the confirmed field design uses 2 m × 2 m cells. */
  cellSizeMeters: number;
  /** Null until the operator provisions the real cell count. */
  totalCells: number | null;
  /** True only for clearly labelled synthetic demo fixtures. */
  isSynthetic: boolean;
}

export interface FieldCell {
  cellIndex: number;
  gridRow: number | null;
  gridColumn: number | null;
  /** Surveyed cell centre, if provisioned. Readings are mapped by cellIndex, not GPS. */
  center: GpsFix | null;
}

/**
 * The user's confirmed choice of field for their next intended run.
 * This is a record of intent only: the robot never reads it, and field
 * profiles are preloaded on the robot before deployment.
 */
export interface FieldSelection {
  fieldId: string;
  confirmedAt: IsoDateTime;
}
