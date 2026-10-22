import { describe, expect, it } from 'vitest';

import { ROBOLIME_ID_NAMESPACE, stableIds, uuidV5 } from './ids';

describe('uuidV5', () => {
  it('matches the RFC test vector for www.example.com in the DNS namespace', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('produces version 5, RFC variant UUIDs', () => {
    expect(uuidV5('anything', ROBOLIME_ID_NAMESPACE)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('stableIds', () => {
  it('is deterministic for the same natural key', () => {
    expect(stableIds.reading('run', 3, 7)).toBe(stableIds.reading('run', 3, 7));
    expect(stableIds.run('robot', 'R-1')).toBe(stableIds.run('robot', 'R-1'));
  });

  it('distinguishes every component of the reading key', () => {
    const ids = new Set([
      stableIds.reading('run', 3, 7),
      stableIds.reading('run', 3, 8),
      stableIds.reading('run', 4, 7),
      stableIds.reading('other', 3, 7),
      stableIds.reading('run', 37, 0),
    ]);
    expect(ids.size).toBe(5);
  });

  it('does not let entity kinds collide', () => {
    expect(stableIds.robot('X')).not.toBe(stableIds.ruleSet('X'));
  });

  it('treats firmware run identifiers as opaque text, not UUIDs', () => {
    expect(stableIds.run('robot', 'run 0001 / not-a-uuid')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps IDs stable across releases (pinned values)', () => {
    // If this fails, cloud upserts would stop being idempotent. Never "fix" it by updating the value.
    expect(stableIds.robot('SYNTHETIC-DEMO-ROBOT')).toBe(uuidV5('robot\u001fSYNTHETIC-DEMO-ROBOT', ROBOLIME_ID_NAMESPACE));
    expect(ROBOLIME_ID_NAMESPACE).toBe('77911ce3-a0d7-4b34-80f4-1788ffa77ace');
  });
});
