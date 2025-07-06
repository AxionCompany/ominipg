
import { syncPool, mainDb, meta } from '../db.ts';
import { createTableFromRemote, ensureMeta } from '../schema.ts';
import { ident } from '../utils.ts';
import { LWW_COL } from '../bootstrap.ts';
import { synchronizeTableSequences } from './sequences.ts';

async function localUpsert(table: string, row: Record<string, unknown>) {
    const m = meta.get(table)!;
    const localColumns = new Set([...m.pk, ...m.non]);

    // Filter the incoming row to only include columns that exist in the local schema
    const filteredRow = Object.fromEntries(
        Object.entries(row).filter(([key]) => localColumns.has(key))
    );

    const pkList = m.pk.map(ident).join(",");
    
    // Build the SET clause only from columns present in the filtered row, excluding primary keys.
    const pkSet = new Set(m.pk);
    const updSet = Object.keys(filteredRow)
        .filter(key => !pkSet.has(key))
        .map(key => `${ident(key)} = EXCLUDED.${ident(key)}`)
        .join(", ");

    // If there are no columns to update (e.g. only PKs were sent), skip the query.
    if (updSet.length === 0) {
        return;
    }
    
    await mainDb.query(`
      INSERT INTO ${ident(table)}
      SELECT * FROM json_populate_record(null::${ident(table)}, $1) s
      ON CONFLICT (${pkList}) DO UPDATE
        SET ${updSet}
      WHERE ${ident(table)}.${ident(LWW_COL)} < EXCLUDED.${ident(LWW_COL)}
    `, [JSON.stringify(filteredRow)]);
}

/**
 * Performs the initial synchronization of data from the remote to the local database.
 * @param syncFromTimestamp Optional ISO timestamp to only sync data newer than.
 */
export async function performInitialSync(syncFromTimestamp?: string) {
    if (!syncPool) return;

    const client = await syncPool.connect();
    try {
        const tablesResult = await client.query(`
            SELECT tablename FROM pg_tables WHERE schemaname = 'public'
        `);

        await mainDb.exec(`SET session_replication_role = 'replica'`);

        for (const tableRow of tablesResult.rows) {
            const tableName = tableRow.tablename;
            if (tableName.startsWith('_')) continue;

            try {
                await createTableFromRemote(client, tableName);

                await ensureMeta(tableName, client);

                meta.delete(tableName);
                await ensureMeta(tableName);

                let query = `SELECT * FROM ${ident(tableName)}`;
                const params: any[] = [];
                if (syncFromTimestamp) {
                    query += ` WHERE ${ident(LWW_COL)} >= $1`;
                    params.push(syncFromTimestamp);
                }
                
                const dataResult = await client.query(query, params);
                for (const row of dataResult.rows) {
                    await localUpsert(tableName, row);
                }

                await synchronizeTableSequences(client, tableName);

            } catch (tableError) {
                console.error(`Failed to sync table '${tableName}':`, tableError);
            }
        }

        await mainDb.query(`
            UPDATE _sync_state SET last_pull = NOW() WHERE id = 1
        `);

    } finally {
        await mainDb.exec(`SET session_replication_role = 'origin'`);
        client.release();
    }
} 