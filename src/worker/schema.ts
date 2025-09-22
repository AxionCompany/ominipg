
import { mainDb, mainDbType, syncPool, meta } from './db.ts';
import { ident } from './utils.ts';
import type { PgPoolClient } from './db.ts';

/**
 * Attaches the outbox trigger to a single table.
 * Idempotent, and ignores errors if the trigger already exists.
 * @param tableName The name of the table to attach the trigger to.
 */
async function ensureTrigger(tableName: string) {
    try {
        await mainDb.exec(`
          CREATE TRIGGER outbox_trigger_${tableName}
            AFTER INSERT OR UPDATE OR DELETE ON ${ident(tableName)}
            FOR EACH ROW EXECUTE FUNCTION outbox_trigger_fn()
        `);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // It's okay if the trigger already exists.
        if (!message.includes('already exists')) {
            console.warn(`Failed to add outbox trigger to '${tableName}':`, message);
        }
    }
}

/**
 * Ensures all user tables have the outbox trigger attached.
 * This is only necessary for PGlite, as PostgreSQL uses logical replication.
 */
async function ensureAllTriggersExist() {
    const tablesResult = await mainDb.query(`
      SELECT tablename FROM pg_tables 
      WHERE schemaname = 'public' 
        AND tablename NOT LIKE '_sync%' 
        AND tablename NOT LIKE '_outbox%'
    `);

    for (const row of tablesResult.rows as Array<{ tablename: string }>) {
        await ensureTrigger(row.tablename);
    }
}

/**
 * Creates the trigger function used by PGlite to capture changes.
 */
async function createTriggerFunction() {
    await mainDb.exec(`
      CREATE OR REPLACE FUNCTION outbox_trigger_fn()
      RETURNS TRIGGER AS $$
      DECLARE
        is_applying_remote_change TEXT;
        pk_cols TEXT[];
        pk_vals JSONB := '{}';
        col_name TEXT;
      BEGIN
        -- Check a session variable to see if we should skip this trigger.
        -- This is to prevent the puller from creating an echo.
        BEGIN
          is_applying_remote_change := current_setting('app.sync.is_applying_remote_change', true);
        EXCEPTION WHEN OTHERS THEN
          is_applying_remote_change := 'false';
        END;

        IF is_applying_remote_change = 'true' THEN
          RETURN COALESCE(NEW, OLD); -- Do nothing
        END IF;

        -- Original trigger logic continues here
        SELECT array_agg(a.attname) INTO pk_cols
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = TG_RELID AND i.indisprimary;
        
        FOREACH col_name IN ARRAY pk_cols LOOP
          IF TG_OP = 'DELETE' THEN
            pk_vals := pk_vals || jsonb_build_object(col_name, to_jsonb(OLD.*)->col_name);
          ELSE
            pk_vals := pk_vals || jsonb_build_object(col_name, to_jsonb(NEW.*)->col_name);
          END IF;
        END LOOP;
        
        INSERT INTO _outbox (table_name, op, pk, row_json)
        VALUES (
          TG_TABLE_NAME, LEFT(TG_OP, 1), pk_vals,
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW.*) END
        );
        
        PERFORM pg_notify('outbox_new', TG_TABLE_NAME);
        RETURN COALESCE(NEW, OLD);
      END;
      $$ LANGUAGE plpgsql;
    `);
}

/**
 * Creates the tables and triggers required for the synchronization mechanism.
 */
async function createSyncInfrastructure() {
    await mainDb.exec(`
      CREATE TABLE IF NOT EXISTS _sync_state(
        id INT PRIMARY KEY DEFAULT 1,
        last_push BIGINT DEFAULT 0,
        last_pull TIMESTAMPTZ DEFAULT to_timestamp(0)
      );
      INSERT INTO _sync_state(id) VALUES(1) ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS _outbox(
        id BIGSERIAL PRIMARY KEY,
        table_name TEXT NOT NULL,
        op CHAR(1) NOT NULL,
        pk JSONB NOT NULL,
        row_json JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    if (mainDbType === 'pglite') {
        await createTriggerFunction();
        await ensureAllTriggersExist();
    }
}

/**
 * Applies the user-provided schema DDL and creates the sync infrastructure.
 * @param ddl An array of SQL DDL statements.
 * @param includeSyncInfrastructure Whether to create the sync tables and triggers.
 */
export async function bootstrapSchema(ddl: string[], includeSyncInfrastructure: boolean) {
    
    for (const stmt of ddl) {
        try {
            await mainDb.exec(stmt);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`DDL execution failed (this may be ok):`, message);
        }
    }

    if (includeSyncInfrastructure) {
        await createSyncInfrastructure();
    }

}

/**
 * Ensures the remote database has the same schema as defined in the DDL.
 */
export async function ensureRemoteSchema(ddl: string[]) {
    if (!syncPool || ddl.length === 0) return;
    
    const client = await syncPool.connect();
    try {
        await client.query('BEGIN');
        for (const stmt of ddl) {
            try {
                await client.query(stmt);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.warn(`Remote DDL execution failed (this may be ok):`, message);
            }
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Fetches the schema for a table from the remote DB and creates it locally.
 * This is used when the puller encounters data for a table that doesn't exist yet.
 * @param tableName The name of the table to create.
 */
export async function createTableFromRemote(client: PgPoolClient, tableName: string) {
    if (!syncPool) throw new Error("Cannot create table from remote: no sync pool available.");

    try {
        // --- FIX: Create sequences before creating the table ---
        const sequencesResult = await client.query(`
            SELECT s.sequencename
            FROM pg_sequences s
            JOIN information_schema.columns c ON c.column_default LIKE '%' || s.sequencename || '%'
            WHERE c.table_name = $1 AND c.table_schema = 'public'
        `, [tableName]);

    for (const seqRow of sequencesResult.rows as Array<{ sequencename: string }>) {
        await mainDb.exec(`CREATE SEQUENCE IF NOT EXISTS ${ident(seqRow.sequencename)}`);
        }
        // --- End of fix ---

        // Get column definitions
        const schemaResult = await client.query(`
            SELECT a.attname as column_name, format_type(a.atttypid, a.atttypmod) as data_type,
                   a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default_value
            FROM pg_attribute a
            LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum
            JOIN pg_class c ON a.attrelid = c.oid
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE c.relname = $1
              AND n.nspname = 'public'
              AND a.attnum > 0 AND NOT a.attisdropped
        `, [tableName]);

        if (schemaResult.rows.length === 0) {
            throw new Error(`Table '${tableName}' not found in remote database's 'public' schema.`);
        }

        // Get primary keys
        const pkResult = await client.query(`
            SELECT a.attname as column_name
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            JOIN pg_class c ON i.indrelid = c.oid
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE c.relname = $1
              AND n.nspname = 'public'
              AND i.indisprimary = true
        `, [tableName]);
        const primaryKeys = (pkResult.rows as Array<{ column_name: string }>).map((r) => ident(r.column_name));

        // Build CREATE TABLE statement
        const columns = (schemaResult.rows as Array<{ column_name: string; data_type: string; not_null: boolean; default_value: string | null }>).map((col) => {
            let def = `${ident(col.column_name)} ${col.data_type}`;
            if (col.not_null) def += ' NOT NULL';
            if (col.default_value) def += ` DEFAULT ${col.default_value}`;
            return def;
        });

        if (primaryKeys.length > 0) {
            columns.push(`PRIMARY KEY (${primaryKeys.join(', ')})`);
        }

        const createTableSQL = `CREATE TABLE ${ident(tableName)} (${columns.join(', ')})`;
        
        // Execute locally
        await mainDb.exec(createTableSQL);

        // If using PGlite, add the outbox trigger
        if (mainDbType === 'pglite') {
            await ensureTrigger(tableName);
        }

        // Invalidate meta cache for this table
        meta.delete(tableName);

    } catch (error) {
        // Handle race condition where table was created by another process
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("already exists")) {
            return;
        }
        console.error(`Failed to create table '${tableName}' from remote:`, error);
        throw error;
    }
}
/**
 * Caches metadata (primary keys, column names) for a given table.
 * @param table The name of the table.
 * @param providedClient Optional client to use for the query.
 */
export async function ensureMeta(table: string, providedClient?: PgPoolClient) {
    if (meta.has(table)) return;

    // If a client is provided, use it. Otherwise, always use the main local DB.
    const client = providedClient ?? mainDb;

    try {
        const query = `
            SELECT a.attname, i.indisprimary
            FROM pg_attribute a
            JOIN pg_class t ON a.attrelid = t.oid
            JOIN pg_namespace n ON t.relnamespace = n.oid
            LEFT JOIN pg_index i ON i.indrelid = t.oid AND a.attnum = ANY(i.indkey)
            WHERE t.relname = $1
              AND n.nspname = 'public'
              AND a.attnum > 0 AND NOT a.attisdropped
        `;
        
        const result = await (client as unknown as { query: (q: string, p: unknown[]) => Promise<{ rows: Array<{ attname: string; indisprimary: boolean }> }> }).query(query, [table]);

        if (result.rows.length === 0) {
            // Fallback for new tables not yet in remote, or for non-syncing DB
            meta.set(table, { pk: ['id'], non: [] });
            return;
        }

        const pk = result.rows.filter((r) => r.indisprimary).map((r) => r.attname);
        const non = result.rows.filter((r) => !r.indisprimary).map((r) => r.attname);

        const finalPk = pk.length > 0 ? pk : ['id'];
        meta.set(table, { pk: finalPk, non });

    } finally {
        // This function should not be responsible for releasing clients it didn't create.
    }
} 