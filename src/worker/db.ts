import {
  type OminipgTransactionOptions,
  transactionBegin,
} from "../shared/transaction.ts";
import { detectDatabaseType } from "./utils.ts";
import { transactionControl } from "./transaction-control.ts";
import { AccountedPgPool } from "./pool-capacity.ts";
import { applyDefaultLowMemoryPGliteConfig } from "../shared/pglite_config.ts";
import type {
  LogicalReplicationServiceLike,
  OminipgEngineConfig,
  PGliteConfig,
  PGliteConstructor,
  PGliteExtensionsMap,
  PGliteModule,
  PGliteProvider,
  PgLogicalReplicationModule,
  PgModule,
  PgPool,
  PgPoolClient,
  PgProvider,
} from "../shared/types.ts";

/*───────────────── Types ──────────────────*/

export interface DatabaseClient {
  query(
    sql: string,
    params?: unknown[],
    transaction?: string,
    begin?: OminipgTransactionOptions,
    end?: "commit",
  ): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<void>;
  listen?(channel: string, callback: () => void): Promise<void>;
  dumpDataDir?(): Promise<Blob>;
  close(): Promise<void>;
}

/*───────────────── State ──────────────────*/

export type { PgPool, PgPoolClient } from "../shared/types.ts";

export type EngineDependencies = Readonly<{
  pgliteProvider?: PGliteProvider;
  pgProvider?: PgProvider;
  pgliteConfig?: PGliteConfig;
  onError?: (error: Error) => void;
  /** Optional, runtime-owned memory probe used only by diagnostic logging. */
  getRssMb?: () => number | null;
}>;

/**
 * All mutable state owned by one Ominipg workload session.
 *
 * Keeping this state explicit is what allows multiple embedded Workers (or
 * multiple sessions on one shared Hypervisor) to coexist in the same isolate.
 */
export interface EngineState {
  mainDb?: DatabaseClient;
  mainDbType?: "pglite" | "postgres";
  mainPool: PgPool | null;
  syncPool: PgPool | null;
  pgliteProvider?: PGliteProvider;
  pgProvider?: PgProvider;
  pgliteConfig?: PGliteConfig;
  readonly activePgliteExtensions: Set<string>;
  readonly meta: Map<string, { pk: string[]; non: string[] }>;
  readonly recentlyPushed: Map<
    string,
    Map<string, { op: string; lww: unknown }>
  >;
  edgeId: string;
  lwwColumn: string;
  replicationOriginSupported: boolean;
  replicationService: LogicalReplicationServiceLike | null;
  syncStarted: boolean;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  readonly getRssMb: () => number | null;
  readonly reportError: (error: Error) => void;
}

export function createEngineState(
  dependencies: EngineDependencies = {},
): EngineState {
  return {
    mainPool: null,
    syncPool: null,
    pgliteProvider: dependencies.pgliteProvider,
    pgProvider: dependencies.pgProvider,
    pgliteConfig: dependencies.pgliteConfig,
    activePgliteExtensions: new Set(),
    meta: new Map(),
    recentlyPushed: new Map(),
    edgeId: crypto.randomUUID(),
    lwwColumn: "updated_at",
    replicationOriginSupported: true,
    replicationService: null,
    syncStarted: false,
    timers: new Set(),
    getRssMb: dependencies.getRssMb ?? (() => null),
    reportError: dependencies.onError ?? (() => {}),
  };
}

export function requireMainDb(state: EngineState): DatabaseClient {
  if (!state.mainDb) throw new Error("Ominipg engine is not initialized.");
  return state.mainDb;
}

/*───────────────── PGlite Adapter ──────────────────*/

// Minimal PGlite interface
interface PGliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
  listen(channel: string, callback: () => void): Promise<unknown>;
  dumpDataDir?(): Promise<Blob>;
  close(): Promise<void>;
}

class PGliteAdapter implements DatabaseClient {
  constructor(private pglite: PGliteLike) {}

  async query(
    sql: string,
    params?: unknown[],
    _transaction?: string,
    begin?: OminipgTransactionOptions,
    end?: "commit",
  ) {
    if (begin !== undefined) await this.pglite.query(transactionBegin(begin));
    const result = await this.pglite.query(sql, params ?? []);
    if (end === "commit") await this.pglite.query("COMMIT");
    return result;
  }

  async exec(sql: string) {
    await this.pglite.exec(sql);
  }

  async listen(channel: string, callback: () => void) {
    await this.pglite.listen(channel, callback);
  }

  async dumpDataDir() {
    if (!this.pglite.dumpDataDir) {
      throw new Error("This PGlite version does not support dumpDataDir().");
    }
    return await this.pglite.dumpDataDir();
  }

  async close() {
    await this.pglite.close();
  }
}

async function importModule<T>(specifier: string): Promise<T> {
  return await import(specifier) as T;
}

function installHint(
  engine: "pglite" | "pg" | "pg-logical-replication",
) {
  if (engine === "pglite") {
    return 'Install or map "@electric-sql/pglite", or pass a compatible pgliteProvider owned by the workload runtime.';
  }
  if (engine === "pg-logical-replication") {
    return 'Install or map "pg-logical-replication", or pass a compatible pgProvider owned by the workload runtime.';
  }
  return 'Install or map "pg", or pass a compatible pgProvider owned by the workload runtime.';
}

function engineLoadError(
  engine: "pglite" | "pg" | "pg-logical-replication",
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  if (engine === "pglite") {
    return new Error(
      `Failed to load PGlite provider: ${message}\n\n${installHint("pglite")}`,
    );
  }
  if (engine === "pg-logical-replication") {
    return new Error(
      `Failed to load pg-logical-replication provider: ${message}\n\n${
        installHint("pg-logical-replication")
      }`,
    );
  }
  return new Error(
    `Failed to load PostgreSQL provider: ${message}\n\n${installHint("pg")}`,
  );
}

async function loadPGliteModule(
  provider?: PGliteProvider,
): Promise<PGliteModule> {
  try {
    if (provider?.loadPGlite) {
      return await provider.loadPGlite();
    }
    if (provider?.moduleSpecifier) {
      return await importModule<PGliteModule>(provider.moduleSpecifier);
    }
  } catch (error) {
    throw engineLoadError("pglite", error);
  }
  throw new Error(
    "PGlite connections require a pgliteProvider. Import createPGliteProvider from '@oxian/ominipg/pglite' (or 'jsr:@oxian/ominipg/pglite' in Deno) and pass it to Ominipg.connect().",
  );
}

async function loadPGliteExtension(
  provider: PGliteProvider | undefined,
  name: string,
): Promise<Record<string, unknown>> {
  if (provider?.loadExtension) {
    return await provider.loadExtension(name);
  }
  const specifier = provider?.extensionSpecifiers?.[name];
  if (specifier) {
    return await importModule<Record<string, unknown>>(specifier);
  }
  throw new Error(`Unsupported PGlite extension: ${name}`);
}

async function loadPgModule(provider?: PgProvider): Promise<PgModule> {
  try {
    if (provider?.loadPg) {
      return await provider.loadPg();
    }
    if (provider?.moduleSpecifier) {
      return await importModule<PgModule>(provider.moduleSpecifier);
    }
  } catch (error) {
    throw engineLoadError("pg", error);
  }
  throw new Error(
    "PostgreSQL connections require a pgProvider. Import createPgProvider from '@oxian/ominipg/pg' (or 'jsr:@oxian/ominipg/pg' in Deno) and pass it to Ominipg.connect().",
  );
}

export async function loadLogicalReplicationModule(
  state: EngineState,
): Promise<
  PgLogicalReplicationModule
> {
  try {
    if (state.pgProvider?.loadLogicalReplication) {
      return await state.pgProvider.loadLogicalReplication();
    }
    if (state.pgProvider?.logicalReplicationModuleSpecifier) {
      return await importModule<PgLogicalReplicationModule>(
        state.pgProvider.logicalReplicationModuleSpecifier,
      );
    }
  } catch (error) {
    throw engineLoadError("pg-logical-replication", error);
  }
  throw new Error(
    "Sync requires pgProvider.loadLogicalReplication or logicalReplicationModuleSpecifier.",
  );
}

/**
 * Dynamically imports PGlite extensions based on their names
 */
async function loadExtensions(
  state: EngineState,
  provider: PGliteProvider | undefined,
  extensionNames: string[],
  logMetrics?: boolean,
): Promise<PGliteExtensionsMap> {
  const extensions: PGliteExtensionsMap = {};

  for (const extensionName of extensionNames) {
    try {
      const before = state.getRssMb();
      const extensionModule = await loadPGliteExtension(
        provider,
        extensionName,
      );
      // The extension is typically exported with the same name as the module
      const resolved = extensionModule[extensionName] ??
        extensionModule.default ?? extensionModule;
      extensions[extensionName] = resolved as PGliteExtensionsMap[string];
      if (logMetrics) {
        const after = state.getRssMb();
        if (after != null && before != null) {
          console.log(
            `PGlite module loaded: ${extensionName} (+${
              after - before
            } MB, rss=${after} MB)`,
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `⚠ Failed to load PGlite extension "${extensionName}": ${message}\n` +
          installHint("pglite"),
      );
    }
  }

  return extensions;
}

function mergePGliteConfig(
  baseConfig: PGliteConfig | undefined,
  extensions: PGliteExtensionsMap,
  memoryProfile: "default" | "low-memory" | undefined,
): PGliteConfig | undefined {
  const effectiveBaseConfig = (memoryProfile ?? "low-memory") === "low-memory"
    ? applyDefaultLowMemoryPGliteConfig(baseConfig)
    : baseConfig;
  const hasExtensions = Object.keys(extensions).length > 0;
  if (!effectiveBaseConfig && !hasExtensions) {
    return undefined;
  }

  const config: PGliteConfig = effectiveBaseConfig
    ? { ...effectiveBaseConfig }
    : {};

  if (hasExtensions) {
    const existing = config.extensions;
    if (existing != null && typeof existing !== "object") {
      console.warn(
        "pgliteConfig.extensions must be an object; overriding with generated extension map.",
      );
    }
    const mergedExtensions: PGliteExtensionsMap = {
      ...(existing && typeof existing === "object"
        ? existing as PGliteExtensionsMap
        : {}),
      ...extensions,
    };
    config.extensions = mergedExtensions;
  }

  return config;
}

function recordActiveExtensions(
  state: EngineState,
  extensionSqlNames: string[],
) {
  state.activePgliteExtensions.clear();
  for (const timer of state.timers) clearTimeout(timer);
  state.timers.clear();
  for (const name of extensionSqlNames) {
    state.activePgliteExtensions.add(name.toLowerCase());
  }
}

async function initializePGlite(
  state: EngineState,
  url: string,
  extensionNames: string[] = [],
  logMetrics?: boolean,
  pgliteConfig?: PGliteConfig,
  pgliteMemoryProfile?: "default" | "low-memory",
  provider?: PGliteProvider,
): Promise<DatabaseClient> {
  const loaded = await loadPGliteModule(provider);
  const PGlite = loaded.PGlite as PGliteConstructor;
  const extensions = extensionNames.length > 0
    ? await loadExtensions(state, provider, extensionNames, logMetrics)
    : {};
  const mergedConfig = mergePGliteConfig(
    pgliteConfig,
    extensions,
    pgliteMemoryProfile,
  );
  const loadedExtensionNames = Object.keys(extensions);

  if (url === ":memory:" || url === "") {
    const before = state.getRssMb();
    const adapter = new PGliteAdapter(
      (mergedConfig
        ? new PGlite(mergedConfig)
        : new PGlite()) as unknown as PGliteLike,
    );
    let activatedSqlNames: string[] = [];
    if (loadedExtensionNames.length > 0) {
      activatedSqlNames = await createExtensions(adapter, loadedExtensionNames);
      if (logMetrics) {
        const after = state.getRssMb();
        if (after != null && before != null) {
          console.log(
            `PGlite initialized in-memory (+${
              after - before
            } MB, rss=${after} MB)`,
          );
        }
      }
    }
    recordActiveExtensions(state, activatedSqlNames);
    return adapter;
  }

  const dbPath = url.replace("file://", "");
  const before = state.getRssMb();
  try {
    // Extension WASM modules must always be in the constructor config so that
    // extension functions (vector ops, pg_trgm, etc.) are available at runtime.
    // On re-open, we skip CREATE EXTENSION SQL (which aborts the WASM) but
    // still need the modules loaded.
    const pglite = mergedConfig
      ? new PGlite(dbPath, mergedConfig)
      : new PGlite(dbPath);
    const adapter = new PGliteAdapter(
      pglite as unknown as PGliteLike,
    );
    let activatedSqlNames: string[] = [];
    if (loadedExtensionNames.length > 0) {
      // The engine itself can ask PostgreSQL which extensions already exist;
      // no host filesystem probing is required. This is portable across Deno,
      // Node, Bun, and isolate runtimes with a compatible PGlite provider.
      activatedSqlNames = await createExtensions(
        adapter,
        loadedExtensionNames,
      );
      if (logMetrics) {
        const after = state.getRssMb();
        if (after != null && before != null) {
          console.log(
            `PGlite initialized file-db (+${
              after - before
            } MB, rss=${after} MB)`,
          );
        }
      }
    }
    recordActiveExtensions(state, activatedSqlNames);
    return adapter;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `File-based PGlite failed (${message}), falling back to in-memory.`,
    );
    const fallbackConfig = mergedConfig;
    const adapter = new PGliteAdapter(
      (fallbackConfig
        ? new PGlite(fallbackConfig)
        : new PGlite()) as unknown as PGliteLike,
    );
    let activatedSqlNames: string[] = [];
    if (loadedExtensionNames.length > 0) {
      activatedSqlNames = await createExtensions(adapter, loadedExtensionNames);
      if (logMetrics) {
        const after = state.getRssMb();
        if (after != null && before != null) {
          console.log(
            `PGlite initialized (fallback, in-memory) (+${
              after - before
            } MB, rss=${after} MB)`,
          );
        }
      }
    }
    recordActiveExtensions(state, activatedSqlNames);
    return adapter;
  }
}

/**
 * Creates/activates extensions in the PGlite database
 */
async function createExtensions(
  adapter: DatabaseClient,
  extensionNames: string[],
): Promise<string[]> {
  // Map extension names to their PostgreSQL extension names
  const extensionSqlNames: Record<string, string> = {
    "uuid_ossp": "uuid-ossp",
    "vector": "vector",
    "live": "live",
    "amcheck": "amcheck",
    "auto_explain": "auto_explain",
    "bloom": "bloom",
    "btree_gin": "btree_gin",
    "btree_gist": "btree_gist",
    "citext": "citext",
    "cube": "cube",
    "earthdistance": "earthdistance",
    "fuzzystrmatch": "fuzzystrmatch",
    "hstore": "hstore",
    "isn": "isn",
    "lo": "lo",
    "ltree": "ltree",
    "pg_trgm": "pg_trgm",
    "seg": "seg",
    "tablefunc": "tablefunc",
    "tcn": "tcn",
    "tsm_system_rows": "tsm_system_rows",
    "tsm_system_time": "tsm_system_time",
  };

  // On file-based PGlite, extensions may already be persisted from a previous
  // run. Re-running CREATE EXTENSION can abort the WASM runtime, bricking the
  // entire instance. Query pg_extension first and skip anything already present.
  let existing: Set<string>;
  try {
    const result = await adapter.query("SELECT extname FROM pg_extension");
    existing = new Set(
      (result.rows as Array<{ extname: string }>).map((r) =>
        r.extname.toLowerCase()
      ),
    );
  } catch {
    existing = new Set();
  }

  const activated: string[] = [];

  for (const extensionName of extensionNames) {
    try {
      const sqlName = extensionSqlNames[extensionName] || extensionName;
      if (existing.has(sqlName.toLowerCase())) {
        activated.push(sqlName);
        continue;
      }
      await adapter.exec(`CREATE EXTENSION IF NOT EXISTS "${sqlName}"`);
      activated.push(sqlName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `⚠ Failed to create PGlite extension "${extensionName}": ${message}`,
      );
    }
  }

  return activated;
}

/*───────────────── PostgreSQL Adapter ──────────────────*/

/** The lane of a BEGIN sent without one; unlaned statements then join it. */
const DEFAULT_TRANSACTION = "";

class PostgresAdapter implements DatabaseClient {
  private readonly transactions = new Map<string, PgPoolClient>();
  private readonly failedStarts = new Set<string>();
  private readonly opening = new Map<string, Promise<{ rows: unknown[] }>>();
  private readonly pendingPinned = new Set<Promise<unknown>>();
  private readonly cleanupFailures: unknown[] = [];
  private closing = false;
  private closeTask?: Promise<void>;

  constructor(readonly pool: AccountedPgPool) {}

  async query(
    sql: string,
    params?: unknown[],
    transaction?: string,
    begin?: OminipgTransactionOptions,
    end?: "commit",
  ) {
    if (this.closing) throw new Error("PostgreSQL adapter is closed.");
    const beginSql = begin === undefined ? undefined : transactionBegin(begin);
    let control: ReturnType<typeof transactionControl> = beginSql === undefined
      ? transactionControl(sql)
      : { kind: "other" };
    const lane = transaction ?? DEFAULT_TRANSACTION;
    const ending = end === "commit";
    // A newline before the separator also handles SQL ending in a line comment.
    const statement = ending && !params?.length ? `${sql}\n;\nCOMMIT` : sql;
    const execute = async (client: PgPoolClient) => {
      const result = await client.query(statement, params ?? []);
      if (ending && params?.length) await client.query("COMMIT", []);
      return ending && Array.isArray(result) ? result[0] : result;
    };
    if (beginSql !== undefined || control.kind === "begin") {
      if (this.transactions.has(lane) || this.opening.has(lane)) {
        throw new Error("A PostgreSQL transaction is already active.");
      }
      // Register before provider code runs: close owns every admitted open,
      // including a checkout or BEGIN that has not settled yet.
      const task = Promise.resolve().then(async () => {
        const client = await this.pool.connect();
        let result: { rows: unknown[] };
        let beginConfirmed = false;
        try {
          if (beginSql === undefined) {
            result = await execute(client);
          } else {
            try {
              control = transactionControl(sql);
            } catch (error) {
              // Preserve the active transaction after a rejected control batch.
              await client.query(beginSql, []);
              beginConfirmed = true;
              throw error;
            }
            if (control.kind === "other" && !params?.length) {
              // pg uses the simple protocol for unparameterized queries and
              // returns one result per command. Exclude our BEGIN result.
              const batch = await client.query(
                `${beginSql};\n${statement}`,
                [],
              );
              // Drop BEGIN's own result so callers see what `sql` alone returns.
              result = !Array.isArray(batch)
                ? batch
                : ending || batch.length === 2
                ? batch[1]
                : batch.slice(1) as unknown as { rows: unknown[] };
            } else {
              // Extended protocol accepts only one statement per Parse.
              await client.query(beginSql, []);
              beginConfirmed = true;
              if (control.kind === "begin") {
                throw new Error("A PostgreSQL transaction is already active.");
              }
              result = await execute(client);
            }
          }
        } catch (error) {
          if (
            beginSql !== undefined && !this.closing && control.kind !== "end"
          ) {
            this.transactions.set(lane, client);
            // A batch parse error may prevent BEGIN executing. Keep ownership,
            // but refuse further work until an ending; never allow autocommit.
            if (!beginConfirmed) this.failedStarts.add(lane);
            throw error;
          }
          try {
            client.release(true);
          } catch (cleanupError) {
            if (this.closing) this.cleanupFailures.push(cleanupError);
            throw new AggregateError(
              [error, cleanupError],
              "BEGIN cleanup failed.",
            );
          }
          throw error;
        }
        if (this.closing) {
          // A queued checkout may need an earlier pin to return first. A late
          // successful open therefore owns its rollback instead of adding a pin.
          try {
            await this.returnTransaction(client);
          } catch (error) {
            this.cleanupFailures.push(error);
            throw error;
          }
        } else if (
          ending ||
          (beginSql !== undefined && control.kind === "end" && !control.chain)
        ) {
          client.release();
        } else {
          this.transactions.set(lane, client);
        }
        return { rows: result.rows };
      });
      this.opening.set(lane, task);
      try {
        return await task;
      } finally {
        this.opening.delete(lane);
      }
    }
    const pinned = this.transactions.get(lane);
    if (pinned) {
      if (this.failedStarts.has(lane) && control.kind !== "end") {
        throw new Error(
          "Current transaction is aborted; roll back before issuing more statements.",
        );
      }
      const task = Promise.resolve().then(async () => {
        try {
          const result = await execute(pinned);
          if (control.kind === "end") this.failedStarts.delete(lane);
          if (ending || (control.kind === "end" && !control.chain)) {
            this.transactions.delete(lane);
            pinned.release();
          }
          return { rows: result.rows };
        } catch (error) {
          // A failed finish batch may have skipped COMMIT. Keep its pin for
          // rollback; this also safely cleans up a COMMIT-time failure.
          if (control.kind === "end") {
            this.transactions.delete(lane);
            this.failedStarts.delete(lane);
            pinned.release(true);
          }
          throw error;
        }
      });
      this.pendingPinned.add(task);
      try {
        return await task;
      } finally {
        this.pendingPinned.delete(task);
      }
    }
    if (transaction !== undefined) {
      throw new Error(`PostgreSQL transaction ${transaction} is not active.`);
    }
    const client = await this.pool.connect();
    try {
      const result = await execute(client);
      return { rows: result.rows };
    } finally {
      client.release();
    }
  }

  async exec(sql: string) {
    await this.query(sql);
  }

  private async returnTransaction(client: PgPoolClient): Promise<void> {
    let destroy = false;
    try {
      await client.query("ROLLBACK");
    } catch {
      // Confirmed discard suffices when rollback itself is unavailable.
      destroy = true;
    }
    client.release(destroy);
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    return this.closeTask = Promise.resolve().then(async () => {
      // Let admitted terminal SQL update pin ownership before collecting it.
      await Promise.allSettled([...this.pendingPinned]);
      for (const [lane, client] of this.transactions) {
        try {
          await this.returnTransaction(client);
        } catch (error) {
          // The pool retains failed physical returns for its end() retry.
          this.cleanupFailures.push(error);
        }
        this.transactions.delete(lane);
        this.failedStarts.delete(lane);
      }
      // Pool shutdown retries failed returns, which can unblock queued opens.
      // It also seals checkout admission and returns late checkouts directly.
      // Do not wait for those opens before starting the owned return retries.
      const opened = Promise.allSettled([...this.opening.values()]);
      try {
        await this.pool.end();
        await opened;
      } catch (error) {
        // Unknown return ownership remains retained by the pool. Its failed
        // shutdown must remain observable even if queued opens cannot drain.
        this.cleanupFailures.push(error);
      }
      if (this.cleanupFailures.length) {
        throw new AggregateError(
          this.cleanupFailures,
          "PostgreSQL shutdown cleanup failed.",
        );
      }
    });
  }
}

async function initializePostgreSQL(
  url: string,
  provider?: PgProvider,
  max = 5,
  statementTimeoutMs?: number,
  reportError?: (error: Error) => void,
): Promise<PostgresAdapter> {
  const pg = await loadPgModule(provider);
  const pool = new AccountedPgPool(
    new pg.Pool({
      connectionString: url,
      max,
      ...(statementTimeoutMs === undefined
        ? {}
        : { statement_timeout: statementTimeoutMs }),
    }),
    max,
    reportError,
  );
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1"); // Test connection
      return new PostgresAdapter(pool);
    } finally {
      client.release();
    }
  } catch (error) {
    // The engine cannot close an adapter that initialization never returned.
    await pool.end().catch(() => {});
    throw error;
  }
}

/*───────────────── Public API ──────────────────*/

/**
 * Initializes the main and sync database connections.
 */
export async function initConnections(
  state: EngineState,
  cfg: OminipgEngineConfig,
) {
  state.pgliteProvider ??= cfg.pgliteProvider;
  state.pgProvider ??= cfg.pgProvider;
  state.mainDbType = detectDatabaseType(cfg.url);
  if (state.mainDbType === "pglite") {
    state.mainDb = await initializePGlite(
      state,
      cfg.url,
      cfg.pgliteExtensions ?? [],
      cfg.logMetrics,
      state.pgliteConfig ?? cfg.pgliteConfig,
      cfg.pgliteMemoryProfile,
      state.pgliteProvider,
    );
  } else {
    state.activePgliteExtensions.clear();
    const adapter = await initializePostgreSQL(
      cfg.url,
      state.pgProvider,
      cfg.pgPoolMax ?? 5,
      cfg.statementTimeoutMs,
      state.reportError,
    );
    state.mainDb = adapter;
    state.mainPool = adapter.pool;
  }

  if (cfg.syncUrl) {
    if (detectDatabaseType(cfg.syncUrl) !== "postgres") {
      throw new Error(
        "syncUrl must be a PostgreSQL connection string (postgres://)",
      );
    }
    const pg = await loadPgModule(state.pgProvider);
    state.syncPool = new AccountedPgPool(
      new pg.Pool({ connectionString: cfg.syncUrl, max: 1 }),
      1,
      state.reportError,
    );
  }
}

/**
 * Executes a query on the main database.
 */
export async function exec(
  state: EngineState,
  sql: string,
  params?: unknown[],
  transaction?: string,
  begin?: OminipgTransactionOptions,
  end?: "commit",
): Promise<unknown[]> {
  const result = await requireMainDb(state).query(
    sql,
    params ?? [],
    transaction,
    begin,
    end,
  );
  return result.rows;
}

/**
 * Dumps the active PGlite data directory as a Blob.
 */
export async function dumpDataDir(state: EngineState): Promise<Blob> {
  const mainDb = requireMainDb(state);
  if (state.mainDbType !== "pglite" || !mainDb.dumpDataDir) {
    throw new Error("dumpDataDir() is only available for PGlite connections.");
  }
  return await mainDb.dumpDataDir();
}

/**
 * Closes all database connections.
 */
export async function closeConnections(state: EngineState) {
  const syncPool = state.syncPool;
  const mainDb = state.mainDb;
  state.syncPool = null;
  state.mainPool = null;
  state.mainDb = undefined;
  state.mainDbType = undefined;
  state.meta.clear();
  state.recentlyPushed.clear();
  state.activePgliteExtensions.clear();
  let firstError: unknown;
  if (syncPool) {
    try {
      await syncPool.end();
    } catch (error) {
      firstError = error;
    }
  }
  if (mainDb) {
    try {
      await mainDb.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}
