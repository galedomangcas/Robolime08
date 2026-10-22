import { parseArgs } from 'node:util';

/** Database path from `--db` or GATEWAY_DB_PATH; exits with guidance if neither is set. */
export function resolveDbPath(cliValue: string | undefined): string {
  const path = cliValue ?? process.env.GATEWAY_DB_PATH;
  if (!path) {
    fail('Set the database path with --db <file> or the GATEWAY_DB_PATH environment variable.');
  }
  return path;
}

export function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

export function parseCli<const T extends Record<string, { type: 'string' | 'boolean' }>>(options: T) {
  try {
    return parseArgs({ options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
