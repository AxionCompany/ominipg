/**
 * @module
 * 
 * Ominipg - The flexible, all-in-one toolkit for PostgreSQL in Deno.
 * 
 * This module provides the main Ominipg class for connecting to PostgreSQL databases
 * (either in-memory via PGlite, persistent file-based, or direct PostgreSQL connections),
 * along with utilities for integrating with Drizzle ORM.
 * 
 * @example
 * ```typescript
 * import { Ominipg } from "jsr:@oxian/ominipg";
 * 
 * // Connect to an in-memory database
 * const db = await Ominipg.connect({
 *   url: ":memory:",
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
 * const db = await Ominipg.connect({ url: ":memory:", schemas });
 * const user = await db.crud.users.create({ id: "1", name: "Alice" });
 * ```
 */

import { TypedEmitter } from "npm:tiny-typed-emitter@2.1.0";
import type { OminipgClientEvents, OminipgConnectionOptions } from "./types.ts";
// Type-only import for pg to avoid loading it unless used by consumers at runtime
// This allows full typing in direct mode without bundling the module unnecessarily in Deno.
import type {
  Pool as PgPool,
  PoolClient as _PgPoolClient,
  QueryResult,
} from "pg";
import { Pool } from "pg";
import type {
  CloseMsg,
  DiagnosticMsg,
  ExecMsg,
  InitMsg,
  ResponseMsg,
  SyncMsg,
  SyncSeqMsg,
  WorkerMsg,
} from "../shared/types.ts";

import type {
  CrudApi,
  CrudSchemas,
} from "./crud/types.ts";
import { createCrudApi } from "./crud/index.ts";


// Lightweight, best-effort RSS reader for metrics logging
function getRssMb(): number | null {
  try {
    if (Deno.build.os === "linux") {
      const statm = Deno.readTextFileSync("/proc/self/statm").split(" ");
      const pages = Number(statm[1]);
      const bytes = pages * 4096;
      return Math.round(bytes / 1024 / 1024);
    }
    if (Deno.build.os === "darwin") {
      const cmd = new Deno.Command("ps", {
        args: ["-o", "rss=", "-p", String(Deno.pid)],
      });
      const out = cmd.outputSync();
      const text = new TextDecoder().decode(out.stdout).trim();
      const kb = parseInt(text || "0", 10);
      if (!Number.isFinite(kb) || kb <= 0) return null;
      return Math.round(kb / 1024);
    }
    return null;
  } catch (_e) {
    return null;
  }
}

class RequestManager {
  private _id = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: ResponseMsg | unknown) => void;
      reject: (reason?: unknown) => void;
      timeoutId: number;
    }
  >();

  constructor(
    private readonly worker: Worker,
    private readonly emitter: TypedEmitter<OminipgClientEvents>,
  ) {
    this.worker.addEventListener("message", this.handleMessage.bind(this));
  }

  private handleMessage(event: MessageEvent<ResponseMsg>) {
    const msg = event.data;
    const reqId = msg.reqId;

    if (msg.type === "error" && !reqId) {
      this.emitter.emit("error", new Error(msg.error));
      return;
    }

    if (!reqId || !this.pending.has(reqId)) {
      return; // Not a message we are waiting for
    }

    const deferred = this.pending.get(reqId)!;
    clearTimeout(deferred.timeoutId);
    this.pending.delete(reqId);

    if (msg.type === "error") {
      deferred.reject(new Error(msg.error));
    } else {
      // Exclude 'type' and 'reqId' from the resolved data
      const { type: _type, reqId: _reqId, ...data } = msg;
      deferred.resolve(data);
    }
  }

  public request<T>(
    message: Omit<WorkerMsg, "reqId">,
    timeout: number = 30000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const reqId = ++this._id;

      const timeoutId = setTimeout(() => {
        this.pending.delete(reqId);
        reject(
          new Error(
            `Database request '${message.type}' timed out after ${timeout}ms`,
          ),
        );
      }, timeout);

      // Wrap the Promise's resolve to satisfy our stored callback type
      this.pending.set(reqId, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        timeoutId: Number(timeoutId),
      });

      this.worker.postMessage({ ...message, reqId });
    });
  }

  public post(message: Omit<WorkerMsg, "reqId">) {
    this.worker.postMessage(message);
  }
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
 * const db = await Ominipg.connect({ url: ":memory:", schemas });
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
 * Provides a unified interface for working with PostgreSQL databases in Deno,
 * supporting multiple connection modes:
 * - **In-memory**: Using PGlite (PostgreSQL in WASM)
 * - **Persistent**: File-based PGlite storage
 * - **Direct**: Direct connection to PostgreSQL server
 * - **Worker**: Database operations in isolated Web Worker
 * 
 * The class extends TypedEmitter to provide event-based notifications for
 * connection, sync, and error events.
 * 
 * @example
 * ```typescript
 * // Basic usage
 * const db = await Ominipg.connect({ url: ":memory:" });
 * await db.query("SELECT 1");
 * await db.close();
 * ```
 * 
 * @example
 * ```typescript
 * // With sync
 * const db = await Ominipg.connect({
 *   url: ":memory:",
 *   syncUrl: "postgresql://user:pass@host:5432/db"
 * });
 * await db.query("INSERT INTO users ...");
 * await db.sync(); // Push changes to remote
 * ```
 */
export class Ominipg extends TypedEmitter<OminipgClientEvents> {
  private readonly mode: "worker" | "direct";
  private readonly worker?: Worker;
  private readonly requests?: RequestManager;
  private readonly pool?: PgPool; // pg.Pool when in direct mode
  public crud?: unknown;

  private constructor(
    mode: "worker" | "direct",
    worker?: Worker,
    pool?: PgPool,
  ) {
    super();
    this.mode = mode;
    this.worker = worker;
    this.requests = worker ? new RequestManager(worker, this) : undefined;
    this.pool = pool;
  }

  /**
   * Connects to a PostgreSQL database and returns an Ominipg instance.
   * 
   * This is the main entry point for creating database connections. The method
   * automatically selects the appropriate connection mode based on the provided options.
   * 
   * @param options - Connection configuration options
   * @returns Promise resolving to an Ominipg instance (with CRUD API if schemas provided)
   * 
   * @example
   * ```typescript
   * // In-memory database
   * const db = await Ominipg.connect({ url: ":memory:" });
   * ```
   * 
   * @example
   * ```typescript
   * // With CRUD schemas
   * const schemas = defineSchema({ users: { ... } });
   * const db = await Ominipg.connect({ url: ":memory:", schemas });
   * // db.crud.users is now available
   * ```
   * 
   * @example
   * ```typescript
   * // Direct PostgreSQL connection
   * const db = await Ominipg.connect({
   *   url: "postgresql://user:pass@host:5432/db",
   *   useWorker: false
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
    const isPg = url.startsWith("postgres://") ||
      url.startsWith("postgresql://");
    const syncDisabled = !options.syncUrl;
    const useWorker = options.useWorker ?? !(isPg && syncDisabled);
    const metricsEnabled = !!options.logMetrics;

    if (!useWorker && isPg && syncDisabled) {
      const before = metricsEnabled ? getRssMb() : null;
      console.log("Using direct Postgres mode");
      const pool = new Pool({ connectionString: url, max: 5 });
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
        if (options.schemaSQL && options.schemaSQL.length > 0) {
          await client.query("BEGIN");
          try {
            for (const stmt of options.schemaSQL) {
              try {
                await client.query(stmt);
              } catch (err) {
                const message = err instanceof Error
                  ? err.message
                  : String(err);
                console.warn(
                  `Direct mode DDL execution failed (this may be ok):`,
                  message,
                );
              }
            }
            await client.query("COMMIT");
          } catch (ddlErr) {
            await client.query("ROLLBACK");
            throw ddlErr;
          }
        }
      } finally {
        client.release();
      }
      console.log("Direct Postgres mode connected");
      if (metricsEnabled) {
        const after = getRssMb();
        if (after != null && before != null) {
          console.log(
            `Direct Postgres initialized (+${
              after - before
            } MB, rss=${after} MB)`,
          );
        }
      }
      const db = new Ominipg("direct", undefined, pool);
      const schemas = options.schemas;
      if (schemas) {
        db.attachCrud(schemas);
        db.emit("connected");
        return db as OminipgWithCrud<S>;
      }
      db.emit("connected");
      return db;
    }

    const beforeWorker = metricsEnabled ? getRssMb() : null;
    const worker = new Worker(
      new URL(`${(() => "../worker/index.ts")()}`, import.meta.url).href,
      { type: "module" },
    );
    if (metricsEnabled) {
      const afterWorker = getRssMb();
      if (afterWorker != null && beforeWorker != null) {
        console.log(
          `Worker created (+${
            afterWorker - beforeWorker
          } MB, rss=${afterWorker} MB)`,
        );
      }
    }
    const db = new Ominipg("worker", worker);

    const { schemas: _schemasForWorker, ...initOptions } = options;
    const initMsg = {
      type: "init" as const,
      ...initOptions,
      url,
    };

    await db.requests!.request<InitMsg>(initMsg, 60000);
    if (metricsEnabled) {
      const afterInit = getRssMb();
      if (afterInit != null && beforeWorker != null) {
        console.log(
          `Worker init complete (+${
            afterInit - beforeWorker
          } MB, rss=${afterInit} MB)`,
        );
      }
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
    if (this.mode === "direct") {
      const client = await this.pool!.connect();
      try {
        const result: QueryResult = await client.query(sql, params ?? []);
        return { rows: result.rows as unknown as TRow[] };
      } finally {
        client.release();
      }
    }
    const message: Omit<ExecMsg, "reqId"> = { type: "exec", sql, params };
    return await this.requests!.request<{ rows: TRow[] }>(message);
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
   * Pushes local changes to the remote database.
   * 
   * This method synchronizes INSERT, UPDATE, and DELETE operations from the local
   * database (PGlite) to the remote PostgreSQL database specified in `syncUrl`.
   * 
   * **Note:** Sync is only available in worker mode with a `syncUrl` configured.
   * Direct PostgreSQL connections do not support sync.
   * 
   * @returns Promise resolving to sync result with count of pushed changes
   * @throws Error if called in direct mode or without syncUrl configured
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
    if (this.mode === "direct") {
      throw new Error("Sync is disabled in direct Postgres mode");
    }
    this.emit("sync:start");
    const message: Omit<SyncMsg, "reqId"> = { type: "sync" };
    const result = await this.requests!.request<{ pushed: number }>(
      message,
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
   * **Note:** Only available in worker mode with sync enabled.
   * 
   * @returns Promise resolving to sync result with count of synced sequences
   * @throws Error if called in direct mode or without syncUrl configured
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
    if (this.mode === "direct") {
      throw new Error("Sync sequences is disabled in direct Postgres mode");
    }
    const message: Omit<SyncSeqMsg, "reqId"> = { type: "sync-sequences" };
    return await this.requests!.request<{ synced: number }>(message, 120000);
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
    if (this.mode === "direct") {
      return {
        mainDatabase: { type: "postgres" },
        syncDatabase: { hasSyncPool: false },
      };
    }
    const message: Omit<DiagnosticMsg, "reqId"> = { type: "diagnostic" };
    const { info } = await this.requests!.request<
      { info: Record<string, unknown> }
    >(message);
    return info;
  }

  /**
   * Closes the database connection and cleans up resources.
   * 
   * In worker mode, this terminates the worker thread. In direct mode,
   * this closes the PostgreSQL connection pool. Always call this method
   * when done with the database to free resources.
   * 
   * @returns Promise that resolves when cleanup is complete
   * 
   * @example
   * ```typescript
   * const db = await Ominipg.connect({ url: ":memory:" });
   * // ... use database ...
   * await db.close();
   * ```
   */
  public async close(): Promise<void> {
    if (this.mode === "direct") {
      await this.pool?.end();
      this.emit("close");
      return;
    }
    const message: Omit<CloseMsg, "reqId"> = { type: "close" };
    this.requests!.post(message);
    this.worker!.terminate();
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
  /** Get diagnostic information about the database */
  getDiagnosticInfo: () => Promise<Record<string, unknown>>;
  /** Close the database connection */
  close: () => Promise<void>;
  /** Execute raw SQL query */
  queryRaw: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: TRow[] }>;
  /** Access to the underlying Ominipg instance */
  _ominipg: Ominipg;
};

export {
  defineSchema,
} from "./crud/index.ts";
export type {
  CrudApi,
  CrudSchemas,
} from "./crud/index.ts";
export type {
  OminipgConnectionOptions,
  OminipgClientEvents,
} from "./types.ts";

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
    getDiagnosticInfo: ominipgInstance.getDiagnosticInfo.bind(ominipgInstance),
    close: ominipgInstance.close.bind(ominipgInstance),

    // Raw query access
    queryRaw: ominipgInstance.query.bind(ominipgInstance),

    // Access to the underlying Ominipg instance
    _ominipg: ominipgInstance,
  }) as TDrizzle & OminipgDrizzleMixin;
}
