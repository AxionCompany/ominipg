import { EdgeDB } from '../src/client/index.ts';
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";

const SYNC_DB_URL = Deno.env.get('SYNC_DB_URL')!;
const DB_URL = Deno.env.get('DB_URL') || 'file://test/test.db';

const schemaDDL: string[] = [
    `CREATE TABLE IF NOT EXISTS todos (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        completed BOOLEAN DEFAULT false,
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );`,
];

// Ensure a clean slate before the test runs
if (DB_URL && DB_URL.startsWith('file://')) {
    try {
        await Deno.remove(DB_URL, { recursive: true });
    } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
}


Deno.test("E2E Sync Test", async (t) => {
    // Clean remote state before connecting and initial sync
    const cleaner = new (await import('npm:pg')).Pool({ connectionString: SYNC_DB_URL });
    try {
        await cleaner.query('DELETE FROM todos');
    } finally {
        await cleaner.end();
    }

    // 1. Connect to the database
    const db = await EdgeDB.connect({
        url: DB_URL,
        syncUrl: SYNC_DB_URL,
        schemaSQL: schemaDDL,
        disableAutoPush: true, // Disable auto-push for predictable testing
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
        const remote = new (await import('npm:pg')).Pool({ connectionString: SYNC_DB_URL });
        const { rows } = await remote.query('SELECT * FROM todos WHERE id = $1', [localId]);
        await remote.end();

        assertEquals(rows.length, 1);
        assertEquals(rows[0].title, 'My Test Todo');
        assertEquals(rows[0].completed, false);
    });

    await t.step("Update data on remote and pull", async () => {
        const remote = new (await import('npm:pg')).Pool({ connectionString: SYNC_DB_URL });
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