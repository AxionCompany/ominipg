
import { LogicalReplicationService, PgoutputPlugin } from "npm:pg-logical-replication";
import { syncPool, mainDb, meta, recentlyPushed } from '../db.ts';
import { ensureMeta, createTableFromRemote } from '../schema.ts';
import { ident } from '../utils.ts';
import { LWW_COL, EDGE_ID } from '../bootstrap.ts';
import type { InitMsg } from "../../shared/types.ts";

let repl: LogicalReplicationService | null = null;

async function localUpsert(table: string, row: Record<string, unknown>) {
    const m = meta.get(table)!;
    
    // Use a transaction to ensure the session variable is set only for this operation
    await mainDb.exec('BEGIN');
    try {
        await mainDb.exec(`SET LOCAL app.sync.is_applying_remote_change = 'true'`);
        
        const pkList = m.pk.map(ident).join(",");
        const updSet = m.non.map(c => `${ident(c)} = EXCLUDED.${ident(c)}`).join(", ");
        
        await mainDb.query(`
          INSERT INTO ${ident(table)}
          SELECT * FROM json_populate_record(null::${ident(table)}, $1) s
          ON CONFLICT (${pkList}) DO UPDATE
            SET ${updSet}
          WHERE ${ident(table)}.${ident(LWW_COL)} < EXCLUDED.${ident(LWW_COL)}
        `, [JSON.stringify(row)]);

        await mainDb.exec('COMMIT');
    } catch (err) {
        await mainDb.exec('ROLLBACK');
        throw err;
    }
}

async function localDelete(table: string, pk: Record<string, unknown>) {
    const m = meta.get(table)!;
    
    // Use a transaction to ensure the session variable is set only for this operation
    await mainDb.exec('BEGIN');
    try {
        await mainDb.exec(`SET LOCAL app.sync.is_applying_remote_change = 'true'`);
        
        const whereConds = m.pk.map((p, i) => `${ident(p)} = $${i + 1}`).join(" AND ");
        const values = m.pk.map(p => pk[p]);
        
        await mainDb.query(`DELETE FROM ${ident(table)} WHERE ${whereConds}`, values);

        await mainDb.exec('COMMIT');
    } catch (err) {
        await mainDb.exec('ROLLBACK');
        throw err;
    }
}

async function handleWalMessage(log: any) {
    if (log.origin === EDGE_ID) return; // Skip echo from our own origin

    const tableName = log.relation.name;
    const isDelete = log.tag === 'delete';
    const rowData = isDelete ? log.old : log.new;

    // --- FIX: Guard against null rowData ---
    if (!rowData) {
        console.warn(`Skipping WAL message for table '${tableName}' due to missing row data.`);
        return;
    }

    await ensureMeta(tableName);
    const m = meta.get(tableName)!;

    const pkValues = m.pk.map(col => String(rowData[col] || '')).join('|');
    const pushedInfo = recentlyPushed.get(tableName)?.get(pkValues);

    if (pushedInfo) {
        const incomingLww = rowData[LWW_COL];
        // It's an echo if the operation is the same AND the LWW value is the same or older.
        // For deletes, the LWW value is not applicable.
        if (pushedInfo.op === log.tag.charAt(0).toUpperCase() &&
            (pushedInfo.op === 'D' || (pushedInfo.lww && incomingLww <= pushedInfo.lww))) 
        {
            recentlyPushed.get(tableName)!.delete(pkValues); // Consume the echo
            if (recentlyPushed.get(tableName)!.size === 0) {
                recentlyPushed.delete(tableName);
            }
            return;
        }
    }

    try {
        if (isDelete) {
            await localDelete(tableName, rowData);
        } else {
            await localUpsert(tableName, rowData);
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('does not exist')) {
            if (syncPool) {
                const client = await syncPool.connect();
                try {
                    await createTableFromRemote(client, tableName);
                } finally {
                    client.release();
                }
            } else {
                console.error(`Cannot create table '${tableName}': syncPool is not configured.`);
                return;
            }

            // Retry the operation after creating the table
            if (isDelete) {
                await localDelete(tableName, rowData);
            } else {
                await localUpsert(tableName, rowData);
            }
        } else {
            throw error;
        }
    }
}

export async function startPuller(cfg: InitMsg) {
    if (!syncPool) return;

    const slot = `edge_${EDGE_ID.replace(/-/g, "")}`;
    const pubName = `edge_pub_${EDGE_ID.replace(/-/g, "")}`;
    
    const client = await syncPool.connect();
    try {
        // 1. Ensure publication exists
        const pubExists = await client.query(`SELECT 1 FROM pg_publication WHERE pubname = $1`, [pubName]);
        if (pubExists.rows.length === 0) {
            await client.query(`CREATE PUBLICATION ${ident(pubName)} FOR ALL TABLES`);
        }

        // 2. Ensure replication slot exists, cleaning up old ones if necessary.
        const slotExistsResult = await client.query(`SELECT 1 FROM pg_replication_slots WHERE slot_name = $1`, [slot]);
        if (slotExistsResult.rows.length === 0) {
            // Slot doesn't exist, let's try to clean up old inactive slots from our app
            const oldSlotsResult = await client.query(`
                SELECT slot_name FROM pg_replication_slots 
                WHERE plugin = 'pgoutput' AND active = 'false' AND slot_name LIKE 'edge_%'
            `);
            for (const oldSlot of oldSlotsResult.rows) {
                try {
                    await client.query(`SELECT pg_drop_replication_slot($1)`, [oldSlot.slot_name]);
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    console.error(`Could not drop old slot ${oldSlot.slot_name}:`, message);
                }
            }
            // Now, try to create the new slot
            await client.query(`SELECT pg_create_logical_replication_slot($1, 'pgoutput')`, [slot]);
        } 

    } catch(err) {
        console.error("Failed to ensure publication/slot:", err);
        // Don't continue if we can't set up the slot
        client.release();
        throw err;
    }
    finally {
        client.release();
    }

    repl = new LogicalReplicationService({ connectionString: syncPool.options.connectionString });

    // --- FIX: Run subscription as a background process ---
    
    // Wrap the subscription in a promise that resolves when replication starts
    const started = new Promise<void>((resolve, reject) => {
        repl!.on('start', () => {
            resolve();
        });
        repl!.on('error', (err) => {
            console.error("Replication error, will not start:", err);
            reject(err);
        });
    });

    repl.on('data', (lsn: string, log: any) => {
        if (log.tag === 'insert' || log.tag === 'update' || log.tag === 'delete') {
            handleWalMessage(log).catch(err => console.error("WAL Error:", err));
        }
    });

    const plugin = new PgoutputPlugin({ protoVersion: 1, publicationNames: [pubName] });
    
    // Start the subscription but don't await its completion here
    repl.subscribe(plugin, slot).catch(err => {
        console.error("Replication subscription failed:", err);
    });

    // Wait only for the 'start' event before returning
    await started;

}

export async function stopPuller() {
    await repl?.stop();
    repl = null;
} 