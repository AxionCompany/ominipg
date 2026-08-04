import { Ominipg } from "../src/client/index.ts";
import { createPgProvider } from "../src/providers/pg.ts";
import { assertEquals } from "jsr:@std/assert@1.0.13";

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
}
