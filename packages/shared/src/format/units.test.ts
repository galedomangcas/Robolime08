import { describe, expect, it } from 'vitest';
import {
  MISSING_VALUE,
  formatEc,
  formatMoisturePercent,
  formatPh,
  formatTemperatureC,
  formatVoltage,
  formatVolumeMl,
} from './units';

describe('formatPh', () => {
  it('always shows two decimals', () => {
    expect(formatPh(6)).toBe('6.00');
    expect(formatPh(5.5)).toBe('5.50');
    expect(formatPh(4.567)).toBe('4.57');
    expect(formatPh(0)).toBe('0.00');
  });

  it('shows the missing placeholder instead of a number for absent values', () => {
    expect(formatPh(null)).toBe(MISSING_VALUE);
    expect(formatPh(undefined)).toBe(MISSING_VALUE);
    expect(formatPh(Number.NaN)).toBe(MISSING_VALUE);
    expect(formatPh(Number.POSITIVE_INFINITY)).toBe(MISSING_VALUE);
  });
});

describe('metric formatters', () => {
  it('formats temperature in °C with one decimal', () => {
    expect(formatTemperatureC(27.46)).toBe('27.5 °C');
    expect(formatTemperatureC(-1)).toBe('-1.0 °C');
  });

  it('formats moisture as a percentage', () => {
    expect(formatMoisturePercent(34.25)).toBe('34.3%');
  });

  it('formats volumes in mL with thousands separators', () => {
    expect(formatVolumeMl(1250)).toBe('1,250 mL');
    expect(formatVolumeMl(0)).toBe('0 mL');
    expect(formatVolumeMl(12.5, 1)).toBe('12.5 mL');
    expect(formatVolumeMl(1234567)).toBe('1,234,567 mL');
  });

  it('formats battery voltage with two decimals', () => {
    expect(formatVoltage(12.4)).toBe('12.40 V');
  });

  it('formats EC using the explicitly supplied unit', () => {
    expect(formatEc(1520.4, 'µS/cm')).toBe('1,520 µS/cm');
    expect(formatEc(1.5204, 'dS/m')).toBe('1.52 dS/m');
    expect(formatEc(1.5204, 'mS/cm')).toBe('1.52 mS/cm');
  });

  it('never fabricates values for missing measurements', () => {
    expect(formatTemperatureC(null)).toBe(MISSING_VALUE);
    expect(formatMoisturePercent(undefined)).toBe(MISSING_VALUE);
    expect(formatVolumeMl(Number.NaN)).toBe(MISSING_VALUE);
    expect(formatVoltage(null)).toBe(MISSING_VALUE);
    expect(formatEc(null, 'dS/m')).toBe(MISSING_VALUE);
  });
});
