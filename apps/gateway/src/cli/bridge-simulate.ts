/**
 * SIMULATION ONLY. Plays one synthetic robot run through the bridge runtime
 * (Phase 4, milestone 3) into an existing DEMO database.
 *   npm run bridge:simulate -w @robolime/gateway -- --db <demo file> [--cells 6] [--seed 1]
 * No serial port, radio or hardware is used. Refuses field databases.
 * Does not start the HTTP API; run `serve` separately to look at the results.
 */
import { fail, parseCli } from './args';
import { parseSimulationArgs, runBridgeSimulation } from '../runtime/simulate';

const values = parseCli({ db: { type: 'string' }, cells: { type: 'string' }, seed: { type: 'string' } });

let args;
try {
  args = parseSimulationArgs(values);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const controller = new AbortController();
let signals = 0;
function onSignal(signal: string): void {
  signals += 1;
  if (signals > 1) {
    process.stderr.write(`Received ${signal} again; exiting immediately.\n`);
    process.exit(1);
  }
  process.stdout.write(`Received ${signal}; stopping the simulation...\n`);
  controller.abort();
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

process.stdout.write(
  `SIMULATION ONLY: synthetic run of ${args.cells} cells (seed ${args.seed}) into ${args.dbPath} (must be a demo database). No hardware or radio is used.\n`,
);
try {
  const s = await runBridgeSimulation(args, { signal: controller.signal });
  process.stdout.write(
    [
      `${s.completed ? 'Simulation complete' : 'Simulation stopped early'}: run ${s.runId}`,
      `  uplinks delivered: ${s.uplinksDelivered}`,
      `  readings stored: ${s.readingsInserted} new, ${s.readingsDuplicate} already present, ${s.readingsConflict} conflicting (originals kept)`,
      `  storage ACKs sent: ${s.acksSent}`,
      '',
    ].join('\n'),
  );
  process.exit(s.completed ? 0 : 130);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
