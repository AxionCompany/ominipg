
/// <reference lib="deno.unstable" />
import pg from "npm:pg";
import { PGlite } from "npm:@electric-sql/pglite";
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

// Track metadata about tables (primary keys, etc.)
export const meta = new Map<string, { pk: string[]; non: string[] }>();

// Track recently pushed changes to prevent echoes
export const recentlyPushed = new Map<string, Set<string>>(); // table -> set of stringified primary keys


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

async function initializePGlite(url: string): Promise<DatabaseClient> {
    const dbPath = url.replace('file://', '');
    console.log(`Initializing PGlite at: ${dbPath}`);
    try {
        const pglite = new PGlite(dbPath);
        return new PGliteAdapter(pglite);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`File-based PGlite failed (${message}), falling back to in-memory.`);
        return new PGliteAdapter(new PGlite());
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
    console.log('Initializing PostgreSQL connection...');
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    const client = await pool.connect();
    try {
        await client.query('SELECT 1'); // Test connection
        console.log('PostgreSQL connection established.');
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
    console.log(`Initializing main database (${mainDbType})...`);
    mainDb = mainDbType === 'pglite'
        ? await initializePGlite(cfg.url)
        : await initializePostgreSQL(cfg.url);

    if (cfg.syncUrl) {
        if (detectDatabaseType(cfg.syncUrl) !== 'postgres') {
            throw new Error('syncUrl must be a PostgreSQL connection string (postgres://)');
        }
        console.log('Initializing sync database connection...');
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
    console.log('All database connections closed.');
} 