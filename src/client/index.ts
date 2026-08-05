/**
 * @module
 *
 * Ominipg - Runtime-neutral PostgreSQL and PGlite sessions powered by Oxian.
 *
 * This module provides the main Ominipg class for connecting to PostgreSQL databases
 * (either in-memory via PGlite, persistent file-based, or direct PostgreSQL connections),
 * along with utilities for integrating with Drizzle ORM.
 *
 * @example
 * ```typescript
 * import { Ominipg } from "jsr:@oxian/ominipg";
 * import { createPGliteProvider } from "jsr:@oxian/ominipg/pglite";
 *
 * // Connect to an in-memory database
 * const db = await Ominipg.connect({
 *   url: ":memory:",
 *   pgliteProvider: createPGliteProvider(),
 *   schemaSQL: ["CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)"]
 * });
 *
 * // Execute queries
 * await db.query("INSERT INTO users (name) VALUES ($1)", ["Alice"]);
 * const result = await db.query("SELECT * FROM users");
 *
 * await db.close();
 * ```
 *
 * @example
 * ```typescript
 * import { Ominipg, defineSchema } from "jsr:@oxian/ominipg";
 * import { createPGliteProvider } from "jsr:@oxian/ominipg/pglite";
 *
 * // Connect with CRUD API
 * const schemas = defineSchema({
 *   users: {
 *     schema: {
 *       type: "object",
 *       properties: { id: { type: "string" }, name: { type: "string" } },
 *       required: ["id", "name"]
 *     },
 *     keys: [{ property: "id" }]
 *   }
 * });
 *
 * const db = await Ominipg.connect({
 *   url: ":memory:",
 *   pgliteProvider: createPGliteProvider(),
 *   schemas,
 * });
 * const user = await db.crud.users.create({ id: "1", name: "Alice" });
 * ```
 */

import { TypedEmitter } from "./emitter.ts";
import type {
  OminipgClientEvents,
  OminipgConnectionOptions,
  PgNotification,
  PgSubscription,
} from "./types.ts";
import { validateNotificationChannel } from "./notifications.ts";
import {
  createEmbeddedOminipgSession,
  type OminipgSessionClient,
  openOminipgSession,
} from "../session/index.ts";
import type {
  OminipgProviderDescriptor,
  OminipgSessionInitConfig,
} from "../session/protocol.ts";

import type { CrudApi, CrudSchemas } from "./crud/types.ts";
import { createCrudApi } from "./crud/index.ts";

function describePGliteProvider(
  provider: OminipgConnectionOptions["pgliteProvider"],
): OminipgProviderDescriptor | undefined {
  if (!provider) return undefined;
  const descriptor: OminipgProviderDescriptor = {
    ...(provider.moduleSpecifier
      ? { moduleSpecifier: provider.moduleSpecifier }
      : {}),
    ...(provider.extensionSpecifiers
      ? { extensionSpecifiers: provider.extensionSpecifiers }
      : {}),
  };
  return Object.keys(descriptor).length > 0 ? descriptor : undefined;
}

function describePgProvider(
  provider: OminipgConnectionOptions["pgProvider"],
): OminipgProviderDescriptor | undefined {
  if (!provider) return undefined;
  const descriptor: OminipgProviderDescriptor = {
    ...(provider.moduleSpecifier
      ? { moduleSpecifier: provider.moduleSpecifier }
      : {}),
    ...(provider.logicalReplicationModuleSpecifier
      ? {
        logicalReplicationModuleSpecifier:
          provider.logicalReplicationModuleSpecifier,
      }
      : {}),
  };
  return Object.keys(descriptor).length > 0 ? descriptor : undefined;
}

/**
 * Ominipg instance with CRUD API attached.
 *
 * This type represents an Ominipg instance that has been connected with schemas,
 * providing type-safe CRUD operations via the `crud` property.
 *
 * @typeParam Schemas - The schema definitions used to create the CRUD API
 *
 * @example
 * ```typescript
 * const schemas = defineSchema({ users: { ... } });
 * const db = await Ominipg.connect({ url: ":memory:", pgliteProvider, schemas });
 * // db is now OminipgWithCrud<typeof schemas>
 * await db.crud.users.create({ id: "1", name: "Alice" });
 * ```
 */
export type OminipgWithCrud<Schemas extends CrudSchemas> = Ominipg & {
  crud: CrudApi<Schemas>;
};

/**
 * Main Ominipg database client class.
 *
 * Provides a unified interface for working with PostgreSQL databases across
 * standards-compatible JavaScript runtimes:
 * - **In-memory**: Using PGlite (PostgreSQL in WASM)
 * - **Persistent**: File-based PGlite storage
 * - **Embedded**: An in-process Oxian WorkerHost in the current isolate
 * - **Routed**: A shared WorkerHost or Hypervisor-backed Oxian dispatcher
 *
 * The class extends TypedEmitter to provide event-based notifications for
 * connection, sync, and error events.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const db = await Ominipg.connect({ url: ":memory:", pgliteProvider });
 * await db.query("SELECT 1");
 * await db.close();
 * ```
 *
 * @example
 * ```typescript
 * // With sync
 * const db = await Ominipg.connect({
 *   url: ":memory:",
 *   syncUrl: "postgresql://user:pass@host:5432/db",
 *   pgliteProvider,
 *   pgProvider,
 * });
 * await db.query("INSERT INTO users ...");
 * await db.sync(); // Push changes to remote
 * ```
 */
export class Ominipg extends TypedEmitter<OminipgClientEvents> {
  private readonly session: OminipgSessionClient;
  private closed = false;
  public crud?: unknown;

  private constructor(session: OminipgSessionClient) {
    super();
    this.session = session;
  }

  /**
   * Prepares a file-backed PGlite database and closes it immediately.
   *
   * Use this in a setup or migration process so the memory-sensitive runtime
   * process can open an existing `file://` database and avoid PGlite's first-run
   * initdb path.
   *
   * @param options - Connection options for a PGlite `file://` database.
   */
  public static async prepare(
    options: OminipgConnectionOptions,
  ): Promise<void> {
    const url = options.url ?? "";
    if (!url.startsWith("file://")) {
      throw new Error("Ominipg.prepare() requires a file:// PGlite URL.");
    }
    if (options.syncUrl) {
      throw new Error("Ominipg.prepare() does not support syncUrl.");
    }
    const db = await Ominipg.connect({
      ...options,
    });
    await db.close();
  }

  /**
   * Connects to a PostgreSQL database and returns an Ominipg instance.
   *
   * This is the main entry point for creating database connections. The method
   * creates an embedded Oxian session unless an external dispatcher is supplied.
   *
   * @param options - Connection configuration options
   * @returns Promise resolving to an Ominipg instance (with CRUD API if schemas provided)
   *
   * @example
   * ```typescript
   * // In-memory database
   * const db = await Ominipg.connect({ url: ":memory:", pgliteProvider });
   * ```
   *
   * @example
   * ```typescript
   * // With CRUD schemas
   * const schemas = defineSchema({ users: { ... } });
   * const db = await Ominipg.connect({
   *   url: ":memory:",
   *   pgliteProvider,
   *   schemas,
   * });
   * // db.crud.users is now available
   * ```
   *
   * @example
   * ```typescript
   * // PostgreSQL connection in an embedded Oxian session
   * const db = await Ominipg.connect({
   *   url: "postgresql://user:pass@host:5432/db",
   *   pgProvider
   * });
   * ```
   */
  public static async connect<S extends CrudSchemas>(
    options: OminipgConnectionOptions & { schemas: S },
  ): Promise<OminipgWithCrud<S>>;
  public static async connect(
    options: OminipgConnectionOptions,
  ): Promise<Ominipg>;
  public static async connect<S extends CrudSchemas>(
    options: OminipgConnectionOptions & { schemas?: S },
  ): Promise<Ominipg | OminipgWithCrud<S>> {
    const url = options.url || `:memory:`;
    const pgPoolMax = options.pgPoolMax ?? 5;

    if (!Number.isSafeInteger(pgPoolMax) || pgPoolMax < 1) {
      throw new Error("pgPoolMax must be a positive integer.");
    }

    const embedded = options.oxian ? undefined : createEmbeddedOminipgSession({
      pgliteProvider: options.pgliteProvider,
      pgProvider: options.pgProvider,
      pgliteConfig: options.pgliteConfig,
      getRssMb: options.runtime?.getRssMb,
    });
    const clientRef: { current?: Ominipg } = {};
    let session: OminipgSessionClient;
    try {
      session = await openOminipgSession(
        options.oxian ?? embedded!.transport,
        {
          onError(error) {
            clientRef.current?.emit("error", error);
          },
          onClose: () => embedded?.close(),
        },
      );
    } catch (error) {
      await embedded?.close().catch(() => {});
      throw error;
    }
    const db = new Ominipg(session);
    clientRef.current = db;

    const {
      schemas: _schemas,
      oxian: _oxian,
      runtime: _runtime,
      useWorker: _legacyUseWorker,
      pgliteProvider: _pgliteProvider,
      pgProvider: _pgProvider,
      pgliteConfig,
      ...wireOptions
    } = options;
    const pgliteDescriptor = describePGliteProvider(options.pgliteProvider);
    const pgDescriptor = describePgProvider(options.pgProvider);
    const initConfig: OminipgSessionInitConfig = {
      ...wireOptions,
      url,
      pgPoolMax,
      // Arbitrary PGlite configuration remains process-local for embedded
      // sessions. Routed workers receive only values that cross the byte stream.
      ...(options.oxian && pgliteConfig ? { pgliteConfig } : {}),
      ...(pgliteDescriptor ? { pgliteProvider: pgliteDescriptor } : {}),
      ...(pgDescriptor ? { pgProvider: pgDescriptor } : {}),
    };

    try {
      await session.request<void>("initialize", initConfig, 60_000);
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
    const schemas = options.schemas;
    if (schemas) {
      db.attachCrud(schemas);
      db.emit("connected");
      return db as OminipgWithCrud<S>;
    }

    db.emit("connected");

    return db;
  }

  /**
   * Executes a raw SQL query. This is the core method that can be used
   * directly or wrapped by ORMs like Drizzle.
   *
   * @typeParam TRow - The shape of each row in the result set
   * @param sql - SQL query string with optional placeholders ($1, $2, etc.)
   * @param params - Optional array of parameters to bind to placeholders
   * @returns Promise resolving to query result with rows array
   *
   * @example
   * ```typescript
   * // Simple query
   * const result = await db.query("SELECT * FROM users");
   * console.log(result.rows);
   * ```
   *
   * @example
   * ```typescript
   * // Parameterized query
   * const result = await db.query(
   *   "SELECT * FROM users WHERE age > $1",
   *   [18]
   * );
   * ```
   *
   * @example
   * ```typescript
   * // Typed result
   * interface User { id: number; name: string; }
   * const result = await db.query<User>("SELECT * FROM users");
   * ```
   */
  public async query<
    TRow extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, params?: unknown[]): Promise<{ rows: TRow[] }> {
    if (this.closed) throw new Error("Ominipg instance is closed.");
    return await this.session.request<{ rows: TRow[] }>("query", {
      sql,
      params,
    });
  }

  /**
   * Executes a raw SQL query (deprecated alias for query).
   *
   * @deprecated Use {@link Ominipg.query} instead. This method is kept for backward compatibility.
   *
   * @typeParam TRow - The shape of each row in the result set
   * @param sql - SQL query string with optional placeholders
   * @param params - Optional array of parameters
   * @returns Promise resolving to query result with rows array
   */
  public queryRaw<
    TRow extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, params?: unknown[]): Promise<{ rows: TRow[] }> {
    return this.query<TRow>(sql, params);
  }

  /**
   * Runs a callback in a transaction pinned to this workload session.
   * Queries are serialized on the same PGlite engine or PostgreSQL connection.
   */
  public async transaction<T>(
    callback: (transaction: Ominipg) => T | Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error("Ominipg instance is closed.");
    await this.query("BEGIN");
    try {
      const result = await callback(this);
      await this.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await this.query("ROLLBACK");
      } catch {
        // Preserve the callback/commit failure as the primary error.
      }
      throw error;
    }
  }

  /**
   * Subscribes to a PostgreSQL notification channel through the workload session.
   *
   * All subscriptions on this Ominipg instance share one pinned connection.
   * The listener reconnects with capped backoff and reissues active LISTENs.
   */
  public async listen(
    channel: string,
    handler: (notification: PgNotification) => void,
  ): Promise<PgSubscription> {
    if (this.closed) throw new Error("Ominipg instance is closed.");
    validateNotificationChannel(channel);
    return await this.session.listen(channel, handler);
  }

  /** Sends a PostgreSQL notification using parameterized `pg_notify`. */
  public async notify(channel: string, payload = ""): Promise<void> {
    if (this.closed) throw new Error("Ominipg instance is closed.");
    validateNotificationChannel(channel);
    await this.session.request("notify", { channel, payload });
  }

  /**
   * Pushes local changes to the remote database.
   *
   * This method synchronizes INSERT, UPDATE, and DELETE operations from the local
   * database (PGlite) to the remote PostgreSQL database specified in `syncUrl`.
   *
   * **Note:** Sync requires a `syncUrl` configured on the workload engine.
   *
   * @returns Promise resolving to sync result with count of pushed changes
   * @throws Error if called without syncUrl configured
   *
   * @example
   * ```typescript
   * const db = await Ominipg.connect({
   *   url: ":memory:",
   *   syncUrl: "postgresql://user:pass@host:5432/db"
   * });
   *
   * // Make local changes
   * await db.query("INSERT INTO users (name) VALUES ($1)", ["Alice"]);
   *
   * // Sync to remote
   * const result = await db.sync();
   * console.log(`Pushed ${result.pushed} changes`);
   * ```
   */
  public async sync(): Promise<{ pushed: number }> {
    if (this.closed) throw new Error("Ominipg instance is closed.");
    this.emit("sync:start");
    const result = await this.session.request<{ pushed: number }>(
      "sync",
      undefined,
      120000,
    );
    this.emit("sync:end", result);
    return result;
  }

  /**
   * Synchronizes sequence values from the remote database.
   *
   * This ensures that auto-increment sequences (SERIAL columns) in the local
   * database are synchronized with the remote database to prevent ID conflicts.
   *
   * **Note:** Only available with sync enabled.
   *
   * @returns Promise resolving to sync result with count of synced sequences
   * @throws Error if called without syncUrl configured
   *
   * @example
   * ```typescript
   * const db = await Ominipg.connect({
   *   url: ":memory:",
   *   syncUrl: "postgresql://user:pass@host:5432/db"
   * });
   *
   * // Sync sequences before inserting new records
   * await db.syncSequences();
   * await db.query("INSERT INTO users (name) VALUES ($1)", ["Alice"]);
   * ```
   */
  public async syncSequences(): Promise<{ synced: number }> {
    if (this.closed) throw new Error("Ominipg instance is closed.");
    return await this.session.request<{ synced: number }>(
      "sync-sequences",
      undefined,
      120000,
    );
  }

  /**
   * Dumps the active PGlite data directory as a Blob.
   *
   * Use the returned Blob with PGlite's `loadDataDir` option to restore the
   * database in a later process. This is only available for PGlite connections.
   */
  public async dumpDataDir(): Promise<Blob> {
    if (this.closed) throw new Error("Ominipg instance is closed.");
    const { dataDirBytes, dataDirType } = await this.session.request<{
      dataDirBytes: Uint8Array;
      dataDirType?: string;
    }>("dump-data-dir", undefined, 120000);
    const bytes = dataDirBytes;
    const buffer = bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer as ArrayBuffer;
    return new Blob([buffer], { type: dataDirType });
  }

  /**
   * Retrieves diagnostic information about the database connection state.
   *
   * Returns information about the database type, sync configuration, and
   * tracked tables. Useful for debugging and monitoring.
   *
   * @returns Promise resolving to diagnostic information object
   *
   * @example
   * ```typescript
   * const info = await db.getDiagnosticInfo();
   * console.log("Database type:", info.mainDatabase.type);
   * console.log("Tracked tables:", info.trackedTables);
   * ```
   */
  public async getDiagnosticInfo(): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error("Ominipg instance is closed.");
    const { info } = await this.session.request<
      { info: Record<string, unknown> }
    >("diagnostics");
    return info;
  }

  /**
   * Closes the database connection and cleans up resources.
   *
   * This closes the workload session and its database resources. A private
   * embedded host is also shut down; an injected shared host remains owned by
   * its application. Always call this method
   * when done with the database to free resources.
   *
   * @returns Promise that resolves when cleanup is complete
   *
   * @example
   * ```typescript
   * const db = await Ominipg.connect({ url: ":memory:", pgliteProvider });
   * // ... use database ...
   * await db.close();
   * ```
   */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.session.close();
    this.emit("close");
  }

  private attachCrud<S extends CrudSchemas>(schemas: S): CrudApi<S> {
    const crud = createCrudApi(
      schemas,
      async (sql: string, params?: unknown[]) => {
        const result = await this.query(sql, params as unknown[] | undefined);
        return { rows: result.rows as unknown[] };
      },
    );
    this.crud = crud;
    return crud;
  }
}

/**
 * Type representing the additional methods added to a Drizzle instance
 * when wrapped with {@link withDrizzle}.
 *
 * This mixin provides access to Ominipg-specific functionality (sync, diagnostics)
 * while maintaining full Drizzle ORM compatibility.
 *
 * @example
 * ```typescript
 * const db = await withDrizzle(ominipg, drizzle, schema);
 * // db has all Drizzle methods plus:
 * await db.sync();
 * await db.getDiagnosticInfo();
 * await db.close();
 * ```
 */
export type OminipgDrizzleMixin = {
  /** Push local changes to remote database */
  sync: () => Promise<{ pushed: number }>;
  /** Synchronize sequence values from remote */
  syncSequences: () => Promise<{ synced: number }>;
  /** Dump the active PGlite data directory as a Blob */
  dumpDataDir: () => Promise<Blob>;
  /** Get diagnostic information about the database */
  getDiagnosticInfo: () => Promise<Record<string, unknown>>;
  /** Close the database connection */
  close: () => Promise<void>;
  /** Execute raw SQL query */
  queryRaw: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: TRow[] }>;
  /** Run a callback in one workload-scoped transaction. */
  transaction: <T>(
    callback: (transaction: Ominipg) => T | Promise<T>,
  ) => Promise<T>;
  /** Access to the underlying Ominipg instance */
  _ominipg: Ominipg;
};

export { defineSchema } from "./crud/index.ts";
export type { CrudApi, CrudSchemas, JsonSchema } from "./crud/index.ts";
export type {
  OminipgClientEvents,
  OminipgConnectionOptions,
  PgNotification,
  PgSubscription,
  PgSubscriptionState,
} from "./types.ts";
export {
  createOminipgWorkload,
  OMINIPG_SESSION_PROTOCOL,
  OMINIPG_SESSION_WORKLOAD,
} from "../session/index.ts";
export type {
  OminipgDispatcher,
  OminipgSessionTransport,
  OminipgWorkloadOptions,
} from "../session/index.ts";

/**
 * Creates a Drizzle ORM adapter for an Ominipg instance.
 * This allows you to use Drizzle syntax while leveraging Ominipg's features.
 *
 * @param ominipgInstance - The Ominipg instance to wrap
 * @param drizzleFactory - The drizzle function from 'drizzle-orm/pg-proxy'
 * @param schema - Optional Drizzle schema object
 * @returns A Drizzle instance with Ominipg methods added
 *
 * @example
 * ```typescript
 * import { Ominipg, withDrizzle } from 'jsr:@oxian/ominipg';
 * import { drizzle } from 'npm:drizzle-orm/pg-proxy';
 *
 * const ominipg = await Ominipg.connect({...});
 * const db = withDrizzle(ominipg, drizzle, schema);
 *
 * // Use Drizzle syntax
 * const users = await db.select().from(userTable);
 *
 * // Ominipg methods are still available
 * await db.sync();
 * ```
 */
export function withDrizzle<TDrizzle, TSchema extends Record<string, unknown>>(
  ominipgInstance: Ominipg,
  drizzleFactory: (
    callback: (
      sql: string,
      params: unknown[],
      method?: string | undefined,
    ) => Promise<{ rows: unknown[] }>,
    config?: { schema?: TSchema },
  ) => TDrizzle,
  schema?: TSchema,
): TDrizzle & OminipgDrizzleMixin;

/**
 * Creates a Drizzle ORM adapter for an Ominipg instance (with automatic drizzle import).
 * This version automatically imports drizzle-orm for convenience.
 *
 * @param ominipgInstance - The Ominipg instance to wrap
 * @param schema - Optional Drizzle schema object
 * @returns A Promise resolving to a Drizzle instance with Ominipg methods added
 *
 * @example
 * ```typescript
 * import { Ominipg, withDrizzle } from 'jsr:@oxian/ominipg';
 *
 * const ominipg = await Ominipg.connect({...});
 * const db = await withDrizzle(ominipg, schema);
 *
 * // Use Drizzle syntax
 * const users = await db.select().from(userTable);
 *
 * // Ominipg methods are still available
 * await db.sync();
 * ```
 */
export function withDrizzle(
  ominipgInstance: Ominipg,
  schema?: Record<string, unknown>,
): Promise<never>;

export function withDrizzle<TDrizzle, TSchema extends Record<string, unknown>>(
  ominipgInstance: Ominipg,
  drizzleFactoryOrSchema?:
    | ((
      callback: (
        sql: string,
        params: unknown[],
        method?: string | undefined,
      ) => Promise<{ rows: unknown[] }>,
      config?: { schema?: TSchema },
    ) => TDrizzle)
    | TSchema,
  schema?: TSchema,
): (TDrizzle & OminipgDrizzleMixin) | Promise<never> {
  // Check if first argument is the drizzle factory function
  if (typeof drizzleFactoryOrSchema === "function") {
    // Version 1: User provided drizzle factory
    return createDrizzleAdapter(
      ominipgInstance,
      drizzleFactoryOrSchema as (
        callback: (
          sql: string,
          params: unknown[],
          method?: string | undefined,
        ) => Promise<{ rows: unknown[] }>,
        config?: { schema?: TSchema },
      ) => TDrizzle,
      schema as TSchema,
    );
  } else {
    // Version 2: Auto-import drizzle (async)
    throw new Error(
      'Auto-import of drizzle is not supported yet. Please use the explicit import: import { drizzle } from "npm:drizzle-orm/pg-proxy";',
    );
    // return createDrizzleAdapterAsync(ominipgInstance, drizzleFactoryOrSchema as Record<string, any> | undefined);
  }
}

function createDrizzleAdapter<
  TDrizzle,
  TSchema extends Record<string, unknown>,
>(
  ominipgInstance: Ominipg,
  drizzleFactory: (
    callback: (
      sql: string,
      params: unknown[],
      method?: string | undefined,
    ) => Promise<{ rows: unknown[] }>,
    config?: { schema?: TSchema },
  ) => TDrizzle,
  schema?: TSchema,
): TDrizzle & OminipgDrizzleMixin {
  const drizzleProxy = drizzleFactory(
    async (sql: string, params: unknown[], method?: string | undefined) => {
      try {
        const result = await ominipgInstance.query(sql, params as unknown[]);

        // Handle different return formats based on method
        if ((method as unknown as string | undefined) === "all") {
          // For 'all' method, convert objects to arrays (string[][])
          if (result.rows.length > 0 && typeof result.rows[0] === "object") {
            const columnNames = Object.keys(result.rows[0]);
            const arrayRows = result.rows.map((row) =>
              columnNames.map((col) => (row as Record<string, unknown>)[col])
            );
            return { rows: arrayRows as unknown[] };
          }
          return { rows: [] };
        } else {
          // For other methods ('execute' or undefined), return objects as-is
          return { rows: result.rows as unknown[] };
        }
      } catch (error) {
        console.error("Database query error:", error);
        throw error;
      }
    },
    { schema },
  );

  // Add Ominipg-specific methods to the Drizzle instance
  return Object.assign(drizzleProxy as unknown as object, {
    // Ominipg sync methods
    sync: ominipgInstance.sync.bind(ominipgInstance),
    syncSequences: ominipgInstance.syncSequences.bind(ominipgInstance),
    dumpDataDir: ominipgInstance.dumpDataDir.bind(ominipgInstance),
    getDiagnosticInfo: ominipgInstance.getDiagnosticInfo.bind(ominipgInstance),
    close: ominipgInstance.close.bind(ominipgInstance),

    // Raw query access
    queryRaw: ominipgInstance.query.bind(ominipgInstance),
    transaction: ominipgInstance.transaction.bind(ominipgInstance),

    // Access to the underlying Ominipg instance
    _ominipg: ominipgInstance,
  }) as TDrizzle & OminipgDrizzleMixin;
}
