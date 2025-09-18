import { TypedEmitter } from 'npm:tiny-typed-emitter@2.1.0';
import type { OminipgConnectionOptions, OminipgClientEvents } from './types.ts';
import type { WorkerMsg, ResponseMsg, InitMsg, ExecMsg, SyncMsg, SyncSeqMsg, DiagnosticMsg, CloseMsg } from '../shared/types.ts';

class RequestManager {
    private _id = 0;
    private readonly pending = new Map<number, { resolve: (value: any) => void, reject: (reason?: any) => void, timeoutId: number }>();
    
    constructor(private readonly worker: Worker, private readonly emitter: TypedEmitter<OminipgClientEvents>) {
        this.worker.addEventListener("message", this.handleMessage.bind(this));
    }

    private handleMessage(event: MessageEvent<ResponseMsg>) {
        const msg = event.data;
        const reqId = msg.reqId;

        if (msg.type === 'error' && !reqId) {
            this.emitter.emit('error', new Error(msg.error));
            return;
        }

        if (!reqId || !this.pending.has(reqId)) {
            return; // Not a message we are waiting for
        }

        const deferred = this.pending.get(reqId)!;
        clearTimeout(deferred.timeoutId);
        this.pending.delete(reqId);

        if (msg.type === 'error') {
            deferred.reject(new Error(msg.error));
        } else {
            // Exclude 'type' and 'reqId' from the resolved data
            const { type: _type, reqId: _reqId, ...data } = msg;
            deferred.resolve(data);
        }
    }

    public request<T>(message: Omit<WorkerMsg, 'reqId'>, timeout: number = 30000): Promise<T> {
        return new Promise((resolve, reject) => {
            const reqId = ++this._id;
            
            const timeoutId = setTimeout(() => {
                this.pending.delete(reqId);
                reject(new Error(`Database request '${message.type}' timed out after ${timeout}ms`));
            }, timeout);

            this.pending.set(reqId, { resolve, reject, timeoutId: Number(timeoutId) });

            this.worker.postMessage({ ...message, reqId });
        });
    }

    public post(message: Omit<WorkerMsg, 'reqId'>) {
        this.worker.postMessage(message);
    }
}

export class Ominipg extends TypedEmitter<OminipgClientEvents> {
    private readonly mode: 'worker' | 'direct';
    private readonly worker?: Worker;
    private readonly requests?: RequestManager;
    private readonly pool?: any; // pg.Pool when in direct mode

    private constructor(mode: 'worker' | 'direct', worker?: Worker, pool?: any) {
        super();
        this.mode = mode;
        this.worker = worker;
        this.requests = worker ? new RequestManager(worker, this) : undefined;
        this.pool = pool;
    }

    public static async connect(options: OminipgConnectionOptions): Promise<Ominipg> {
        const url = options.url || `:memory:`;
        const useWorker = options.useWorker !== false; // default true
        const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
        const syncDisabled = !options.syncUrl;

        if (!useWorker && isPg && syncDisabled) {
            const pg = await import('npm:pg@8.16.3');
            const pool = new pg.Pool({ connectionString: url, max: 5 });
            const client = await pool.connect();
            try {
                await client.query('SELECT 1');
            } finally {
                client.release();
            }
            const db = new Ominipg('direct', undefined, pool);
            db.emit('connected');
            return db;
        }

        const worker = new Worker(
            new URL('../worker/index.ts', import.meta.url).href,
            { type: "module" }
        );
        const db = new Ominipg('worker', worker);

        const initMsg = {
            type: 'init' as const,
            ...options,
            url,
        };

        await db.requests!.request<InitMsg>(initMsg, 60000); // Longer timeout for init
        db.emit('connected');
        return db;
    }

    /**
     * Executes a raw SQL query. This is the core method that can be used
     * directly or wrapped by ORMs like Drizzle.
     */
    public async query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
        if (this.mode === 'direct') {
            const client = await this.pool.connect();
            try {
                const result = await client.query(sql, params ?? []);
                return { rows: result.rows };
            } finally {
                client.release();
            }
        }
        const message: Omit<ExecMsg, "reqId"> = { type: 'exec', sql, params };
        return await this.requests!.request<{ rows: any[] }>(message);
    }

    /**
     * @deprecated Use query() instead. This method is kept for backward compatibility.
     */
    public async queryRaw(sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
        return this.query(sql, params);
    }

    /**
     * Pushes local changes to the remote database.
     */
    public async sync(): Promise<{ pushed: number }> {
        if (this.mode === 'direct') {
            throw new Error('Sync is disabled in direct Postgres mode');
        }
        this.emit('sync:start');
        const message: Omit<SyncMsg, "reqId"> = { type: 'sync' };
        const result = await this.requests!.request<{ pushed: number }>(message, 120000);
        this.emit('sync:end', result);
        return result;
    }

    /**
     * Synchronizes sequence values from the remote database.
     */
    public async syncSequences(): Promise<{ synced: number }> {
        if (this.mode === 'direct') {
            throw new Error('Sync sequences is disabled in direct Postgres mode');
        }
        const message: Omit<SyncSeqMsg, "reqId"> = { type: 'sync-sequences' };
        return await this.requests!.request<{ synced: number }>(message, 120000);
    }

    /**
     * Retrieves diagnostic information about the worker's state.
     */
    public async getDiagnosticInfo(): Promise<any> {
        if (this.mode === 'direct') {
            return {
                mainDatabase: { type: 'postgres' },
                syncDatabase: { hasSyncPool: false },
            };
        }
        const message: Omit<DiagnosticMsg, "reqId"> = { type: 'diagnostic' };
        const { info } = await this.requests!.request<{ info: any }>(message);
        return info;
    }

    /**
     * Closes the database connection and terminates the worker.
     */
    public async close(): Promise<void> {
        if (this.mode === 'direct') {
            await this.pool?.end();
            this.emit('close');
            return;
        }
        const message: Omit<CloseMsg, "reqId"> = { type: 'close' };
        this.requests!.post(message);
        this.worker!.terminate();
        this.emit('close');
    }
}

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
export function withDrizzle(
    ominipgInstance: Ominipg, 
    drizzleFactory: (callback: any, config?: any) => any,
    schema?: Record<string, any>
): any;

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
    schema?: Record<string, any>
): Promise<any>;

export function withDrizzle(
    ominipgInstance: Ominipg, 
    drizzleFactoryOrSchema?: ((callback: any, config?: any) => any) | Record<string, any>,
    schema?: Record<string, any>
): any | Promise<any> {
    // Check if first argument is the drizzle factory function
    if (typeof drizzleFactoryOrSchema === 'function') {
        // Version 1: User provided drizzle factory
        return createDrizzleAdapter(ominipgInstance, drizzleFactoryOrSchema as (callback: any, config?: any) => any, schema);
    } else {
        // Version 2: Auto-import drizzle (async)
        throw new Error('Auto-import of drizzle is not supported yet. Please use the explicit import: import { drizzle } from "npm:drizzle-orm/pg-proxy";');
        // return createDrizzleAdapterAsync(ominipgInstance, drizzleFactoryOrSchema as Record<string, any> | undefined);
    }
}

function createDrizzleAdapter(
    ominipgInstance: Ominipg,
    drizzleFactory: (callback: any, config?: any) => any,
    schema?: Record<string, any>
) {
    const drizzleProxy = drizzleFactory(
        async (sql: string, params: any[], method?: 'run' | 'all' | 'values' | 'get' | 'execute') => {
            try {
                const result = await ominipgInstance.query(sql, params);
                
                // Handle different return formats based on method
                if (method === 'get') {
                    // For 'get' method, return single row as string[]
                    const row = result.rows[0];
                    if (row && typeof row === 'object') {
                        return { rows: Object.values(row) };
                    }
                    return { rows: [] };
                } else if (method === 'all') {
                    // For 'all' method, convert objects to arrays (string[][])
                    if (result.rows.length > 0 && typeof result.rows[0] === 'object') {
                        const columnNames = Object.keys(result.rows[0]);
                        const arrayRows = result.rows.map(row => 
                            columnNames.map(col => (row as any)[col])
                        );
                        return { rows: arrayRows };
                    }
                    return { rows: [] };
                } else {
                    // For other methods ('run', 'values', 'execute', or undefined), return objects as-is
                    return { rows: result.rows };
                }
            } catch (error) {
                console.error('Database query error:', error);
                throw error;
            }
        },
        { schema }
    );

    // Add Ominipg-specific methods to the Drizzle instance
    return Object.assign(drizzleProxy, {
        // Ominipg sync methods
        sync: ominipgInstance.sync.bind(ominipgInstance),
        syncSequences: ominipgInstance.syncSequences.bind(ominipgInstance),
        getDiagnosticInfo: ominipgInstance.getDiagnosticInfo.bind(ominipgInstance),
        close: ominipgInstance.close.bind(ominipgInstance),
        
        // Raw query access
        queryRaw: ominipgInstance.query.bind(ominipgInstance),
        query: ominipgInstance.query.bind(ominipgInstance),
        
        // Access to the underlying Ominipg instance
        _ominipg: ominipgInstance,
    });
}

// async function createDrizzleAdapterAsync(
//     ominipgInstance: Ominipg,
//     schema?: Record<string, any>
// ) {
//     try {
//         // Try to dynamically import drizzle
//         const { drizzle } = await import('npm:drizzle-orm@0.44.2/pg-proxy');
//         return createDrizzleAdapter(ominipgInstance, drizzle, schema);
//     } catch (error) {
//         throw new Error(
//             'Failed to import drizzle-orm. Please install it explicitly:\n' +
//             'import { drizzle } from "npm:drizzle-orm/pg-proxy";\n' +
//             'Then use: withDrizzle(ominipg, drizzle, schema)\n\n' +
//             `Original error: ${error instanceof Error ? error.message : String(error)}`
//         );
//     }
// } 