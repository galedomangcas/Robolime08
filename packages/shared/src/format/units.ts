/** Placeholder shown wherever a value is missing. Never substitute a fabricated number. */
export const MISSING_VALUE = '—';

/**
 * Candidate EC display units. Which one the probe reports is not yet
 * confirmed (OPEN_ITEMS: EC unit), so callers must pass it explicitly.
 */
export type EcUnit = 'µS/cm' | 'mS/cm' | 'dS/m';

function isPresent(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Fixed decimals with comma thousands separators, independent of device locale. */
function formatNumber(value: number, decimals: number): string {
  const [integerPart = '', fractionPart] = value.toFixed(decimals).split('.');
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fractionPart === undefined ? grouped : `${grouped}.${fractionPart}`;
}

function formatWithUnit(
  value: number | null | undefined,
  decimals: number,
  unit: string,
): string {
  return isPresent(value) ? `${formatNumber(value, decimals)} ${unit}` : MISSING_VALUE;
}

/** pH is always shown to two decimal places, e.g. "6.00". */
export function formatPh(value: number | null | undefined): string {
  return isPresent(value) ? value.toFixed(2) : MISSING_VALUE;
}

export function formatTemperatureC(value: number | null | undefined): string {
  return formatWithUnit(value, 1, '°C');
}

export function formatMoisturePercent(value: number | null | undefined): string {
  return isPresent(value) ? `${formatNumber(value, 1)}%` : MISSING_VALUE;
}

/** Volumes in millilitres, e.g. "1,250 mL". */
export function formatVolumeMl(value: number | null | undefined, decimals = 0): string {
  return formatWithUnit(value, decimals, 'mL');
}

export function formatVoltage(value: number | null | undefined): string {
  return formatWithUnit(value, 2, 'V');
}

export function formatEc(value: number | null | undefined, unit: EcUnit): string {
  return formatWithUnit(value, unit === 'µS/cm' ? 0 : 2, unit);
}
