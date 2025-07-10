
/// <reference lib="deno.unstable" />
import pg from "npm:pg@8.16.3";
import { PGlite } from "npm:@electric-sql/pglite@0.3.4";
import { detectDatabaseType } from './utils.ts';
import type { InitMsg } from "../shared/types.ts";

/*───────────────── Types ──────────────────*/

export interface DatabaseClient {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
    exec(sql: string): Promise<void>;
    listen?(channel: string, callback: () => void): Promise<void>;
    close(): Promise<void>;
}

/*───────────────── State ──────────────────*/

export let mainDb: DatabaseClient;
export let mainDbType: 'pglite' | 'postgres';
export let syncPool: pg.Pool | null = null;

/**
 * In-memory metadata cache for table schemas (PKs, columns).
 */
export const meta = new Map<string, { pk: string[], non: string[] }>();

/**
 * In-memory cache to track recently pushed changes to prevent echo.
 * The structure is: `Map<TableName, Map<PrimaryKey, { op: string, lww: any }>>`
 * where `lww` is the value of the Last-Write-Wins column.
 */
export const recentlyPushed = new Map<string, Map<string, { op: string, lww: any }>>();


/*───────────────── PGlite Adapter ──────────────────*/

class PGliteAdapter implements DatabaseClient {
    constructor(private pglite: PGlite) {}

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
async function loadExtensions(extensionNames: string[]): Promise<Record<string, any>> {
    const extensions: Record<string, any> = {};
    
    // Map of extension names to their import paths
    const extensionPaths: Record<string, string> = {
        // Main package extensions
        'vector': 'vector',
        'live': 'live',
        
        // Contrib extensions
        'uuid_ossp': 'contrib/uuid_ossp',
        'amcheck': 'contrib/amcheck',
        'auto_explain': 'contrib/auto_explain', 
        'bloom': 'contrib/bloom',
        'btree_gin': 'contrib/btree_gin',
        'btree_gist': 'contrib/btree_gist',
        'citext': 'contrib/citext',
        'cube': 'contrib/cube',
        'earthdistance': 'contrib/earthdistance',
        'fuzzystrmatch': 'contrib/fuzzystrmatch',
        'hstore': 'contrib/hstore',
        'isn': 'contrib/isn',
        'lo': 'contrib/lo',
        'ltree': 'contrib/ltree',
        'pg_trgm': 'contrib/pg_trgm',
        'seg': 'contrib/seg',
        'tablefunc': 'contrib/tablefunc',
        'tcn': 'contrib/tcn',
        'tsm_system_rows': 'contrib/tsm_system_rows',
        'tsm_system_time': 'contrib/tsm_system_time'
    };
    
    for (const extensionName of extensionNames) {
        try {
            const importPath = extensionPaths[extensionName];
            if (!importPath) {
                console.warn(`⚠ Unknown PGlite extension: ${extensionName}`);
                continue;
            }
            
            const extensionModule = await import(`npm:@electric-sql/pglite@0.3.4/${importPath}`);
            // The extension is typically exported with the same name as the module
            extensions[extensionName] = extensionModule[extensionName] || extensionModule.default || extensionModule;
            console.log(`✓ Loaded PGlite extension: ${extensionName}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`⚠ Failed to load PGlite extension "${extensionName}": ${message}`);
        }
    }
    
    return extensions;
}

async function initializePGlite(url: string, extensionNames: string[] = []): Promise<DatabaseClient> {
    // Load extensions if any are specified
    const extensions = extensionNames.length > 0 ? await loadExtensions(extensionNames) : {};
    
    // Handle in-memory databases
    if (url === ':memory:' || url === '') {
        const config = Object.keys(extensions).length > 0 ? { extensions } : undefined;
        const adapter = new PGliteAdapter(new PGlite(config));
        
        // Create extensions if any were loaded
        if (extensionNames.length > 0) {
            await createExtensions(adapter, extensionNames);
        }
        
        return adapter;
    }
    
    // Handle file-based databases
    const dbPath = url.replace('file://', '');
    try {
        const pglite = Object.keys(extensions).length > 0 
            ? new PGlite(dbPath, { extensions })
            : new PGlite(dbPath);
        const adapter = new PGliteAdapter(pglite);
        
        // Create extensions if any were loaded
        if (extensionNames.length > 0) {
            await createExtensions(adapter, extensionNames);
        }
        
        return adapter;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`File-based PGlite failed (${message}), falling back to in-memory.`);
        const config = Object.keys(extensions).length > 0 ? { extensions } : undefined;
        const adapter = new PGliteAdapter(new PGlite(config));
        
        // Create extensions if any were loaded
        if (extensionNames.length > 0) {
            await createExtensions(adapter, extensionNames);
        }
        
        return adapter;
    }
}

/**
 * Creates/activates extensions in the PGlite database
 */
async function createExtensions(adapter: DatabaseClient, extensionNames: string[]): Promise<void> {
    // Map extension names to their PostgreSQL extension names
    const extensionSqlNames: Record<string, string> = {
        'uuid_ossp': 'uuid-ossp',
        'vector': 'vector',
        'live': 'live',
        'amcheck': 'amcheck',
        'auto_explain': 'auto_explain',
        'bloom': 'bloom',
        'btree_gin': 'btree_gin',
        'btree_gist': 'btree_gist',
        'citext': 'citext',
        'cube': 'cube',
        'earthdistance': 'earthdistance',
        'fuzzystrmatch': 'fuzzystrmatch',
        'hstore': 'hstore',
        'isn': 'isn',
        'lo': 'lo',
        'ltree': 'ltree',
        'pg_trgm': 'pg_trgm',
        'seg': 'seg',
        'tablefunc': 'tablefunc',
        'tcn': 'tcn',
        'tsm_system_rows': 'tsm_system_rows',
        'tsm_system_time': 'tsm_system_time'
    };
    
    for (const extensionName of extensionNames) {
        try {
            const sqlName = extensionSqlNames[extensionName] || extensionName;
            await adapter.exec(`CREATE EXTENSION IF NOT EXISTS "${sqlName}"`);
            console.log(`✓ Created PGlite extension: ${extensionName}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`⚠ Failed to create PGlite extension "${extensionName}": ${message}`);
        }
    }
}

/*───────────────── PostgreSQL Adapter ──────────────────*/

class PostgresAdapter implements DatabaseClient {
    constructor(private pool: pg.Pool) {}

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

async function initializePostgreSQL(url:string): Promise<DatabaseClient> {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    const client = await pool.connect();
    try {
        await client.query('SELECT 1'); // Test connection
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
    mainDb = mainDbType === 'pglite'
        ? await initializePGlite(cfg.url, cfg.pgliteExtensions)
        : await initializePostgreSQL(cfg.url);

    if (cfg.syncUrl) {
        if (detectDatabaseType(cfg.syncUrl) !== 'postgres') {
            throw new Error('syncUrl must be a PostgreSQL connection string (postgres://)');
        }
        syncPool = new pg.Pool({ connectionString: cfg.syncUrl, max: 1 });
    }
}

/**
 * Executes a query on the main database.
 */
export async function exec(sql: string, params?: unknown[]): Promise<any[]> {
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