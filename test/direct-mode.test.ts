import { Ominipg } from "../src/client/index.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PG_URL = Deno.env.get("DB_URL_PG"); // postgres:// URL
if (!PG_URL) {
  Deno.test({
    name: "Direct Postgres mode: skipped (missing DB_URL_PG)",
    ignore: true,
    fn: () => {},
  });
} else {
  Deno.test("Direct Postgres mode: DDL setup via schemaSQL, basic query, and cleanup", async () => {
    const schemaDDL = [
      `CREATE TABLE IF NOT EXISTS test_items (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )`,
    ];
    const db = await Ominipg.connect({
      url: PG_URL,
      logMetrics: true,
      schemaSQL: schemaDDL,
    });

    try {
      // Optional pause to observe memory in CI if needed
      console.log("Waiting for 10 seconds");
      await sleep(10000);

      console.log("Running basic queries");
      // Sanity check against Postgres
      const ping = await db.query("SELECT 1 as x");
      assertEquals(ping.rows.length, 1);
      assertEquals(ping.rows[0].x, 1);

      // Work with created table
      await db.query("INSERT INTO test_items(name) VALUES ($1)", ["hello"]);
      const { rows } = await db.query("SELECT name FROM test_items");
      assertEquals(rows.length >= 1, true);

      // Direct mode must not allow sync
      await assertRejects(
        () => db.sync(),
        Error,
        "Sync is disabled in direct Postgres mode",
      );
    } finally {
      // --- Cleanup: drop all tables in public schema ---
      try {
        const { rows: toDrop } = await db.query(`
                    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
                `);
        for (const r of toDrop as Array<{ tablename: string }>) {
          await db.query(`DROP TABLE IF EXISTS "${r.tablename}" CASCADE`);
        }
      } catch (cleanupErr) {
        console.warn("Cleanup failed:", cleanupErr);
      }

      await db.close();
    }
  });
}
