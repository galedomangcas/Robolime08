import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static checks on the hosted cloud-mirror migrations. No database is involved:
 * these read the SQL text only, so they pin the reviewed properties of the D42
 * legacy cleanup and of the target's authorization scope, but they do NOT prove
 * that either file executes successfully on PostgreSQL or Supabase.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url));
const CLEANUP = '20261022000000_remove_legacy_hosted_schema.sql';
const TARGET = '20261023000000_cloud_mirror_initial.sql';
const CLAIM_FLOW = '20261028000000_online_claim_flow.sql';
const MANUAL_RELAY = '20261029000000_manual_control_relay.sql';

/** Lower-cased SQL with `--` comments removed and whitespace collapsed. */
function code(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Names listed by the `drop <kind> if exists a, b, ...;` statement. */
function dropList(sql: string, kind: 'table' | 'view' | 'sequence'): string[] {
  const match = new RegExp(`drop ${kind} if exists ([^;]+);`).exec(sql);
  return match?.[1] ? match[1].split(',').map((name) => name.trim()) : [];
}

/** Quoted names inside the first `<column> in (...)` list after `anchor`. */
function inList(sql: string, anchor: string, column: string): string[] {
  const from = sql.indexOf(anchor);
  const match = new RegExp(`${column.replace('.', '\\.')} in \\(([^)]+)\\)`).exec(sql.slice(from));
  return match?.[1] ? match[1].split(',').map((s) => s.trim().replace(/'/g, '')) : [];
}

const cleanup = code(CLEANUP);
const target = code(TARGET);

// Target tables in creation order, with whether each defines cloud_received_at.
const targetTableDefs = target
  .split('create table public.')
  .slice(1)
  .map((segment) => {
    const name = /^(\w+)/.exec(segment)?.[1] ?? '';
    const body = segment.split(/ create (?:table|index|unique index|function|trigger) /)[0] ?? '';
    return { name, hasCloudReceivedAt: body.includes('cloud_received_at') };
  });
const targetTables = targetTableDefs.map((t) => t.name);
const targetFunctions = [...target.matchAll(/create function private\.(\w+)/g)].map((m) => m[1] ?? '');

const droppedTables = dropList(cleanup, 'table');
const droppedFunctions = [...cleanup.matchAll(/drop function if exists ([\w.]+\([^)]*\));/g)].map((m) => m[1] ?? '');
const collisions = droppedTables.filter((t) => t.startsWith('public.') && targetTables.includes(t.slice(7)));

// The guard's three lists, read from the SQL.
const guardTargetOnlyTables = inList(cleanup, 'from pg_catalog.pg_class', 'c.relname');
const guardColumnTables = inList(cleanup, 'from pg_catalog.pg_attribute', 'c.relname');
const guardFunctions = inList(cleanup, 'from pg_catalog.pg_proc', 'p.proname');

interface Catalog {
  tables: Map<string, string[]>; // public table -> columns
  privateFunctions: Set<string>;
}

/** Evaluates the guard's three conditions against a modelled catalog state. */
function guardRefuses(catalog: Catalog): boolean {
  const tableExists = guardTargetOnlyTables.some((t) => catalog.tables.has(t));
  const columnPresent = guardColumnTables.some((t) => catalog.tables.get(t)?.includes('cloud_received_at') ?? false);
  const functionExists = guardFunctions.some((f) => catalog.privateFunctions.has(f));
  return tableExists || columnPresent || functionExists;
}

describe('cloud migrations: order', () => {
  it('sorts the legacy cleanup immediately before the target schema, then the claim flow (D52) and the manual-control relay (D58)', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(files).toEqual([CLEANUP, TARGET, CLAIM_FLOW, MANUAL_RELAY]);
  });
});

describe('cloud migrations: legacy cleanup statements (D42)', () => {
  it('contains only one guard block and IF EXISTS drops of views, tables, sequences and functions', () => {
    const statements = cleanup.split(/;(?![^$]*\$\$)/).map((s) => s.trim()).filter((s) => s && s !== '$$');
    for (const statement of statements) {
      expect(statement).toMatch(/^(do \$\$ begin if exists|end; \$\$|drop (view|table|sequence|function) if exists )/);
    }
    expect(cleanup.match(/\bdo \$\$/g)).toHaveLength(1);
  });

  it('never cascades, uses dynamic SQL, drops schemas or owned objects, or changes data or privileges', () => {
    for (const forbidden of [
      /\bcascade\b/, /\bexecute\b/, /\bformat\(/, /\bdrop (schema|owned|routine|procedure|extension|publication|type|policy|trigger|index)\b/,
      /\breassign owned\b/, /\btruncate\b/, /\bdelete from\b/, /\binsert\b/, /\bupdate\b/, /\bgrant\b/, /\brevoke\b/,
      /\balter\b/, /\bcreate\b/, /\bpublication\b/,
    ]) {
      expect(cleanup).not.toMatch(forbidden);
    }
  });

  it('drops no object before the guard has run', () => {
    expect(cleanup.indexOf('raise exception')).toBeGreaterThan(-1);
    expect(cleanup.indexOf('raise exception')).toBeLessThan(cleanup.indexOf('drop '));
  });

  it('names 31 schema-qualified public/private objects and no Supabase-managed schema', () => {
    const dropped = [
      ...dropList(cleanup, 'view'), ...droppedTables, ...dropList(cleanup, 'sequence'),
      ...droppedFunctions.map((f) => f.slice(0, f.indexOf('('))),
    ];
    expect(dropped).toHaveLength(3 + 17 + 2 + 9);
    for (const name of dropped) expect(name).toMatch(/^(public|private)\.\w+$/);
    expect(new Set(dropped).size).toBe(dropped.length);
    expect(cleanup).not.toMatch(/\b(auth|storage|realtime|vault|extensions|graphql|graphql_public|net|cron|pgsodium|supabase_\w+)\./);
  });

  it('drops each of the nine reported routines by its exact signature, the hash helper last', () => {
    expect(droppedFunctions).toEqual([
      'private.has_any_claim()', 'private.has_claim(uuid)', 'private.set_pairing_code(uuid, text)',
      'public.claim_robot(text)', 'public.ingest_readings(uuid, jsonb)', 'public.ingest_status(uuid, jsonb)',
      'private.reject_verification_recommendation()', 'public.paired_readings(uuid, uuid)',
      'private.hash_pairing_code(text)',
    ]);
  });

  it('removes views, then tables, then sequences, then the routines legacy policies called', () => {
    const at = (s: string): number => cleanup.indexOf(s);
    expect(at('drop view')).toBeLessThan(at('drop table'));
    expect(at('drop table')).toBeLessThan(at('drop sequence'));
    expect(at('drop sequence')).toBeLessThan(at('drop function'));
  });

  it('collides with exactly nine target tables and never names a target-only table or function', () => {
    expect(collisions.sort()).toEqual([
      'public.fields', 'public.readings', 'public.recommendations', 'public.robot_claims', 'public.robots',
      'public.rule_crops', 'public.rule_seasons', 'public.rule_sets', 'public.runs',
    ]);
    for (const fn of targetFunctions) expect(droppedFunctions.join(' ')).not.toContain(`.${fn}(`);
  });
});

describe('cloud migrations: target-schema guard (D42)', () => {
  it('lists every target-only table, every target function, and every colliding table with cloud_received_at', () => {
    const targetOnly = targetTables.filter((t) => !collisions.includes(`public.${t}`));
    expect([...guardTargetOnlyTables].sort()).toEqual([...targetOnly].sort());
    expect([...guardFunctions].sort()).toEqual([...targetFunctions].sort());
    const collidingWithColumn = targetTableDefs
      .filter((t) => t.hasCloudReceivedAt && collisions.includes(`public.${t.name}`))
      .map((t) => t.name);
    expect([...guardColumnTables].sort()).toEqual([...collidingWithColumn].sort());
  });

  it("covers the target's first object, public.robots, through its cloud_received_at column", () => {
    expect(targetTableDefs[0]).toEqual({ name: 'robots', hasCloudReceivedAt: true });
    expect(guardColumnTables).toContain('robots');
  });

  it('(model) passes a fresh database and the known legacy readings table', () => {
    expect(guardRefuses({ tables: new Map(), privateFunctions: new Set() })).toBe(false);
    // Hosted evidence: legacy readings has no cloud_received_at.
    const legacy = new Map(collisions.map((t) => [t.slice(7), ['id']] as [string, string[]]));
    legacy.set('readings', ['run_id', 'cell_index', 'seq', 'measured_at']);
    expect(guardRefuses({ tables: legacy, privateFunctions: new Set(['has_claim', 'has_any_claim']) })).toBe(false);
  });

  it('(model) refuses at every stage of an interrupted target install, in creation order', () => {
    const tables = new Map<string, string[]>();
    for (const def of targetTableDefs) {
      tables.set(def.name, def.hasCloudReceivedAt ? ['cloud_received_at'] : []);
      expect(guardRefuses({ tables: new Map(tables), privateFunctions: new Set() })).toBe(true);
    }
    for (const fn of targetFunctions) {
      expect(guardRefuses({ tables: new Map(), privateFunctions: new Set([fn]) })).toBe(true);
    }
  });
});

describe('cloud migrations: target scope (unchanged by D42)', () => {
  it('mirrors 14 tables and none of the excluded semester features', () => {
    expect(targetTables).toHaveLength(14);
    expect(target).not.toMatch(/field_selections|create (or replace )?view|create sequence|serial\b/);
  });

  it('gives clients SELECT only and leaves writes to service_role', () => {
    expect(target).toContain('revoke all on table public.%i from anon, authenticated');
    expect(target).toContain('grant select on table public.%i to authenticated');
    expect(target).toContain('grant select, insert, update, delete on table public.%i to service_role');
    expect(target).not.toMatch(/grant [^;]*\b(insert|update|delete)\b[^;]* to [^;]*\b(anon|authenticated)\b/);
  });

  it('defines only claim-scoped SELECT policies for authenticated', () => {
    const policies = [...target.matchAll(/create policy "[^"]+" on public\.\w+ for (\w+) to (\w+) using/g)];
    expect(policies).toHaveLength(14);
    for (const p of policies) {
      expect(p[1]).toBe('select');
      expect(p[2]).toBe('authenticated');
    }
    expect(target).not.toMatch(/with check/);
  });
});

describe('cloud migrations: online claim flow (D52)', () => {
  const claim = code(CLAIM_FLOW);

  it('is additive: creates and grants only, never drops, alters existing tables or truncates', () => {
    expect(claim).not.toMatch(/(drop|truncate|alter table public.)/);
    expect(claim).not.toMatch(/delete from/);
  });

  it('lets clients execute only claim_robot, and only when signed in', () => {
    expect(claim).toContain('revoke all on function public.claim_robot(text) from public, anon;');
    expect(claim).toContain('grant execute on function public.claim_robot(text) to authenticated;');
    expect(claim).toContain('grant execute on function public.provision_robot_claim_code(text, text, timestamptz) to service_role;');
    expect(claim).toContain('grant execute on function public.revoke_robot_claims(text) to service_role;');
    expect(claim).not.toMatch(/grant [^;]* to (anon|public)/);
    expect(claim).not.toMatch(/grant execute on function public.(provision_robot_claim_code|revoke_robot_claims)[^;]* to authenticated/);
  });

  it('stores only a SHA-256 verifier and pins search_path on every SECURITY DEFINER function', () => {
    expect(claim).toContain("check (code_sha256 ~ '^[0-9a-f]{64}$')");
    expect(claim.match(/security definer/g)).toHaveLength(3);
    expect(claim.match(/security definer set search_path = ''/g)).toHaveLength(3);
  });
});
