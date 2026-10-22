-- RoboLime field gateway — local SQLite schema, migration 0001.
--
-- SQLite on the laptop is the durable system of record in the field. Every
-- timestamp column stores canonical UTC ISO-8601 text with milliseconds
-- ("YYYY-MM-DDTHH:MM:SS.sssZ"), enforced by CHECK constraints.
-- Three clocks are kept apart:
--   robot_*_at          robot-side time (the only user-facing measurement time)
--   gateway_*_at        when this gateway durably stored the record
--   cloud_confirmed_at  (sync_outbox) when hosted Supabase confirmed persistence
--
-- IDs: every mirrored entity uses a deterministic UUIDv5 derived from its
-- natural key (see src/db/ids.ts), so SQLite and PostgreSQL share the same
-- primary keys and a rebuilt gateway re-derives identical IDs.

-- ---------------------------------------------------------------- settings
CREATE TABLE gateway_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at))
) STRICT;

-- ------------------------------------------------------------------ robots
CREATE TABLE robots (
  id               TEXT PRIMARY KEY,
  -- Identifier as reported by the firmware. Wire format pending packet spec.
  source_robot_id  TEXT NOT NULL UNIQUE CHECK (length(source_robot_id) BETWEEN 1 AND 64),
  display_name     TEXT NOT NULL CHECK (length(display_name) >= 1),
  is_synthetic     INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  -- Undecided (<= 5,000 mL); NULL until the hardware owner confirms. OPEN_ITEMS #2.
  tank_capacity_ml REAL CHECK (tank_capacity_ml IS NULL OR (tank_capacity_ml > 0 AND tank_capacity_ml <= 5000)),
  created_at       TEXT NOT NULL CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
) STRICT;

-- ------------------------------------------------------------ field/cells
CREATE TABLE fields (
  id             TEXT PRIMARY KEY,
  robot_id       TEXT NOT NULL REFERENCES robots (id) ON DELETE RESTRICT,
  field_key      TEXT NOT NULL CHECK (length(field_key) BETWEEN 1 AND 64),
  name           TEXT NOT NULL CHECK (length(name) >= 1),
  location_label TEXT NOT NULL,
  area_m2        REAL CHECK (area_m2 IS NULL OR area_m2 > 0),
  cell_size_m    REAL NOT NULL DEFAULT 2 CHECK (cell_size_m > 0),
  total_cells    INTEGER CHECK (total_cells IS NULL OR total_cells > 0),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_synthetic   INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  created_at     TEXT NOT NULL CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  UNIQUE (robot_id, field_key),
  UNIQUE (id, robot_id)
) STRICT;

-- One active field per robot (the deployment supports a single real field).
CREATE UNIQUE INDEX fields_one_active_per_robot ON fields (robot_id) WHERE is_active = 1;

CREATE TABLE field_cells (
  field_id         TEXT NOT NULL REFERENCES fields (id) ON DELETE CASCADE,
  cell_index       INTEGER NOT NULL CHECK (cell_index >= 0),
  grid_row         INTEGER CHECK (grid_row IS NULL OR grid_row >= 0),
  grid_column      INTEGER CHECK (grid_column IS NULL OR grid_column >= 0),
  center_latitude  REAL CHECK (center_latitude IS NULL OR center_latitude BETWEEN -90 AND 90),
  center_longitude REAL CHECK (center_longitude IS NULL OR center_longitude BETWEEN -180 AND 180),
  CHECK ((center_latitude IS NULL) = (center_longitude IS NULL)),
  PRIMARY KEY (field_id, cell_index)
) STRICT;

-- -------------------------------------------------------------------- runs
CREATE TABLE runs (
  id                        TEXT PRIMARY KEY,
  robot_id                  TEXT NOT NULL REFERENCES robots (id) ON DELETE RESTRICT,
  -- Run identifier as reported by the firmware; not assumed to be a UUID.
  source_run_id             TEXT NOT NULL CHECK (length(source_run_id) BETWEEN 1 AND 64),
  run_type                  TEXT NOT NULL CHECK (run_type IN ('dosing', 'verification')),
  -- Active field when the run was first seen. Readings map by cell index.
  field_id                  TEXT,
  gateway_first_received_at TEXT NOT NULL CHECK (gateway_first_received_at = strftime('%Y-%m-%dT%H:%M:%fZ', gateway_first_received_at)),
  is_synthetic              INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  UNIQUE (robot_id, source_run_id),
  UNIQUE (id, robot_id),
  FOREIGN KEY (field_id, robot_id) REFERENCES fields (id, robot_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX runs_robot ON runs (robot_id);

-- ---------------------------------------------------------------- readings
-- Immutable once stored. Logical identity: (run_id, cell_index, seq).
CREATE TABLE readings (
  id                          TEXT PRIMARY KEY,
  run_id                      TEXT NOT NULL REFERENCES runs (id) ON DELETE RESTRICT,
  cell_index                  INTEGER NOT NULL CHECK (cell_index >= 0),
  seq                         INTEGER NOT NULL CHECK (seq >= 0),
  -- Attempt number of the FIRST copy received (later retries are in reading_receipts).
  -- Numbering base (0 or 1) pending packet spec.
  attempt_count               INTEGER NOT NULL CHECK (attempt_count >= 0),
  ph                          REAL NOT NULL CHECK (ph BETWEEN 0 AND 14),
  -- EC unit unconfirmed (OPEN_ITEMS #7): stored as the decoded sensor value.
  ec                          REAL NOT NULL CHECK (ec >= 0),
  moisture_percent            REAL NOT NULL CHECK (moisture_percent BETWEEN 0 AND 100),
  temperature_c               REAL NOT NULL,
  -- Robot's COMMANDED lime volume for this cell; not a flow measurement.
  dose_volume_ml              REAL NOT NULL CHECK (dose_volume_ml >= 0),
  -- Calculated on the robot; never computed by the gateway.
  expected_post_correction_ph REAL CHECK (expected_post_correction_ph IS NULL OR expected_post_correction_ph BETWEEN 0 AND 14),
  gps_latitude                REAL CHECK (gps_latitude IS NULL OR gps_latitude BETWEEN -90 AND 90),
  gps_longitude               REAL CHECK (gps_longitude IS NULL OR gps_longitude BETWEEN -180 AND 180),
  raw_flags                   INTEGER NOT NULL CHECK (raw_flags >= 0),
  robot_recorded_at           TEXT NOT NULL CHECK (robot_recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', robot_recorded_at)),
  gateway_received_at         TEXT NOT NULL CHECK (gateway_received_at = strftime('%Y-%m-%dT%H:%M:%fZ', gateway_received_at)),
  CHECK ((gps_latitude IS NULL) = (gps_longitude IS NULL)),
  UNIQUE (run_id, cell_index, seq)
) STRICT;

CREATE INDEX readings_run_cell ON readings (run_id, cell_index);

CREATE TRIGGER readings_immutable BEFORE UPDATE ON readings
BEGIN
  SELECT RAISE(ABORT, 'readings are immutable once stored');
END;

-- Local-only receipt log: every copy of a reading the gateway received.
-- Feeds first-attempt delivery ratio / post-retry completeness analysis.
CREATE TABLE reading_receipts (
  id                  INTEGER PRIMARY KEY,
  reading_id          TEXT NOT NULL REFERENCES readings (id) ON DELETE CASCADE,
  attempt_count       INTEGER NOT NULL CHECK (attempt_count >= 0),
  gateway_received_at TEXT NOT NULL CHECK (gateway_received_at = strftime('%Y-%m-%dT%H:%M:%fZ', gateway_received_at)),
  outcome             TEXT NOT NULL CHECK (outcome IN ('inserted', 'duplicate', 'conflict')),
  -- For 'conflict': the differing payload, kept for review. The stored reading is never overwritten.
  conflicting_payload TEXT CHECK (conflicting_payload IS NULL OR json_valid(conflicting_payload)),
  CHECK ((outcome = 'conflict') = (conflicting_payload IS NOT NULL))
) STRICT;

CREATE INDEX reading_receipts_reading ON reading_receipts (reading_id);

-- ----------------------------------------------------------- robot status
-- One row per status packet (sent once after each cell, never retried).
CREATE TABLE robot_status_reports (
  id                      TEXT PRIMARY KEY,
  robot_id                TEXT NOT NULL REFERENCES robots (id) ON DELETE RESTRICT,
  state                   TEXT NOT NULL CHECK (state IN ('INITIALIZING', 'IDLE', 'WORKING', 'PAUSED', 'COMPLETED', 'ERROR', 'MANUAL')),
  error_flags             INTEGER NOT NULL CHECK (error_flags BETWEEN 0 AND 255),
  -- Bit layout pending packet spec (OPEN_ITEMS #9); stored undecoded.
  component_flags         INTEGER CHECK (component_flags IS NULL OR component_flags >= 0),
  battery_voltage         REAL NOT NULL CHECK (battery_voltage >= 0),
  -- Robot's COMMANDED cumulative volume; not a flow measurement.
  total_lime_commanded_ml REAL NOT NULL CHECK (total_lime_commanded_ml >= 0),
  cells_completed         INTEGER NOT NULL CHECK (cells_completed >= 0),
  total_cells             INTEGER NOT NULL CHECK (total_cells >= 0),
  robot_reported_at       TEXT NOT NULL CHECK (robot_reported_at = strftime('%Y-%m-%dT%H:%M:%fZ', robot_reported_at)),
  gateway_received_at     TEXT NOT NULL CHECK (gateway_received_at = strftime('%Y-%m-%dT%H:%M:%fZ', gateway_received_at)),
  UNIQUE (robot_id, robot_reported_at, state, cells_completed)
) STRICT;

CREATE INDEX robot_status_reports_latest ON robot_status_reports (robot_id, robot_reported_at DESC, gateway_received_at DESC);

CREATE TRIGGER robot_status_reports_immutable BEFORE UPDATE ON robot_status_reports
BEGIN
  SELECT RAISE(ABORT, 'status reports are immutable once stored');
END;

-- Latest status per robot by robot-side time (ties broken by receipt time).
CREATE VIEW robot_latest_status AS
SELECT s.*
FROM robot_status_reports AS s
WHERE s.id = (
  SELECT s2.id FROM robot_status_reports AS s2
  WHERE s2.robot_id = s.robot_id
  ORDER BY s2.robot_reported_at DESC, s2.gateway_received_at DESC, s2.id DESC
  LIMIT 1
);

-- ------------------------------------------------- pairing and sessions
-- Local-only. Stores a salted scrypt verifier, never the plaintext code.
CREATE TABLE pairing_credentials (
  id         TEXT PRIMARY KEY,
  robot_id   TEXT NOT NULL REFERENCES robots (id) ON DELETE CASCADE,
  verifier   TEXT NOT NULL CHECK (verifier LIKE 'scrypt$%'),
  label      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  revoked_at TEXT CHECK (revoked_at IS NULL OR revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at))
) STRICT;

CREATE UNIQUE INDEX pairing_credentials_one_active_per_robot ON pairing_credentials (robot_id) WHERE revoked_at IS NULL;

-- Local-only. Stores SHA-256 of the session secret, never the token itself.
CREATE TABLE local_sessions (
  id                    TEXT PRIMARY KEY,
  robot_id              TEXT NOT NULL REFERENCES robots (id) ON DELETE CASCADE,
  pairing_credential_id TEXT NOT NULL REFERENCES pairing_credentials (id) ON DELETE CASCADE,
  token_hash            TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at            TEXT NOT NULL CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  expires_at            TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  revoked_at            TEXT CHECK (revoked_at IS NULL OR revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at)),
  CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX local_sessions_robot ON local_sessions (robot_id);

-- Local-only record of intent. The robot never reads it.
CREATE TABLE field_selections (
  id           TEXT PRIMARY KEY,
  field_id     TEXT NOT NULL REFERENCES fields (id) ON DELETE CASCADE,
  session_id   TEXT REFERENCES local_sessions (id) ON DELETE SET NULL,
  confirmed_at TEXT NOT NULL CHECK (confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', confirmed_at))
) STRICT;

-- ------------------------------------------------- versioned rule tables
-- Content of a rule set may change only while it is a 'draft' that no stored
-- recommendation references. Changes otherwise require a new version.
-- Synthetic fixtures can never be approved.
CREATE TABLE rule_sets (
  id             TEXT PRIMARY KEY,
  version        TEXT NOT NULL UNIQUE CHECK (length(version) BETWEEN 1 AND 64),
  status         TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'retired')),
  scoring_method TEXT NOT NULL CHECK (length(scoring_method) >= 1),
  is_synthetic   INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  source_notes   TEXT NOT NULL,
  created_at     TEXT NOT NULL CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  approved_at    TEXT CHECK (approved_at IS NULL OR approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', approved_at)),
  CHECK (NOT (is_synthetic = 1 AND status = 'approved')),
  CHECK ((status = 'draft') = (approved_at IS NULL))
) STRICT;

CREATE TRIGGER rule_sets_guard_update BEFORE UPDATE ON rule_sets
WHEN OLD.version <> NEW.version
  OR OLD.scoring_method <> NEW.scoring_method
  OR OLD.is_synthetic <> NEW.is_synthetic
  OR OLD.source_notes <> NEW.source_notes
  OR (OLD.status = 'approved' AND NEW.status NOT IN ('approved', 'retired'))
  OR (OLD.status = 'retired' AND NEW.status <> 'retired')
BEGIN
  SELECT RAISE(ABORT, 'rule set identity is fixed; only draft->approved->retired status changes are allowed');
END;

CREATE TABLE rule_crops (
  rule_set_id  TEXT NOT NULL REFERENCES rule_sets (id) ON DELETE RESTRICT,
  crop_key     TEXT NOT NULL CHECK (length(crop_key) BETWEEN 1 AND 64),
  display_name TEXT NOT NULL,
  category     TEXT NOT NULL,
  -- Eligibility (CLAUDE.md §8): annual/non-tree crops cultivated in Batangas only.
  is_perennial_or_tree INTEGER NOT NULL DEFAULT 0 CHECK (is_perennial_or_tree = 0),
  cultivation_reference TEXT NOT NULL,
  PRIMARY KEY (rule_set_id, crop_key)
) STRICT;

CREATE TABLE rule_suitability_ranges (
  rule_set_id      TEXT NOT NULL,
  crop_key         TEXT NOT NULL,
  parameter        TEXT NOT NULL CHECK (length(parameter) >= 1),
  min_value        REAL NOT NULL,
  max_value        REAL NOT NULL,
  unit             TEXT NOT NULL,
  weight           REAL NOT NULL DEFAULT 1 CHECK (weight > 0),
  source_reference TEXT NOT NULL,
  CHECK (min_value <= max_value),
  PRIMARY KEY (rule_set_id, crop_key, parameter),
  FOREIGN KEY (rule_set_id, crop_key) REFERENCES rule_crops (rule_set_id, crop_key) ON DELETE RESTRICT
) STRICT;

CREATE TABLE rule_seasons (
  rule_set_id TEXT NOT NULL REFERENCES rule_sets (id) ON DELETE RESTRICT,
  season_key  TEXT NOT NULL CHECK (length(season_key) BETWEEN 1 AND 64),
  label       TEXT NOT NULL,
  start_month INTEGER NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  start_day   INTEGER NOT NULL CHECK (start_day BETWEEN 1 AND 31),
  end_month   INTEGER NOT NULL CHECK (end_month BETWEEN 1 AND 12),
  end_day     INTEGER NOT NULL CHECK (end_day BETWEEN 1 AND 31),
  PRIMARY KEY (rule_set_id, season_key)
) STRICT;

CREATE TABLE rule_seasonal_weather_defaults (
  rule_set_id      TEXT NOT NULL,
  season_key       TEXT NOT NULL,
  parameter        TEXT NOT NULL CHECK (length(parameter) >= 1),
  value            REAL NOT NULL,
  unit             TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  PRIMARY KEY (rule_set_id, season_key, parameter),
  FOREIGN KEY (rule_set_id, season_key) REFERENCES rule_seasons (rule_set_id, season_key) ON DELETE RESTRICT
) STRICT;

-- ------------------------------------------------ stored recommendations
-- (rule-content lock triggers follow the recommendations table they consult)
-- Computed once per dosing run (later phase); immutable once stored.
CREATE TABLE recommendations (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL UNIQUE REFERENCES runs (id) ON DELETE RESTRICT,
  rule_set_id    TEXT NOT NULL REFERENCES rule_sets (id) ON DELETE RESTRICT,
  -- Exact inputs used (medians, season, weather values) for reproducibility.
  inputs_json    TEXT NOT NULL CHECK (json_valid(inputs_json)),
  weather_source TEXT NOT NULL CHECK (weather_source IN ('forecast', 'seasonal-defaults')),
  computed_at    TEXT NOT NULL CHECK (computed_at = strftime('%Y-%m-%dT%H:%M:%fZ', computed_at)),
  UNIQUE (id, rule_set_id)
) STRICT;

CREATE TABLE recommendation_scores (
  recommendation_id TEXT NOT NULL,
  rule_set_id       TEXT NOT NULL,
  crop_key          TEXT NOT NULL,
  score             REAL NOT NULL,
  -- 1..5 for the shortlisted category leaders; NULL for retained non-shortlisted scores.
  shortlist_rank    INTEGER CHECK (shortlist_rank IS NULL OR shortlist_rank BETWEEN 1 AND 5),
  reasons_json      TEXT NOT NULL CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array'),
  PRIMARY KEY (recommendation_id, crop_key),
  UNIQUE (recommendation_id, shortlist_rank),
  FOREIGN KEY (recommendation_id, rule_set_id) REFERENCES recommendations (id, rule_set_id) ON DELETE CASCADE,
  FOREIGN KEY (rule_set_id, crop_key) REFERENCES rule_crops (rule_set_id, crop_key) ON DELETE RESTRICT
) STRICT;

-- Verification runs never generate recommendations.
CREATE TRIGGER recommendations_dosing_only BEFORE INSERT ON recommendations
WHEN (SELECT run_type FROM runs WHERE id = NEW.run_id) <> 'dosing'
BEGIN
  SELECT RAISE(ABORT, 'recommendations are only stored for dosing runs');
END;

-- Real runs need an approved rule set; synthetic rule sets only serve synthetic runs.
CREATE TRIGGER recommendations_rule_set_eligibility BEFORE INSERT ON recommendations
WHEN NOT (
  ((SELECT status FROM rule_sets WHERE id = NEW.rule_set_id) = 'approved'
    AND (SELECT is_synthetic FROM runs WHERE id = NEW.run_id) = 0)
  OR ((SELECT is_synthetic FROM rule_sets WHERE id = NEW.rule_set_id) = 1
    AND (SELECT is_synthetic FROM runs WHERE id = NEW.run_id) = 1)
)
BEGIN
  SELECT RAISE(ABORT, 'real runs require an approved rule set; synthetic rule sets only serve synthetic runs');
END;

CREATE TRIGGER recommendations_immutable BEFORE UPDATE ON recommendations
BEGIN
  SELECT RAISE(ABORT, 'stored recommendations are immutable');
END;

CREATE TRIGGER recommendation_scores_immutable BEFORE UPDATE ON recommendation_scores
BEGIN
  SELECT RAISE(ABORT, 'stored recommendation scores are immutable');
END;

-- Rule content is locked once its rule set leaves 'draft' or any stored
-- recommendation references it, so stored recommendations stay reproducible.
CREATE TRIGGER rule_crops_lock_insert BEFORE INSERT ON rule_crops
WHEN (SELECT status FROM rule_sets WHERE id = NEW.rule_set_id) <> 'draft'
  OR EXISTS (SELECT 1 FROM recommendations WHERE rule_set_id = NEW.rule_set_id)
BEGIN SELECT RAISE(ABORT, 'rule set content is locked; create a new rule set version'); END;
CREATE TRIGGER rule_crops_lock_update BEFORE UPDATE ON rule_crops
WHEN (SELECT status FROM rule_sets WHERE id = OLD.rule_set_id) <> 'draft'
  OR EXISTS (SELECT 1 FROM recommendations WHERE rule_set_id = OLD.rule_set_id)
BEGIN SELECT RAISE(ABORT, 'rule set content is locked; create a new rule set version'); END;
CREATE TRIGGER rule_crops_lock_delete BEFORE DELETE ON rule_crops
WHEN (SELECT status FROM rule_sets WHERE id = OLD.rule_set_id) <> 'draft'
  OR EXISTS (SELECT 1 FROM recommendations WHERE rule_set_id = OLD.rule_set_id)
BEGIN SELECT RAISE(ABORT, 'rule set content is locked; create a new rule set version'); END;

CREATE TRIGGER rule_suitability_ranges_lock_insert BEFORE INSERT ON rule_suitability_ranges
WHEN (SELECT status FROM rule_sets WHERE id = NEW.rule_set_id) <> 'draft'
  OR EXISTS (SELECT 1 FROM recommendations WHERE rule_set_id = NEW.rule_set_id)
BEGIN SELECT RAISE(ABORT, 'rule set content is locked; create a new rule set version'); END;
CREATE TRIGGER rule_suitability_ranges_lock_update BEFORE UPDATE ON rule_suitability_ranges
WHEN (SELECT status FROM rule_sets WHERE id = OLD.rule_set_id) <> 'draft'
  OR EXISTS (SELECT 1 FROM recommendations WHERE rule_set_id = OLD.rule_set_id)
BEGIN SELECT RAISE(ABORT, 'rule set content is locked; create a new rule set version'); END;
CREATE TRIGGER rule_suitability_ranges_lock_delete BEFORE DELETE ON rule_suitability_ranges
WHEN (SELECT status FROM rule_sets WHERE id = OLD.rule_set_id) <> 'draft'
  OR EXISTS (SELECT 1 FROM recommendations WHERE rule_set_id = OLD.rule_set_id)
BEGIN SELECT RAISE(ABORT, 'rule set content is locked; create a new rule set version'); END;

CREATE TRIGGER rule_seasons_lock_insert BEFORE INSERT ON rule_seasons
WHEN (SELECT status FROM rule_sets WHERE id = NEW.rule_set_id) <> 'draft'
  OR EXISTS (SELECT 1 FROM recommendations WHERE rule_set_id = NEW.rule_set_id)
BEGIN SELECT RAISE(ABORT, 'rule set content is locked; create a new rule set version'); END;
CREATE TRIGGER rule_seasons_lock_update BEFORE UPDATE ON rule_seasons
WHEN (SELECT status FROM rule_sets WHERE id = OLD.rule_set_id) <> 'draft'
  OR EXISTS (SELECT 1 FROM recommendations WHERE rule_set_id = OLD.rule_set_id)
BEGIN SELECT RAISE(ABORT, 'rule set content is locked; create a new rule set version'); END;
CREATE TRIGGER rule_seasons_lock_delete BEFORE DELETE ON rule_seasons
WHEN (SELECT status FROM rule_sets WHERE id = OLD.rule_set_id) <> 'draft'
  OR EXISTS (SELECT 1 FROM recommendations WHERE rule_set_id = OLD.rule_set_id)
BEGIN SELECT RAISE(ABORT, 'rule set content is locked; create a new rule set version'); END;

CREATE TRIGGER rule_seasonal_weather_defaults_lock_insert BEFORE INSERT ON rule_seasonal_weather_defaults
WHEN (SELECT status FROM rule_sets WHERE id = NEW.rule_set_id) <> 'draft'
  OR EXISTS (SELECT 1 FROM recommendations WHERE rule_set_id = NEW.rule_set_id)
BEGIN SELECT RAISE(ABORT, 'rule set content is locked; create a new rule set version'); END;
CREATE TRIGGER rule_seasonal_weather_defaults_lock_update BEFORE UPDATE ON rule_seasonal_weather_defaults
WHEN (SELECT status FROM rule_sets WHERE id = OLD.rule_set_id) <> 'draft'
  OR EXISTS (SELECT 1 FROM recommendations WHERE rule_set_id = OLD.rule_set_id)
BEGIN SELECT RAISE(ABORT, 'rule set content is locked; create a new rule set version'); END;
CREATE TRIGGER rule_seasonal_weather_defaults_lock_delete BEFORE DELETE ON rule_seasonal_weather_defaults
WHEN (SELECT status FROM rule_sets WHERE id = OLD.rule_set_id) <> 'draft'
  OR EXISTS (SELECT 1 FROM recommendations WHERE rule_set_id = OLD.rule_set_id)
BEGIN SELECT RAISE(ABORT, 'rule set content is locked; create a new rule set version'); END;

-- ----------------------------------------------------- sync outbox
-- Local-only. One row per mirrored aggregate. State machine:
--   pending -> syncing -> synced | failed ; failed -> syncing ;
--   syncing -> pending (interrupted attempt recovered at startup) ;
--   synced -> pending (entity legitimately changed, e.g. rule-set approval)
-- 'synced' requires cloud_confirmed_at, which only comes from a confirmed cloud write.
CREATE TABLE sync_outbox (
  id                 INTEGER PRIMARY KEY,
  entity_type        TEXT NOT NULL CHECK (entity_type IN ('robot', 'field', 'run', 'reading', 'status_report', 'rule_set', 'recommendation')),
  entity_id          TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'syncing', 'synced', 'failed')),
  attempt_count      INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  enqueued_at        TEXT NOT NULL CHECK (enqueued_at = strftime('%Y-%m-%dT%H:%M:%fZ', enqueued_at)),
  last_attempt_at    TEXT CHECK (last_attempt_at IS NULL OR last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', last_attempt_at)),
  next_attempt_at    TEXT CHECK (next_attempt_at IS NULL OR next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at)),
  last_error         TEXT,
  cloud_confirmed_at TEXT CHECK (cloud_confirmed_at IS NULL OR cloud_confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', cloud_confirmed_at)),
  UNIQUE (entity_type, entity_id),
  CHECK ((state = 'synced') = (cloud_confirmed_at IS NOT NULL)),
  CHECK (state <> 'failed' OR last_error IS NOT NULL)
) STRICT;

CREATE INDEX sync_outbox_claimable ON sync_outbox (state, next_attempt_at);

CREATE TRIGGER sync_outbox_transitions BEFORE UPDATE OF state ON sync_outbox
WHEN OLD.state <> NEW.state
  AND (OLD.state || '>' || NEW.state) NOT IN (
    'pending>syncing', 'syncing>synced', 'syncing>failed',
    'syncing>pending', 'failed>syncing', 'synced>pending')
BEGIN
  SELECT RAISE(ABORT, 'invalid sync_outbox state transition');
END;
