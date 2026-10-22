/**
 * Cloud-mirror upload state of a locally stored record. A record accepted
 * into gateway SQLite is durable regardless of this state; "synced" is set
 * only after hosted Supabase confirms persistence.
 */
export type SyncState = 'pending' | 'syncing' | 'synced' | 'failed';

/** Where a client is reading its data from. */
export type DataSourceKind = 'local-gateway' | 'cloud';
