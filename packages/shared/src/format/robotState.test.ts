import { describe, expect, it } from 'vitest';
import {
  cellProgress,
  decodeErrorFlags,
  robotStateFromCode,
  robotStateLabel,
  type RobotStateLabelInput,
} from './robotState';

const base: Omit<RobotStateLabelInput, 'state'> = {
  errorFlags: [],
  cellsCompleted: 0,
  totalCells: 0,
};

describe('robotStateFromCode', () => {
  it('maps every documented status byte', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(robotStateFromCode)).toEqual([
      'INITIALIZING',
      'IDLE',
      'WORKING',
      'PAUSED',
      'COMPLETED',
      'ERROR',
      'MANUAL',
    ]);
  });

  it('rejects undocumented codes', () => {
    expect(robotStateFromCode(7)).toBeNull();
    expect(robotStateFromCode(-1)).toBeNull();
    expect(robotStateFromCode(1.5)).toBeNull();
  });
});

describe('decodeErrorFlags', () => {
  it('returns no flags for zero', () => {
    expect(decodeErrorFlags(0)).toEqual([]);
  });

  it('decodes each documented bit', () => {
    expect(decodeErrorFlags(1 << 0)).toEqual(['LIME_EMPTY']);
    expect(decodeErrorFlags(1 << 3)).toEqual(['GPS_NO_FIX']);
    expect(decodeErrorFlags(1 << 7)).toEqual(['STORAGE_FAULT']);
  });

  it('decodes multiple bits in bit order', () => {
    expect(decodeErrorFlags(0b1000_0011)).toEqual([
      'LIME_EMPTY',
      'BATTERY_CRITICAL',
      'STORAGE_FAULT',
    ]);
    expect(decodeErrorFlags(0xff)).toHaveLength(8);
  });
});

describe('cellProgress', () => {
  it('computes whole-percent progress', () => {
    expect(cellProgress(7, 20)).toEqual({ completed: 7, total: 20, percent: 35 });
    expect(cellProgress(0, 40)).toEqual({ completed: 0, total: 40, percent: 0 });
    expect(cellProgress(40, 40)).toEqual({ completed: 40, total: 40, percent: 100 });
  });

  it('rounds down so an unfinished run never shows 100%', () => {
    expect(cellProgress(199, 200)?.percent).toBe(99);
    expect(cellProgress(1, 3)?.percent).toBe(33);
  });

  it('returns null for inconsistent counts', () => {
    expect(cellProgress(0, 0)).toBeNull();
    expect(cellProgress(5, 4)).toBeNull();
    expect(cellProgress(-1, 4)).toBeNull();
    expect(cellProgress(1.5, 4)).toBeNull();
  });
});

describe('robotStateLabel', () => {
  it('uses the required wording for each state', () => {
    expect(robotStateLabel({ ...base, state: 'INITIALIZING' })).toBe('Starting up');
    expect(robotStateLabel({ ...base, state: 'IDLE' })).toBe('Ready');
    expect(robotStateLabel({ ...base, state: 'PAUSED' })).toBe('Paused');
    expect(robotStateLabel({ ...base, state: 'COMPLETED' })).toBe('Run complete');
    expect(robotStateLabel({ ...base, state: 'MANUAL' })).toBe('Manual control');
  });

  it('shows cell-based progress while working', () => {
    expect(
      robotStateLabel({ ...base, state: 'WORKING', cellsCompleted: 7, totalCells: 20 }),
    ).toBe('Working: 7 of 20 cells (35%)');
  });

  it('does not show invented progress when counts are inconsistent', () => {
    expect(
      robotStateLabel({ ...base, state: 'WORKING', cellsCompleted: 3, totalCells: 0 }),
    ).toBe('Working (cell progress unavailable)');
  });

  it('includes the decoded error reasons', () => {
    expect(
      robotStateLabel({ ...base, state: 'ERROR', errorFlags: ['LIME_EMPTY', 'PUMP_FAULT'] }),
    ).toBe('Error: Lime tank empty, Pump fault');
    expect(robotStateLabel({ ...base, state: 'ERROR' })).toBe('Error: reason not reported');
  });
});
