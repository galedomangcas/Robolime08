import type { IsoDateTime, RobotSummary } from '@robolime/shared';

/**
 * Where the paired session token is kept (decision D33).
 *
 * The web build uses `localStorage` so pairing survives browser restarts and
 * gateway restarts, as Screen 1 requires. Known limits, accepted for this
 * single-owner-device model:
 * - Any script that runs in the page can read it, so a script-injection (XSS)
 *   bug would expose the token. The gateway's CSP allows scripts from its own
 *   origin only and the app loads no third-party code, which reduces but does
 *   not remove this risk.
 * - Browser extensions with page access, and anyone who can use this
 *   computer's browser profile, can read it.
 * - Clearing it ("Forget this device") does not revoke the session on the
 *   gateway; it stays valid until it expires or the pairing code is
 *   re-provisioned (which revokes every session).
 * The pairing code itself is never stored.
 */

export interface StoredSession {
  token: string;
  robot: RobotSummary;
  expiresAt: IsoDateTime;
}

export interface SessionStore {
  load(): StoredSession | null;
  save(session: StoredSession): void;
  clear(): void;
}

/** The subset of the Web Storage API used here; injectable for tests. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SESSION_STORAGE_KEY = 'robolime.localSession.v1';

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const robot = v.robot as Record<string, unknown> | null | undefined;
  return (
    typeof v.token === 'string' &&
    v.token !== '' &&
    typeof v.expiresAt === 'string' &&
    typeof robot === 'object' &&
    robot !== null &&
    typeof robot.id === 'string' &&
    typeof robot.displayName === 'string' &&
    typeof robot.isSynthetic === 'boolean'
  );
}

/** Storage failures (private mode, quota, blocked site data) behave like "no session". */
export function createKeyValueSessionStore(storage: KeyValueStorage): SessionStore {
  return {
    load() {
      try {
        const raw = storage.getItem(SESSION_STORAGE_KEY);
        if (raw === null) return null;
        const parsed: unknown = JSON.parse(raw);
        if (isStoredSession(parsed)) return parsed;
        storage.removeItem(SESSION_STORAGE_KEY);
        return null;
      } catch {
        return null;
      }
    },
    save(session) {
      try {
        storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      } catch {
        // Not persisted; the session still works until the page is closed.
      }
    },
    clear() {
      try {
        storage.removeItem(SESSION_STORAGE_KEY);
      } catch {
        // Nothing stored that could be removed.
      }
    },
  };
}

/** In-memory store: used where `localStorage` is unavailable (native, tests). Not persistent. */
export function createMemorySessionStore(): SessionStore {
  let current: StoredSession | null = null;
  return {
    load: () => current,
    save: (session) => {
      current = session;
    },
    clear: () => {
      current = null;
    },
  };
}

/** `localStorage` when the platform has it, otherwise a non-persistent memory store. */
export function createDefaultSessionStore(): SessionStore {
  try {
    const storage = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    if (storage !== undefined) return createKeyValueSessionStore(storage);
  } catch {
    // Accessing localStorage can throw when site data is blocked.
  }
  return createMemorySessionStore();
}
