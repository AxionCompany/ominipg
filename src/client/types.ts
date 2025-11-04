import type { CrudSchemas } from "./crud/types.ts";
import type { PGliteConfig } from "../shared/types.ts";

export interface OminipgConnectionOptions {
  /**
   * The URL of the main database.
   * Use 'file://' for a local PGlite database or 'postgres://' for a remote PostgreSQL server.
   * If not provided, a default in-memory PGlite database will be used.
   */
  url?: string;

  /**
   * The URL of the remote PostgreSQL database to sync with.
   * If provided, bidirectional synchronization will be enabled.
   */
  syncUrl?: string;

  /**
   * A unique identifier for this edge client.
   * Helps prevent update echoes during synchronization.
   * Defaults to a randomly generated UUID.
   */
  edgeId?: string;

  /**
   * The name of the column used for Last-Write-Wins (LWW) conflict resolution.
   * This column should be a timestamp or other incrementing value.
   * Defaults to 'updated_at'.
   */
  lwwColumn?: string;

  /**
   * An array of SQL DDL statements to execute for schema creation.
   * These will be applied to both the local and remote (if syncing) databases.
   * It's recommended to use 'CREATE TABLE IF NOT EXISTS'.
   */
  schemaSQL?: string[];

  /**
   * If provided, only data newer than this ISO timestamp will be included in the initial sync.
   */
  initialSyncFrom?: string;

  /**
   * If true, the initial sync of data from the remote database will be skipped.
   * Defaults to false.
   */
  skipInitialSync?: boolean;

  /**
   * If true, auto-push will be disabled.
   * Defaults to false.
   */
  disableAutoPush?: boolean;

  /**
   * Array of PGlite extension names to load dynamically.
   * Only applicable when using PGlite (not PostgreSQL).
   * Extensions will be imported from '@electric-sql/pglite/contrib/{extensionName}'.
   *
   * @example
   * ```typescript
   * pgliteExtensions: ['uuid_ossp', 'vector', 'pg_trgm']
   * ```
   */
  pgliteExtensions?: string[];

  /**
   * Additional configuration forwarded to the embedded PGlite engine.
   * Useful for tuning WASM memory, cache sizing, or providing a precompiled binary.
   */
  pgliteConfig?: PGliteConfig;

  /**
   * Force use of a Web Worker even when only a Postgres URL is provided.
   * Defaults to true. Set to false to enable direct Postgres mode (no Worker, no PGlite).
   */
  useWorker?: boolean;

  /**
   * If true, the worker will log lightweight runtime metrics during initialization
   * (e.g., RSS memory in MB on Linux) to help diagnose startup memory usage.
   * This is a no-op on platforms without /proc.
   */
  logMetrics?: boolean;

  /**
   * Optional JSON Schema definitions that enable the CRUD helper API.
   * Provide the row schema, an ordered list of key descriptors, and any relation metadata.
   */
  schemas?: CrudSchemas;
}

export interface OminipgClientEvents {
  "connected": () => void;
  "sync:start": () => void;
  "sync:end": (details: { pushed: number }) => void;
  "error": (error: Error) => void;
  "close": () => void;
}
