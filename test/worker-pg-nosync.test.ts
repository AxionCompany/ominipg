import { Ominipg } from "../src/client/index.ts";
import { createPgProvider } from "../src/providers/pg.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";

const PG_URL = Deno.env.get("DB_URL_PG"); // postgres:// URL

if (!PG_URL) {
  Deno.test({
    name: "Postgres Oxian session: skipped (missing DB_URL_PG)",
    ignore: true,
    fn: () => {},
  });
} else {
  Deno.test("Postgres Oxian session without sync: query and diagnostics", async () => {
    const db = await Ominipg.connect({
      url: PG_URL,
      pgProvider: createPgProvider(),
    });

    const { rows } = await db.query("SELECT 1 as x");
    assertEquals(rows.length, 1);
    assertEquals(rows[0].x, 1);

    const info = await db.getDiagnosticInfo();
    const diag = info as { syncDatabase?: { hasSyncPool?: boolean } };
    assertEquals(!!diag.syncDatabase?.hasSyncPool, false);

    await db.close();
  });

  Deno.test("Postgres Oxian session runs transactions concurrently and isolated", async () => {
    const db = await Ominipg.connect({
      url: PG_URL,
      pgProvider: createPgProvider(),
      pgPoolMax: 4,
    });
    const table = `lane_test_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await db.query(`CREATE TABLE ${table} (id int PRIMARY KEY)`);

      // Each transaction waits for the other to start, which deadlocks if
      // transactions are serialized.
      let startFirst!: () => void;
      let startSecond!: () => void;
      const firstStarted = new Promise<void>((r) => startFirst = r);
      const secondStarted = new Promise<void>((r) => startSecond = r);
      const first = db.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${table} VALUES (1)`);
        startFirst();
        await secondStarted;
        await db.notify("lane_test", "open transaction");
        await db.getDiagnosticInfo();
        const outside = await db.query(
          `SELECT count(*)::int AS n FROM ${table}`,
        );
        assertEquals(outside.rows[0].n, 0);
        return "first";
      });
      const second = db.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${table} VALUES (2)`);
        startSecond();
        await firstStarted;
        throw new Error("rolled back");
      });

      const [firstResult] = await Promise.all([
        first,
        assertRejects(() => second, Error, "rolled back"),
      ]);
      assertEquals(firstResult, "first");
      const { rows } = await db.query(`SELECT id FROM ${table} ORDER BY id`);
      assertEquals(rows, [{ id: 1 }]);
    } finally {
      await db.query(`DROP TABLE IF EXISTS ${table}`);
      await db.close();
    }
  });
}
