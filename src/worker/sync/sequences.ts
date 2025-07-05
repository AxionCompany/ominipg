import pg from 'npm:pg';
import { mainDb, syncPool } from '../db.ts';
import { ident } from '../utils.ts';

/**
 * Synchronizes the sequences for a single table from remote to local.
 * @param remoteClient A client connected to the remote database.
 * @param tableName The name of the table.
 */
export async function synchronizeTableSequences(remoteClient: pg.PoolClient, tableName: string) {
    const sequencesResult = await remoteClient.query(`
        SELECT s.sequencename, c.column_name
        FROM pg_sequences s
        JOIN information_schema.columns c ON c.column_default LIKE '%' || s.sequencename || '%'
        WHERE c.table_name = $1 AND c.table_schema = 'public'
    `, [tableName]);

    for (const seqRow of sequencesResult.rows) {
        const { sequencename, column_name } = seqRow;
        
        const maxResult = await mainDb.query(`
            SELECT COALESCE(MAX(${ident(column_name)}), 0) as max_val FROM ${ident(tableName)}
        `);
        const maxVal = parseInt(maxResult.rows[0]?.max_val || '0');
        
        if (maxVal > 0) {
            await mainDb.query(`SELECT setval($1, $2)`, [sequencename, maxVal + 1]);
        }
    }
}

/**
 * Synchronizes all sequences for all user tables from remote to local.
 */
export async function synchronizeSequences(): Promise<number> {
    if (!syncPool) return 0;
    
    console.log("Synchronizing all sequences...");
    const client = await syncPool.connect();
    try {
        const tablesResult = await mainDb.query(`
            SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public' AND tablename NOT LIKE '_%'
        `);

        for (const tableRow of tablesResult.rows) {
            await synchronizeTableSequences(client, tableRow.tablename);
        }
        
        console.log(`Sequence synchronization complete for ${tablesResult.rows.length} tables.`);
        return tablesResult.rows.length;

    } finally {
        client.release();
    }
} 