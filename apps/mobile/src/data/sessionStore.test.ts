import { SESSION_STORAGE_KEY, createKeyValueSessionStore, createMemorySessionStore, type KeyValueStorage, type StoredSession } from './sessionStore';

const SESSION: StoredSession = { token: 'tok', robot: { id: 'r1', displayName: 'Demo', isSynthetic: true }, expiresAt: '2026-06-01T00:00:00Z' };

function mapStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe('session store', () => {
  it('persists a session across store instances (page reloads) and clears it', () => {
    const storage = mapStorage();
    createKeyValueSessionStore(storage).save(SESSION);
    expect(createKeyValueSessionStore(storage).load()).toEqual(SESSION);
    createKeyValueSessionStore(storage).clear();
    expect(createKeyValueSessionStore(storage).load()).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('stores only the token, robot summary and expiry (never a pairing code)', () => {
    const storage = mapStorage();
    createKeyValueSessionStore(storage).save(SESSION);
    expect(Object.keys(JSON.parse(storage.data.get(SESSION_STORAGE_KEY) ?? '{}')).sort()).toEqual(['expiresAt', 'robot', 'token']);
  });

  it('discards corrupt or wrongly shaped data', () => {
    const storage = mapStorage();
    for (const bad of ['not json', '{}', '{"token":"","robot":{},"expiresAt":"x"}', 'null']) {
      storage.data.set(SESSION_STORAGE_KEY, bad);
      expect(createKeyValueSessionStore(storage).load()).toBeNull();
    }
  });

  it('behaves as "no session" when storage throws (blocked site data, private mode)', () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const store = createKeyValueSessionStore(throwing);
    expect(() => store.save(SESSION)).not.toThrow();
    expect(store.load()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });

  it('memory store keeps a session only for its own lifetime', () => {
    const store = createMemorySessionStore();
    store.save(SESSION);
    expect(store.load()).toEqual(SESSION);
    expect(createMemorySessionStore().load()).toBeNull();
  });
});
