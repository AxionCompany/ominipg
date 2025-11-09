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

export type OminipgWithCrud<Schemas extends CrudSchemas> = Ominipg & {
  crud: CrudApi<Schemas>;
};

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
   * @deprecated Use query() instead. This method is kept for backward compatibility.
   */
  public queryRaw<
    TRow extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, params?: unknown[]): Promise<{ rows: TRow[] }> {
    return this.query<TRow>(sql, params);
  }

  /**
   * Pushes local changes to the remote database.
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
   */
  public async syncSequences(): Promise<{ synced: number }> {
    if (this.mode === "direct") {
      throw new Error("Sync sequences is disabled in direct Postgres mode");
    }
    const message: Omit<SyncSeqMsg, "reqId"> = { type: "sync-sequences" };
    return await this.requests!.request<{ synced: number }>(message, 120000);
  }

  /**
   * Retrieves diagnostic information about the worker's state.
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
   * Closes the database connection and terminates the worker.
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

export type OminipgDrizzleMixin = {
  sync: () => Promise<{ pushed: number }>;
  syncSequences: () => Promise<{ synced: number }>;
  getDiagnosticInfo: () => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
  queryRaw: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: TRow[] }>;
  _ominipg: Ominipg;
};

export {
  defineSchema,
} from "./crud/index.ts";
export type {
  CrudApi,
  CrudSchemas,
  CrudTableApi,
  CrudRow,
  InferKey,
  InferRow,
  JsonSchema,
  TableSchemaConfig,
  TableKeyDefinition,
  TableTimestampConfig,
  TableTimestampColumns,
} from "./crud/index.ts";

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
