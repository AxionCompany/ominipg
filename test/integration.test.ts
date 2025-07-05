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
        // Drop the table to ensure a clean slate, it will be recreated by the sync process.
        await cleaner.query('DROP TABLE IF EXISTS todos CASCADE');
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
        // Also update `updated_at` to ensure the LWW check passes on the puller.
        await remote.query('UPDATE todos SET completed = true, updated_at = NOW() WHERE id = $1', [localId]);
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

Deno.test("Initial Sync from Remote to Local", async (t) => {
    // 1. Set up the remote database with some initial data
    const remote = new (await import('npm:pg')).Pool({ connectionString: SYNC_DB_URL });
    let remoteId: any;
    try {
        await remote.query('DROP TABLE IF EXISTS todos CASCADE');
        // Manually apply the schema DDL to the remote
        for (const stmt of schemaDDL) {
            await remote.query(stmt);
        }
        const { rows } = await remote.query(
            "INSERT INTO todos (title, completed) VALUES ('Pre-existing Todo', false) RETURNING id"
        );
        remoteId = rows[0].id;
    } finally {
        await remote.end();
    }

    // 2. Connect the client, which should trigger the initial sync
    const db = await EdgeDB.connect({
        url: DB_URL,
        syncUrl: SYNC_DB_URL,
        schemaSQL: schemaDDL,
        disableAutoPush: true,
    });

    // 3. Verify that the initial data from remote exists locally
    await t.step("Verify pre-existing data is synced locally", async () => {
        const { rows } = await db.queryRaw('SELECT * FROM todos WHERE id = $1', [remoteId]);
        assertEquals(rows.length, 1, "Should have synced one pre-existing record.");
        assertEquals(rows[0].title, 'Pre-existing Todo');
    });

    await db.close();
});

Deno.test("Initial Sync from Local to Remote", async (t) => {
    // 1. Ensure remote is clean (no 'todos' table)
    const remoteCleaner = new (await import('npm:pg')).Pool({ connectionString: SYNC_DB_URL });
    try {
        await remoteCleaner.query('DROP TABLE IF EXISTS todos CASCADE');
    } finally {
        await remoteCleaner.end();
    }

    // 2. Connect to the DB. The initial sync service will create the schema on the remote.
    const db = await EdgeDB.connect({
        url: DB_URL,
        syncUrl: SYNC_DB_URL,
        schemaSQL: schemaDDL,
        disableAutoPush: true,
    });

    let localId: any;
    // 3. Insert data locally
    await t.step("Insert initial local data", async () => {
        const result = await db.queryRaw(
            "INSERT INTO todos (title, completed) VALUES ('Local-first Todo', false) RETURNING id"
        );
        localId = result.rows[0].id;
        assertEquals(result.rows.length, 1);
    });

    // 4. Push local changes to remote
    await t.step("Push local data to remote", async () => {
        const { pushed } = await db.sync();
        assertEquals(pushed, 1, "Should have pushed 1 local change to remote.");
    });


    // 5. Verify the data exists on the remote
    await t.step("Verify data synced to remote", async () => {
        const remoteVerifier = new (await import('npm:pg')).Pool({ connectionString: SYNC_DB_URL });
        try {
            const { rows } = await remoteVerifier.query('SELECT * FROM todos WHERE id = $1', [localId]);
            assertEquals(rows.length, 1, "Record should exist on remote after push.");
            assertEquals(rows[0].title, 'Local-first Todo');
        } finally {
            await remoteVerifier.end();
        }
    });

    await db.close();
});
