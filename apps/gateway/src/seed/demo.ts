import type { RecommendationInputs } from '@robolime/shared';

import { withTransaction, type Database } from '../db/connection';
import { DatabasePurposeError, getDatabasePurpose } from '../db/init';
import { toCanonicalUtc } from '../db/time';
import { recordReading, type DecodedReading } from '../store/readings';
import { createDraftRuleSet, storeRecommendation, type RuleSetDefinition } from '../store/recommendations';
import { provisionField, provisionRobot } from '../store/robots';
import { recordStatusReport } from '../store/status';

/**
 * SYNTHETIC DEMO DATA — for development and UI work only.
 *
 * Nothing here was measured, nothing was collected in Calatagan, and none of
 * the crop/rule content is sourced. Values follow simple arithmetic patterns
 * so they are obviously fabricated and fully reproducible. GPS is omitted so
 * no real location is implied. No pairing credential is created: provision
 * one separately with `npm run pairing:provision`.
 *
 * The seeder only runs on a database initialised with purpose 'demo'.
 */
export const DEMO_SEED_VERSION = '1';
const SEED_KEY = 'demo_seed_version';

export const DEMO_SOURCE_ROBOT_ID = 'SYNTHETIC-DEMO-ROBOT';
export const DEMO_DOSING_RUN = 'SYNTHETIC-DOSING-0001';
export const DEMO_VERIFICATION_RUN = 'SYNTHETIC-VERIFY-0001';
const GRID_ROWS = 4;
const GRID_COLUMNS = 5;
const CELLS = GRID_ROWS * GRID_COLUMNS;

/** Fixed synthetic clock so every seed run produces identical rows. */
const DEMO_EPOCH = Date.parse('2026-01-15T00:00:00.000Z');
const at = (minutes: number) => new Date(DEMO_EPOCH + minutes * 60_000);

const round2 = (v: number) => Math.round(v * 100) / 100;

interface DemoCell {
  ph: number;
  doseVolumeMl: number;
  expectedPostCorrectionPh: number | null;
}

/** Fixture pattern per cell. Not derived from any agronomic model. */
function demoCell(i: number): DemoCell {
  const ph = round2(4.6 + ((i * 37) % 17) * 0.1);
  const limed = ph < 6;
  return {
    ph,
    doseVolumeMl: limed ? 50 + ((i * 11) % 5) * 25 : 0,
    expectedPostCorrectionPh: limed ? round2(5.8 + ((i * 3) % 4) * 0.1) : null,
  };
}

function dosingReading(i: number, attemptCount: number): DecodedReading {
  const cell = demoCell(i);
  return {
    sourceRobotId: DEMO_SOURCE_ROBOT_ID,
    sourceRunId: DEMO_DOSING_RUN,
    runType: 'dosing',
    cellIndex: i,
    seq: i,
    attemptCount,
    ph: cell.ph,
    ec: round2(0.2 + ((i * 13) % 7) * 0.05),
    moisturePercent: 20 + ((i * 7) % 15),
    temperatureC: round2(26 + (i % 5) * 0.4),
    doseVolumeMl: cell.doseVolumeMl,
    expectedPostCorrectionPh: cell.expectedPostCorrectionPh,
    gps: null,
    rawFlags: 0,
    robotRecordedAt: toCanonicalUtc(at(i * 3)),
  };
}

function verificationReading(i: number): DecodedReading {
  const cell = demoCell(i);
  const base = cell.expectedPostCorrectionPh ?? cell.ph;
  return {
    ...dosingReading(i, 1),
    sourceRunId: DEMO_VERIFICATION_RUN,
    runType: 'verification',
    ph: round2(base - 0.07 + ((i * 5) % 3) * 0.05),
    doseVolumeMl: 0,
    expectedPostCorrectionPh: null,
    // Placeholder flag value for the fixture only; real flag bits await the packet spec.
    rawFlags: 0,
    robotRecordedAt: toCanonicalUtc(at(7 * 24 * 60 + i * 3)),
  };
}

const SYNTHETIC_REF = 'SYNTHETIC FIXTURE — not from any source';

export const DEMO_RULE_SET: RuleSetDefinition = {
  version: 'synthetic-dev-0001',
  scoringMethod: 'unverified-dev-fixture-v0',
  isSynthetic: true,
  sourceNotes:
    'SYNTHETIC DEVELOPMENT FIXTURE. No crop, range, season, or weather value here is sourced. ' +
    'It can never be approved and must never be presented as a scientific recommendation.',
  crops: ['A', 'B', 'C', 'D', 'E', 'F'].map((letter, index) => ({
    cropKey: `synthetic-crop-${letter.toLowerCase()}`,
    displayName: `Synthetic crop ${letter} (fixture)`,
    category: `Synthetic category ${index + 1}`,
    cultivationReference: SYNTHETIC_REF,
    ranges: [
      {
        parameter: 'ph',
        minValue: round2(5 + index * 0.1),
        maxValue: round2(6.5 + index * 0.1),
        unit: 'pH',
        weight: 1,
        sourceReference: SYNTHETIC_REF,
      },
    ],
  })),
  seasons: [
    { seasonKey: 'synthetic-season-1', label: 'Synthetic season 1 (fixture)', startMonth: 1, startDay: 1, endMonth: 6, endDay: 30 },
    { seasonKey: 'synthetic-season-2', label: 'Synthetic season 2 (fixture)', startMonth: 7, startDay: 1, endMonth: 12, endDay: 31 },
  ].map((season) => ({
    ...season,
    weatherDefaults: [{ parameter: 'precipitation', value: 100, unit: 'mm/month', sourceReference: SYNTHETIC_REF }],
  })),
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/**
 * Seeds the synthetic demo dataset once. Returns false (and changes nothing)
 * if this seed version is already present. Refuses non-demo databases.
 */
export function seedDemo(db: Database): boolean {
  const purpose = getDatabasePurpose(db);
  if (purpose !== 'demo') {
    throw new DatabasePurposeError(
      `Refusing to seed synthetic demo data into a '${purpose ?? 'uninitialised'}' database. Use a separate demo database.`,
    );
  }
  return withTransaction(db, () => {
    if (db.prepare('SELECT 1 FROM gateway_settings WHERE key = ?').get(SEED_KEY)) {
      return false;
    }
    const robot = provisionRobot(
      db,
      { sourceRobotId: DEMO_SOURCE_ROBOT_ID, displayName: 'Synthetic demo robot (not real hardware)', isSynthetic: true },
      at(-60),
    );
    provisionField(
      db,
      {
        robotId: robot.id,
        fieldKey: 'synthetic-demo-field',
        name: 'Synthetic demo field',
        locationLabel: 'Synthetic data — not a real location',
        areaSquareMeters: CELLS * 4,
        cellSizeMeters: 2,
        totalCells: CELLS,
        cells: Array.from({ length: CELLS }, (_, i) => ({
          cellIndex: i,
          gridRow: Math.floor(i / GRID_COLUMNS),
          gridColumn: i % GRID_COLUMNS,
          center: null,
        })),
        isSynthetic: true,
      },
      at(-60),
    );

    recordStatusReport(
      db,
      {
        sourceRobotId: DEMO_SOURCE_ROBOT_ID, state: 'IDLE', errorFlags: 0, componentFlags: null,
        batteryVoltage: 12.6, totalLimeCommandedMl: 0, cellsCompleted: 0, totalCells: CELLS,
        robotReportedAt: toCanonicalUtc(at(-1)),
      },
      at(-1),
    );

    let limeTotal = 0;
    for (let i = 0; i < CELLS; i++) {
      // Cells 3 and 11 arrive on a second attempt; cell 5's ACK is "lost" so it is re-sent.
      const attempt = i === 3 || i === 11 ? 2 : 1;
      recordReading(db, dosingReading(i, attempt), new Date(at(i * 3).getTime() + 2000));
      if (i === 5) {
        recordReading(db, dosingReading(i, 2), new Date(at(i * 3).getTime() + 32_000));
      }
      limeTotal += demoCell(i).doseVolumeMl;
      if (i === CELLS / 2 - 1 || i === CELLS - 1) {
        const done = i === CELLS - 1;
        recordStatusReport(
          db,
          {
            sourceRobotId: DEMO_SOURCE_ROBOT_ID, state: done ? 'COMPLETED' : 'WORKING', errorFlags: 0,
            componentFlags: null, batteryVoltage: done ? 12.1 : 12.4, totalLimeCommandedMl: limeTotal,
            cellsCompleted: i + 1, totalCells: CELLS, robotReportedAt: toCanonicalUtc(at(i * 3 + 1)),
          },
          at(i * 3 + 1),
        );
      }
    }

    // Verification run deliberately lacks the last cell to exercise missing-pair reporting.
    for (let i = 0; i < CELLS - 1; i++) {
      recordReading(db, verificationReading(i), new Date(at(7 * 24 * 60 + i * 3).getTime() + 2000));
    }

    const ruleSetId = createDraftRuleSet(db, DEMO_RULE_SET, at(-120));
    const runRow = db.prepare('SELECT id FROM runs WHERE source_run_id = ?').get(DEMO_DOSING_RUN);
    const runId = typeof runRow?.id === 'string' ? runRow.id : '';
    const cells = Array.from({ length: CELLS }, (_, i) => dosingReading(i, 1));
    const inputs: RecommendationInputs = {
      medianPh: round2(median(cells.map((c) => c.expectedPostCorrectionPh ?? c.ph))),
      medianEc: round2(median(cells.map((c) => c.ec))),
      medianMoisturePercent: round2(median(cells.map((c) => c.moisturePercent))),
      medianTemperatureC: round2(median(cells.map((c) => c.temperatureC))),
      season: 'synthetic-season-1',
      weatherSource: 'seasonal-defaults',
      weather: { precipitation: 100 },
    };
    const reasons = ['SYNTHETIC FIXTURE — not a scientific recommendation.', 'Fixture score; no sourced suitability range.'];
    storeRecommendation(db, {
      runId,
      ruleSetId,
      inputs,
      scores: [82, 76, 71, 64, 58, 40].map((score, index) => ({
        cropId: DEMO_RULE_SET.crops[index]?.cropKey ?? '',
        score,
        reasons,
        shortlistRank: index < 5 ? index + 1 : null,
      })),
      computedAt: at(CELLS * 3 + 10),
    });

    db.prepare('INSERT INTO gateway_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      SEED_KEY,
      DEMO_SEED_VERSION,
      toCanonicalUtc(at(CELLS * 3 + 10)),
    );
    return true;
  });
}
