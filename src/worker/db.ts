/// <reference lib="deno.unstable" />
import { detectDatabaseType, getRssMb } from "./utils.ts";
import type {
  InitMsg,
  PGliteConfig,
  PGliteExtensionsMap,
} from "../shared/types.ts";

/*───────────────── Types ──────────────────*/

export interface DatabaseClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<void>;
  listen?(channel: string, callback: () => void): Promise<void>;
  close(): Promise<void>;
}

/*───────────────── State ──────────────────*/

export let mainDb: DatabaseClient;
export let mainDbType: "pglite" | "postgres";

// Minimal pg types to avoid importing npm modules at top-level
export interface PgPoolClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}
export interface PgPool {
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
  options?: { connectionString?: string };
}

export let syncPool: PgPool | null = null;

/**
 * In-memory metadata cache for table schemas (PKs, columns).
 */
export const meta = new Map<string, { pk: string[]; non: string[] }>();

/**
 * In-memory cache to track recently pushed changes to prevent echo.
 * The structure is: `Map<TableName, Map<PrimaryKey, { op: string, lww: unknown }>>`
 * where `lww` is the value of the Last-Write-Wins column.
 */
export const recentlyPushed = new Map<
  string,
  Map<string, { op: string; lww: unknown }>
>();

/*───────────────── PGlite Adapter ──────────────────*/

// Minimal PGlite interface
interface PGliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<void>;
  listen(channel: string, callback: () => void): Promise<void>;
  close(): Promise<void>;
}

class PGliteAdapter implements DatabaseClient {
  constructor(private pglite: PGliteLike) {}

  async query(sql: string, params?: unknown[]) {
    return await this.pglite.query(sql, params ?? []);
  }

  async exec(sql: string) {
    await this.pglite.exec(sql);
  }

  async listen(channel: string, callback: () => void) {
    await this.pglite.listen(channel, callback);
  }

  async close() {
    await this.pglite.close();
  }
}

/**
 * Dynamically imports PGlite extensions based on their names
 */
async function loadExtensions(
  extensionNames: string[],
  logMetrics?: boolean,
): Promise<PGliteExtensionsMap> {
  const extensions: PGliteExtensionsMap = {};

  // Map of extension names to their import paths
  const extensionPaths: Record<string, string> = {
    // Main package extensions
    "vector": "vector",
    "live": "live",

    // Contrib extensions
    "uuid_ossp": "contrib/uuid_ossp",
    "amcheck": "contrib/amcheck",
    "auto_explain": "contrib/auto_explain",
    "bloom": "contrib/bloom",
    "btree_gin": "contrib/btree_gin",
    "btree_gist": "contrib/btree_gist",
    "citext": "contrib/citext",
    "cube": "contrib/cube",
    "earthdistance": "contrib/earthdistance",
    "fuzzystrmatch": "contrib/fuzzystrmatch",
    "hstore": "contrib/hstore",
    "isn": "contrib/isn",
    "lo": "contrib/lo",
    "ltree": "contrib/ltree",
    "pg_trgm": "contrib/pg_trgm",
    "seg": "contrib/seg",
    "tablefunc": "contrib/tablefunc",
    "tcn": "contrib/tcn",
    "tsm_system_rows": "contrib/tsm_system_rows",
    "tsm_system_time": "contrib/tsm_system_time",
  };

  for (const extensionName of extensionNames) {
    try {
      const importPath = extensionPaths[extensionName];
      if (!importPath) {
        console.warn(`⚠ Unknown PGlite extension: ${extensionName}`);
        continue;
      }

      const before = getRssMb();
      const extensionModule = await import(
        `npm:@electric-sql/pglite@0.3.4/${importPath}`
      );
      // The extension is typically exported with the same name as the module
      const resolved = extensionModule[extensionName] ??
        extensionModule.default ?? extensionModule;
      extensions[extensionName] = resolved as PGliteExtensionsMap[string];
      if (logMetrics) {
        const after = getRssMb();
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
        `⚠ Failed to load PGlite extension "${extensionName}": ${message}`,
      );
    }
  }

  return extensions;
}

function mergePGliteConfig(
  baseConfig: PGliteConfig | undefined,
  extensions: PGliteExtensionsMap,
): PGliteConfig | undefined {
  const hasExtensions = Object.keys(extensions).length > 0;
  if (!baseConfig && !hasExtensions) {
    return undefined;
  }

  const config: PGliteConfig = baseConfig ? { ...baseConfig } : {};

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

async function initializePGlite(
  url: string,
  extensionNames: string[] = [],
  logMetrics?: boolean,
  pgliteConfig?: PGliteConfig,
): Promise<DatabaseClient> {
  const { PGlite } = await import("npm:@electric-sql/pglite@0.3.4");
  const extensions = extensionNames.length > 0
    ? await loadExtensions(extensionNames, logMetrics)
    : {};
  const mergedConfig = mergePGliteConfig(pgliteConfig, extensions);

  if (url === ":memory:" || url === "") {
    const before = getRssMb();
    const adapter = new PGliteAdapter(
      (mergedConfig
        ? new PGlite(mergedConfig)
        : new PGlite()) as unknown as PGliteLike,
    );
    if (extensionNames.length > 0) {
      await createExtensions(adapter, extensionNames);
      if (logMetrics) {
        const after = getRssMb();
        if (after != null && before != null) {
          console.log(
            `PGlite initialized in-memory (+${
              after - before
            } MB, rss=${after} MB)`,
          );
        }
      }
    }
    return adapter;
  }

  const dbPath = url.replace("file://", "");
  const before = getRssMb();
  try {
    const slash = dbPath.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(dbPath.slice(0, slash), { recursive: true });
    }
  } catch (_) {
    // Ignore mkdir errors
  }
  try {
    const pglite = mergedConfig
      ? new PGlite(dbPath, mergedConfig)
      : new PGlite(dbPath);
    const adapter = new PGliteAdapter(pglite as unknown as PGliteLike);
    if (extensionNames.length > 0) {
      await createExtensions(adapter, extensionNames);
      if (logMetrics) {
        const after = getRssMb();
        if (after != null && before != null) {
          console.log(
            `PGlite initialized file-db (+${
              after - before
            } MB, rss=${after} MB)`,
          );
        }
      }
    }
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
    if (extensionNames.length > 0) {
      await createExtensions(adapter, extensionNames);
      if (logMetrics) {
        const after = getRssMb();
        if (after != null && before != null) {
          console.log(
            `PGlite initialized (fallback, in-memory) (+${
              after - before
            } MB, rss=${after} MB)`,
          );
        }
      }
    }
    return adapter;
  }
}

/**
 * Creates/activates extensions in the PGlite database
 */
async function createExtensions(
  adapter: DatabaseClient,
  extensionNames: string[],
): Promise<void> {
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

  for (const extensionName of extensionNames) {
    try {
      const sqlName = extensionSqlNames[extensionName] || extensionName;
      await adapter.exec(`CREATE EXTENSION IF NOT EXISTS "${sqlName}"`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `⚠ Failed to create PGlite extension "${extensionName}": ${message}`,
      );
    }
  }
}

/*───────────────── PostgreSQL Adapter ──────────────────*/

class PostgresAdapter implements DatabaseClient {
  constructor(private pool: PgPool) {}

  async query(sql: string, params?: unknown[]) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(sql, params ?? []);
      return { rows: result.rows };
    } finally {
      client.release();
    }
  }

  async exec(sql: string) {
    const client = await this.pool.connect();
    try {
      await client.query(sql);
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

async function initializePostgreSQL(url: string): Promise<DatabaseClient> {
  const pg = await import("npm:pg@8.16.3");
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const client = await pool.connect();
  try {
    await client.query("SELECT 1"); // Test connection
    return new PostgresAdapter(pool);
  } finally {
    client.release();
  }
}

/*───────────────── Public API ──────────────────*/

/**
 * Initializes the main and sync database connections.
 */
export async function initConnections(cfg: InitMsg) {
  mainDbType = detectDatabaseType(cfg.url);
  mainDb = mainDbType === "pglite"
    ? await initializePGlite(
      cfg.url,
      cfg.pgliteExtensions ?? [],
      cfg.logMetrics,
      cfg.pgliteConfig,
    )
    : await initializePostgreSQL(cfg.url);

  if (cfg.syncUrl) {
    if (detectDatabaseType(cfg.syncUrl) !== "postgres") {
      throw new Error(
        "syncUrl must be a PostgreSQL connection string (postgres://)",
      );
    }
    const pg = await import("npm:pg@8.16.3");
    syncPool = new pg.Pool({ connectionString: cfg.syncUrl, max: 1 });
  }
}

/**
 * Executes a query on the main database.
 */
export async function exec(
  sql: string,
  params?: unknown[],
): Promise<unknown[]> {
  const result = await mainDb.query(sql, params ?? []);
  return result.rows;
}

/**
 * Closes all database connections.
 */
export async function closeConnections() {
  if (syncPool) await syncPool.end();
  if (mainDb) await mainDb.close();
}
