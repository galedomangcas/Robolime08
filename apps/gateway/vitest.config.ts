import { defineConfig } from 'vitest/config';

/**
 * Gateway test settings. Only the per-test timeout differs from Vitest's defaults.
 *
 * Several tests run the real scrypt pairing verifier (N = 2^14, 16 MiB per call) or
 * fsync-backed SQLite files. Alone they take ~0.5 s; with every test file running in
 * parallel, CPU and memory-bandwidth contention has pushed individual tests past the
 * 5 s default (observed in 2026-10 runs on the 12-thread development laptop). A 30 s
 * limit removes those false failures without changing any assertion, and keeps the
 * production scrypt cost under test. A genuinely hung test still fails, after 30 s.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
