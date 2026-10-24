import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { initDatabase } from '../db/init';
import { recordReading } from '../store/readings';
import { addTestRobot, T0, tempDir, testReading } from '../test/helpers';
import { nodeFileOps, publishNewFile, type FileOps } from './atomicWrite';
import { runExport } from './exportCommand';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** An empty output folder in a temporary directory (synthetic test data only). */
function outDir() {
  const tmp = tempDir();
  cleanup = tmp.cleanup;
  const dir = tmp.path('out');
  mkdirSync(dir);
  return { tmp, dir, file: (name: string) => `${dir}/${name}` };
}

const failure = (code: string) => Object.assign(new Error(`simulated ${code}`), { code });

/** Real file operations with one step replaced. */
const ops = (overrides: Partial<FileOps>): FileOps => ({ ...nodeFileOps, ...overrides });

describe('publishNewFile: atomic, no-overwrite output', () => {
  it('publishes the exact content via a hard link and leaves no temporary file', () => {
    const { dir, file } = outDir();
    const result = publishNewFile(file('a.csv'), 'h1,h2\r\nü,"x,y"\r\n');
    expect(result).toEqual({ leftoverTempFile: null });
    expect(readFileSync(file('a.csv'), 'utf8')).toBe('h1,h2\r\nü,"x,y"\r\n');
    expect(readdirSync(dir)).toEqual(['a.csv']);
  });

  it('never overwrites an existing destination and cleans up its temporary file', () => {
    const { dir, file } = outDir();
    writeFileSync(file('a.csv'), 'someone else');
    expect(() => publishNewFile(file('a.csv'), 'new')).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(readFileSync(file('a.csv'), 'utf8')).toBe('someone else');
    expect(readdirSync(dir)).toEqual(['a.csv']);
  });

  it('a write that fails part-way leaves neither a final nor a temporary file', () => {
    const { dir, file } = outDir();
    const partialThenFail: FileOps['writeNewFile'] = (path, data) => {
      writeFileSync(path, data.slice(0, 3), { flag: 'wx' });
      throw failure('EIO');
    };
    expect(() => publishNewFile(file('a.csv'), 'complete content', ops({ writeNewFile: partialThenFail }))).toThrow('simulated EIO');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a failed publication step leaves no final file, removes the temporary file and keeps the original error', () => {
    const { dir, file } = outDir();
    expect(() => publishNewFile(file('a.csv'), 'data', ops({ link: () => { throw failure('EIO'); } }))).toThrow(
      expect.objectContaining({ code: 'EIO', message: expect.stringMatching(/^simulated EIO — nothing was written; /) }),
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'ENOSPC', 'EIO'])(
    'never falls back to a less protected write when the link fails with %s: nothing is published',
    (code) => {
      const { dir, file } = outDir();
      let writes = 0;
      const counting = ops({
        writeNewFile: (path, data) => {
          writes += 1;
          nodeFileOps.writeNewFile(path, data);
        },
        link: () => {
          throw failure(code);
        },
      });
      expect(() => publishNewFile(file('a.csv'), 'data', counting)).toThrow(
        expect.objectContaining({ code, message: expect.stringContaining('nothing was written; the output folder must allow creating hard links') }),
      );
      expect(writes).toBe(1); // only the temporary file — never a direct write to the destination
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it('a cleanup failure never hides the original error; it is noted in the message', () => {
    const { file } = outDir();
    const failing = ops({ link: () => { throw failure('EIO'); }, unlink: () => { throw failure('EBUSY'); } });
    expect(() => publishNewFile(file('a.csv'), 'data', failing)).toThrow(
      expect.objectContaining({
        code: 'EIO',
        message: expect.stringMatching(/^simulated EIO — nothing was written; .+ \(the temporary file .+\.tmp could not be removed\)$/),
      }),
    );
  });

  it('a cleanup failure after a successful publish is reported, not thrown', () => {
    const { file } = outDir();
    const result = publishNewFile(file('a.csv'), 'data', ops({ unlink: () => { throw failure('EBUSY'); } }));
    expect(result.leftoverTempFile).toMatch(/\.a\.csv\.\d+\.[0-9a-f]{12}\.tmp$/);
    expect(readFileSync(file('a.csv'), 'utf8')).toBe('data');
  });
});

describe('runExport output publishing', () => {
  function demoDb(dir: string) {
    const path = `${dir}/../g.sqlite`;
    const db = initDatabase(path, 'demo', T0);
    addTestRobot(db);
    recordReading(db, testReading(), T0);
    db.close();
    return path;
  }

  it('publishes the expected CSV atomically and leaves only the output file', () => {
    const { dir, file } = outDir();
    const summary = runExport({ dbPath: demoDb(dir), kind: 'readings', run: 'RUN-1', verificationRun: null, robot: null, outPath: file('r.csv') });
    expect(summary).toMatchObject({ rows: 1, leftoverTempFile: null });
    expect(readFileSync(file('r.csv'), 'utf8').startsWith('run_id,run_type,robot_id,')).toBe(true);
    expect(readdirSync(dir)).toEqual(['r.csv']);
  });

  it('validation and lookup errors create no output and no temporary file', () => {
    const { dir, file } = outDir();
    const db = demoDb(dir);
    expect(() => runExport({ dbPath: db, kind: 'readings', run: 'NOPE', verificationRun: null, robot: null, outPath: file('r.csv') })).toThrow(/No run/);
    expect(() =>
      runExport({ dbPath: db, kind: 'paired', run: 'RUN-1', verificationRun: 'RUN-1', robot: null, outPath: file('p.csv') }),
    ).toThrow(/not a verification run/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a write failure during export leaves no output and no temporary file', () => {
    const { dir, file } = outDir();
    const failing = ops({ link: () => { throw failure('EIO'); } });
    expect(() =>
      runExport({ dbPath: demoDb(dir), kind: 'delivery', run: 'RUN-1', verificationRun: null, robot: null, outPath: file('d.csv') }, failing),
    ).toThrow('simulated EIO');
    expect(readdirSync(dir)).toEqual([]);
  });
});
