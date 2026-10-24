-- RoboLime field gateway — local SQLite schema, migration 0002 (M6a).
--
-- Prepares the outbox for a single cloud sync worker. No network code uses
-- it yet. The four sync states (pending / syncing / synced / failed) are
-- unchanged; "blocked" and "claimed" are extra columns, not new states.
--
-- Blocked entries: a permanent data conflict leaves the entry 'failed' with
-- blocked_at + a fixed-code block_reason and NO retry time. CHECKs below make
-- a blocked row impossible to move to 'syncing' (the state CHECK fails), so it
-- can only be claimed again after an explicit operator requeue clears both
-- block fields. Block reasons are short lowercase codes, never row content,
-- credentials or server messages.
--
-- Claim ownership (fencing): while an entry is 'syncing' it records the lease
-- owner that claimed it (claimed_by). Only the current holder of the single
-- worker lease may claim entries or move its own claimed entries to 'synced'
-- or 'failed'. The gateway code also checks lease EXPIRY inside the same
-- transaction; the trigger below is a second, database-level guard on owner
-- identity (SQLite triggers cannot see the application clock).

ALTER TABLE sync_outbox ADD COLUMN blocked_at TEXT
  CHECK (blocked_at IS NULL OR (
    state = 'failed'
    AND next_attempt_at IS NULL
    AND blocked_at = strftime('%Y-%m-%dT%H:%M:%fZ', blocked_at)
  ));

ALTER TABLE sync_outbox ADD COLUMN block_reason TEXT
  CHECK ((blocked_at IS NULL) = (block_reason IS NULL)
    AND (block_reason IS NULL OR (
      length(block_reason) BETWEEN 1 AND 64
      AND block_reason GLOB '[a-z]*'
      AND block_reason NOT GLOB '*[^a-z0-9_]*'
    )));

-- Set only while 'syncing'; cleared by every transition out of 'syncing'.
ALTER TABLE sync_outbox ADD COLUMN claimed_by TEXT
  CHECK (claimed_by IS NULL OR (state = 'syncing' AND length(claimed_by) BETWEEN 1 AND 64));

CREATE INDEX sync_outbox_blocked ON sync_outbox (entity_type, blocked_at) WHERE blocked_at IS NOT NULL;

-- At most one worker lease (id is always 1).
CREATE TABLE sync_worker_lease (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  owner       TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 64),
  acquired_at TEXT NOT NULL CHECK (acquired_at = strftime('%Y-%m-%dT%H:%M:%fZ', acquired_at)),
  renewed_at  TEXT NOT NULL CHECK (renewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', renewed_at)),
  expires_at  TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  CHECK (renewed_at >= acquired_at AND expires_at > renewed_at)
) STRICT;

-- Fencing on owner identity (not expiry: expiry is checked by the gateway
-- code inside the same transaction). Fires on state AND ownership changes.
-- Rejected:
--   * claiming (→ 'syncing') under any claimed_by other than the current
--     lease owner;
--   * an owned entry leaving 'syncing' for 'synced'/'failed' when its claimer
--     is not the current lease owner;
--   * any change of claimed_by while the entry stays 'syncing'
--     (ownership cannot be reassigned or dropped without a transition).
-- Allowed: the above by the current owner; any 'syncing' → 'pending' with
-- claimed_by cleared (takeover recovery, release); requeue (no state or
-- owner change). Entries claimed without an owner (claimed_by NULL) keep the
-- pre-0002 behaviour, so existing single-process callers are unaffected.
CREATE TRIGGER sync_outbox_claim_fencing BEFORE UPDATE OF state, claimed_by ON sync_outbox
WHEN
  (OLD.state <> 'syncing' AND NEW.state = 'syncing' AND NEW.claimed_by IS NOT NULL
    AND NEW.claimed_by IS NOT (SELECT owner FROM sync_worker_lease WHERE id = 1))
  OR (OLD.state = 'syncing' AND NEW.state IN ('synced', 'failed') AND OLD.claimed_by IS NOT NULL
    AND OLD.claimed_by IS NOT (SELECT owner FROM sync_worker_lease WHERE id = 1))
  OR (OLD.state = 'syncing' AND NEW.state = 'syncing' AND OLD.claimed_by IS NOT NEW.claimed_by)
BEGIN
  SELECT RAISE(ABORT, 'sync_outbox entry is not owned by the current sync lease holder');
END;
