import type { PgPoolClient } from "../db.ts";
import { mainDb, syncPool } from "../db.ts";
import { ident } from "../utils.ts";

/**
 * Synchronizes the sequences for a single table from remote to local.
 * @param remoteClient A client connected to the remote database.
 * @param tableName The name of the table.
 */
export async function synchronizeTableSequences(
  remoteClient: PgPoolClient,
  tableName: string,
) {
  const sequencesResult = await remoteClient.query(
    `
        SELECT s.sequencename, c.column_name
        FROM pg_sequences s
        JOIN information_schema.columns c ON c.column_default LIKE '%' || s.sequencename || '%'
        WHERE c.table_name = $1 AND c.table_schema = 'public'
    `,
    [tableName],
  );

  for (
    const seqRow of sequencesResult.rows as Array<
      { sequencename: string; column_name: string }
    >
  ) {
    const { sequencename, column_name } = seqRow;

    const maxResult = await mainDb.query(`
            SELECT COALESCE(MAX(${ident(column_name)}), 0) as max_val FROM ${
      ident(tableName)
    }
        `);
    const maxVal = parseInt(
      (maxResult.rows[0] as { max_val?: string } | undefined)?.max_val || "0",
    );

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

  const client = await syncPool.connect();
  try {
    const tablesResult = await mainDb.query(`
            SELECT tablename FROM pg_tables 
            WHERE schemaname = 'public' AND tablename NOT LIKE '_%'
        `);

    for (const tableRow of tablesResult.rows as Array<{ tablename: string }>) {
      await synchronizeTableSequences(client, tableRow.tablename);
    }

    return tablesResult.rows.length;
  } finally {
    client.release();
  }
}
