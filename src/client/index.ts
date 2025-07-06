import "npm:pg@8.16.3";
import { TypedEmitter } from 'npm:tiny-typed-emitter@2.1.0';
import type { OminipgConnectionOptions, OminipgClientEvents } from './types.ts';
import type { WorkerMsg, ResponseMsg, InitMsg, ExecMsg, SyncMsg, SyncSeqMsg, DiagnosticMsg, CloseMsg } from '../shared/types.ts';
import { drizzle } from "npm:drizzle-orm@0.44.2/node-postgres";

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
            const { type, reqId, ...data } = msg;
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
    private readonly worker: Worker;
    private readonly requests: RequestManager;
    private drizzle: any; // Drizzle client

    private constructor(options: OminipgConnectionOptions) {
        super();
        this.worker = new Worker(
            new URL('../worker/index.ts', import.meta.url).href, 
            { type: "module" }
        );
        this.requests = new RequestManager(this.worker, this);
    }

    public static async connect(options: OminipgConnectionOptions): Promise<any> {
        const db = new Ominipg(options);
        
        // Create a custom driver for Drizzle
        const driver = {
            // Drizzle can pass a string or a complex object. We only want the serializable parts.
            query: async (query: string | { text: string, values?: any[], rowMode?: string }, params: any[]) => {
                
                // The SQL query is always in `query.text` or `query` itself.
                const sql = typeof query === 'string' ? query : query.text;
                // The parameters are always in the `params` array for `node-postgres`.
                const queryParams = params || [];
                const rowMode = (typeof query === 'object' && query.rowMode) || 'object';

                const { rows } = await db.queryRaw(sql, queryParams);

                let processedRows = rows;
                let fields: any[] = [];

                // If Drizzle expects array mode, convert our object rows to arrays.
                if (rowMode === 'array' && rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null) {
                    const columnNames = Object.keys(rows[0]);

                    // Drizzle needs this2 to map array indices to field names.
                    fields = columnNames.map((name, index) => ({
                        name,
                        dataTypeID: 0, // Drizzle doesn't seem to strictly need this for mapping.
                        columnID: index,
                    }));

                    // Convert each row object into an array of values in the correct order.
                    processedRows = rows.map(row => columnNames.map(col => (row as any)[col]));
                }

                return {
                    rows: processedRows,
                    rowCount: processedRows.length,
                    command: sql.trim().split(' ')[0].toUpperCase(),
                    fields,
                };
            }
        };

        db.drizzle = drizzle(driver, { schema: options.schema });
        
        const { schema, ...serializableOptions } = options;

        const initMsg = {
            type: 'init' as const,
            ...serializableOptions,
            url: options.url || `:memory:`,
        };
        
        await db.requests.request<InitMsg>(initMsg, 60000); // Longer timeout for init
        db.emit('connected');
        
        Object.assign(db.drizzle, {
            sync: db.sync.bind(db),
            syncSequences: db.syncSequences.bind(db),
            getDiagnosticInfo: db.getDiagnosticInfo.bind(db),
            close: db.close.bind(db),
            queryRaw: db.queryRaw.bind(db),
        });

        return db.drizzle;
    }

    /**
     * Executes a raw SQL query. This is used by the Drizzle driver.
     */
    public async queryRaw(sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
        const message: Omit<ExecMsg, "reqId"> = { type: 'exec', sql, params };
        return await this.requests.request<{ rows: any[] }>(message);
    }

    /**
     * Pushes local changes to the remote database.
     */
    public async sync(): Promise<{ pushed: number }> {
        this.emit('sync:start');
        const message: Omit<SyncMsg, "reqId"> = { type: 'sync' };
        const result = await this.requests.request<{ pushed: number }>(message, 120000); // Long timeout for sync
        this.emit('sync:end', result);
        return result;
    }

    /**
     * Synchronizes sequence values from the remote database.
     */
    public async syncSequences(): Promise<{ synced: number }> {
        const message: Omit<SyncSeqMsg, "reqId"> = { type: 'sync-sequences' };
        return await this.requests.request<{ synced: number }>(message, 120000);
    }

    /**
     * Retrieves diagnostic information about the worker's state.
     */
    public async getDiagnosticInfo(): Promise<any> {
        const message: Omit<DiagnosticMsg, "reqId"> = { type: 'diagnostic' };
        const { info } = await this.requests.request<{ info: any }>(message);
        return info;
    }

    /**
     * Closes the database connection and terminates the worker.
     */
    public async close(): Promise<void> {
        const message: Omit<CloseMsg, "reqId"> = { type: 'close' };
        this.requests.post(message);
        this.worker.terminate();
        this.emit('close');
    }
} 