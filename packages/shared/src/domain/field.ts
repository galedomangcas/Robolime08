import type { IsoDateTime } from './time';

export interface Field {
  id: string;
  name: string;
  locationLabel: string;
  areaSquareMeters: number;
  totalCells: number;
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
