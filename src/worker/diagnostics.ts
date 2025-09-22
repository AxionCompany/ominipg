
import { mainDb, mainDbType, syncPool, recentlyPushed } from './db.ts';

/**
 * Gathers diagnostic information about the current state of the database worker.
 * @returns An object containing various pieces of diagnostic information.
 */
export async function getDiagnosticInfo(): Promise<any> {
    let outboxInfo = {};
    try {
        const countResult = await mainDb.query('SELECT COUNT(*) as count FROM _outbox');
        outboxInfo = {
            totalCount: parseInt(((countResult.rows[0] as { count?: string } | undefined)?.count) || '0'),
        };
    } catch (e) {
        outboxInfo = { error: 'Outbox table not available.' };
    }

    let syncInfo = {};
    try {
        const state = await mainDb.query('SELECT * FROM _sync_state WHERE id = 1');
        syncInfo = state.rows[0] || {};
    } catch (e) {
        syncInfo = { error: 'Sync state table not available.' };
    }

    const tablesResult = await mainDb.query(`
        SELECT tablename FROM pg_tables 
        WHERE schemaname = 'public' AND tablename NOT LIKE '_%'
    `);

    return {
        mainDatabase: {
            type: mainDbType,
        },
        syncDatabase: {
            hasSyncPool: !!syncPool,
        },
        syncState: syncInfo,
        outbox: outboxInfo,
        trackedTables: (tablesResult.rows as Array<{ tablename: string }>).map((r) => r.tablename),
        echoPrevention: {
            trackedTables: Array.from(recentlyPushed.keys()),
            entries: Object.fromEntries(
                Array.from(recentlyPushed.entries()).map(([table, pkSet]) => [
                    table, Array.from(pkSet)
                ])
            )
        }
    };
} 