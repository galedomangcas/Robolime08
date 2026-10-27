import { homedir } from 'node:os';
import { join } from 'node:path';

/** Default DEMO database file (D52): per-user app data, never inside the Git working tree. */
export function defaultDemoDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA ?? join(homedir(), '.local', 'share');
  return join(base, 'RoboLime', 'demo', 'robolime-demo.sqlite');
}
