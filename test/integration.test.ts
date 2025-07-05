
import { EdgeDB } from '../src/client/index.ts';
import { assert, assertEquals } from "https://deno.land/std@0.217.0/assert/mod.ts";

const DATABASE_URL = 'postgresql://postgres:2BIBLcw3bTgsJ76b@db.wycqhklavrdbablrkaeb.supabase.co:5432/postgres';
const LOCAL_DB_PATH = 'test/test.db';

const schemaDDL = [
    `CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
       NEW.updated_at = NOW();
       RETURN NEW;
    END;
    $$ language 'plpgsql';`,

    `CREATE TABLE IF NOT EXISTS todos (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        completed BOOLEAN DEFAULT false,
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );`,

    `DROP TRIGGER IF EXISTS todos_updated_at_modtime ON todos;`,

    `CREATE TRIGGER todos_updated_at_modtime
        BEFORE UPDATE ON todos
        FOR EACH ROW
        EXECUTE PROCEDURE update_updated_at_column();`
];

// Ensure a clean slate before the test runs
try {
    await Deno.remove(LOCAL_DB_PATH, { recursive: true });
} catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
}

Deno.test("E2E Sync Test", async (t) => {
    // 1. Connect to the database
    const db = await EdgeDB.connect({
        url: `file://${LOCAL_DB_PATH}`,
        syncUrl: DATABASE_URL,
        schemaSQL: schemaDDL,
        disableAutoPush: true, // Disable auto-push for predictable testing
    });

    await t.step("Clean remote state", async () => {
        const remote = new (await import('npm:pg')).Pool({ connectionString: DATABASE_URL });
        await remote.query('DELETE FROM todos');
        // The LWW trigger is now applied automatically by the worker during boot,
        // so we no longer need to apply it manually here.
        await remote.end();
    });

    let localId: number;
    await t.step("Insert local data and push", async () => {
        const result = await db.queryRaw(
            `INSERT INTO todos (title) VALUES ($1) RETURNING id`,
            ['My Test Todo']
        );
        localId = result.rows[0].id;
        
        const { pushed } = await db.sync();
        assertEquals(pushed, 1, "Should have pushed 1 change");
    });

    await t.step("Verify data on remote", async () => {
        const remote = new (await import('npm:pg')).Pool({ connectionString: DATABASE_URL });
        const { rows } = await remote.query('SELECT * FROM todos WHERE id = $1', [localId]);
        await remote.end();

        assertEquals(rows.length, 1);
        assertEquals(rows[0].title, 'My Test Todo');
        assertEquals(rows[0].completed, false);
    });

    await t.step("Update data on remote and pull", async () => {
        const remote = new (await import('npm:pg')).Pool({ connectionString: DATABASE_URL });
        await remote.query('UPDATE todos SET completed = true WHERE id = $1', [localId]);
        await remote.end();

        // Wait for the puller to receive and apply the change
        await new Promise(resolve => setTimeout(resolve, 3000)); // Allow time for replication
    });

    await t.step("Verify change on local", async () => {
        const { rows } = await db.queryRaw('SELECT * FROM todos WHERE id = $1', [localId]);
        assertEquals(rows.length, 1);
        assert(rows[0].completed === true, "Local record should be marked as completed");
    });

    await db.close();
}); 