import { detectDatabaseType, getRssMb } from "./utils.ts";
import { ensureDirectory, pathExistsAsDirectory } from "../runtime/mod.ts";
import type {
  InitMsg,
  PGliteConfig,
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
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<void>;
  listen?(channel: string, callback: () => void): Promise<void>;
  close(): Promise<void>;
}

/*───────────────── State ──────────────────*/

export let mainDb: DatabaseClient;
export let mainDbType: "pglite" | "postgres";
export const activePgliteExtensions = new Set<string>();

export type { PgPool, PgPoolClient } from "../shared/types.ts";

export let syncPool: PgPool | null = null;
let pgliteProvider: PGliteProvider | undefined;
let pgProvider: PgProvider | undefined;

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
  exec(sql: string): Promise<unknown>;
  listen(channel: string, callback: () => void): Promise<unknown>;
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

async function importModule<T>(specifier: string): Promise<T> {
  return await import(specifier) as T;
}

function engineLoadError(
  engine: "pglite" | "pg" | "pg-logical-replication",
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  if (engine === "pglite") {
    return new Error(
      `Failed to load PGlite provider from "@electric-sql/pglite": ${message}\n\n` +
        `For Deno, add PGlite to your deno.json import map:\n` +
        `{\n` +
        `  "imports": {\n` +
        `    "@electric-sql/pglite": "npm:@electric-sql/pglite@0.3.4"\n` +
        `  }\n` +
        `}\n\n` +
        `For Node.js, install the optional peer dependency: npm install @electric-sql/pglite`,
    );
  }
  if (engine === "pg-logical-replication") {
    return new Error(
      `Failed to load pg-logical-replication provider: ${message}\n\n` +
        `For Deno, add it to your deno.json import map:\n` +
        `{\n` +
        `  "imports": {\n` +
        `    "pg-logical-replication": "npm:pg-logical-replication@2.4.0"\n` +
        `  }\n` +
        `}\n\n` +
        `For Node.js, install the optional peer dependency: npm install pg-logical-replication`,
    );
  }
  return new Error(
    `Failed to load PostgreSQL provider from "pg": ${message}\n\n` +
      `For Deno, add pg to your deno.json import map:\n` +
      `{\n` +
      `  "imports": {\n` +
      `    "pg": "npm:pg@8.16.3"\n` +
      `  }\n` +
      `}\n\n` +
      `For Node.js, install the optional peer dependency: npm install pg`,
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

export async function loadLogicalReplicationModule(): Promise<
  PgLogicalReplicationModule
> {
  try {
    if (pgProvider?.loadLogicalReplication) {
      return await pgProvider.loadLogicalReplication();
    }
    if (pgProvider?.logicalReplicationModuleSpecifier) {
      return await importModule<PgLogicalReplicationModule>(
        pgProvider.logicalReplicationModuleSpecifier,
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
  provider: PGliteProvider | undefined,
  extensionNames: string[],
  logMetrics?: boolean,
): Promise<PGliteExtensionsMap> {
  const extensions: PGliteExtensionsMap = {};

  for (const extensionName of extensionNames) {
    try {
      const before = getRssMb();
      const extensionModule = await loadPGliteExtension(
        provider,
        extensionName,
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
        `⚠ Failed to load PGlite extension "${extensionName}": ${message}\n` +
          `For Deno, map the extension subpath in deno.json, for example:\n` +
          `{\n` +
          `  "imports": {\n` +
          `    "${
            provider?.extensionSpecifiers?.[extensionName] ?? extensionName
          }": ` +
          `"npm:@electric-sql/pglite@0.3.4/${
            (provider?.extensionSpecifiers?.[extensionName] ?? extensionName)
              .replace(/^@electric-sql\/pglite\/?/, "")
          }"\n` +
          `  }\n` +
          `}`,
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

function recordActiveExtensions(extensionSqlNames: string[]) {
  activePgliteExtensions.clear();
  for (const name of extensionSqlNames) {
    activePgliteExtensions.add(name.toLowerCase());
  }
}

async function initializePGlite(
  url: string,
  extensionNames: string[] = [],
  logMetrics?: boolean,
  pgliteConfig?: PGliteConfig,
  provider?: PGliteProvider,
): Promise<DatabaseClient> {
  const { PGlite } = await loadPGliteModule(provider);
  const extensions = extensionNames.length > 0
    ? await loadExtensions(provider, extensionNames, logMetrics)
    : {};
  const mergedConfig = mergePGliteConfig(pgliteConfig, extensions);
  const loadedExtensionNames = Object.keys(extensions);

  if (url === ":memory:" || url === "") {
    const before = getRssMb();
    const adapter = new PGliteAdapter(
      (mergedConfig
        ? new PGlite(mergedConfig)
        : new PGlite()) as unknown as PGliteLike,
    );
    let activatedSqlNames: string[] = [];
    if (loadedExtensionNames.length > 0) {
      activatedSqlNames = await createExtensions(adapter, loadedExtensionNames);
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
    recordActiveExtensions(activatedSqlNames);
    return adapter;
  }

  const dbPath = url.replace("file://", "");
  const before = getRssMb();
  const isExistingDb = await pathExistsAsDirectory(dbPath);
  try {
    const slash = dbPath.lastIndexOf("/");
    if (slash > 0) {
      await ensureDirectory(dbPath.slice(0, slash));
    }
  } catch (_) {
    // Ignore mkdir errors
  }
  try {
    // Extension WASM modules must always be in the constructor config so that
    // extension functions (vector ops, pg_trgm, etc.) are available at runtime.
    // On re-open, we skip CREATE EXTENSION SQL (which aborts the WASM) but
    // still need the modules loaded.
    const pglite = mergedConfig
      ? new PGlite(dbPath, mergedConfig)
      : new PGlite(dbPath);
    const adapter = new PGliteAdapter(pglite as unknown as PGliteLike);
    let activatedSqlNames: string[] = [];
    if (loadedExtensionNames.length > 0) {
      if (isExistingDb) {
        // Extensions are already persisted from the first run. Record
        // them as active so DDL CREATE EXTENSION statements are skipped.
        const sqlNames: Record<string, string> = {
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
        activatedSqlNames = loadedExtensionNames.map(
          (name) => sqlNames[name] || name,
        );
      } else {
        activatedSqlNames = await createExtensions(
          adapter,
          loadedExtensionNames,
        );
      }
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
    recordActiveExtensions(activatedSqlNames);
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
    recordActiveExtensions(activatedSqlNames);
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

async function initializePostgreSQL(
  url: string,
  provider?: PgProvider,
): Promise<DatabaseClient> {
  const pg = await loadPgModule(provider);
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
  pgliteProvider = cfg.pgliteProvider;
  pgProvider = cfg.pgProvider;
  mainDbType = detectDatabaseType(cfg.url);
  if (mainDbType === "pglite") {
    mainDb = await initializePGlite(
      cfg.url,
      cfg.pgliteExtensions ?? [],
      cfg.logMetrics,
      cfg.pgliteConfig,
      pgliteProvider,
    );
  } else {
    activePgliteExtensions.clear();
    mainDb = await initializePostgreSQL(cfg.url, pgProvider);
  }

  if (cfg.syncUrl) {
    if (detectDatabaseType(cfg.syncUrl) !== "postgres") {
      throw new Error(
        "syncUrl must be a PostgreSQL connection string (postgres://)",
      );
    }
    const pg = await loadPgModule(pgProvider);
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
