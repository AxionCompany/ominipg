import { Ominipg } from '../src/client/index.ts';
import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const PG_URL = Deno.env.get('DB_URL_PG'); // postgres:// URL
console.log('PG_URL', PG_URL);
if (!PG_URL) {
    Deno.test({
        name: "Direct Postgres mode: skipped (missing DB_URL_PG)",
        ignore: true,
        fn: () => {},
    });
} else {
    Deno.test("Direct Postgres mode: basic query and disabled sync", async () => {
        const db = await Ominipg.connect({ url: PG_URL , logMetrics: true });

        console.log('Waiting for 100 seconds');
        await sleep(10000);
        console.log('Querying');
        const { rows } = await db.query('SELECT 1 as x');
        assertEquals(rows.length, 1);
        assertEquals(rows[0].x, 1);

        await assertRejects(
            () => db.sync(),
            Error,
            'Sync is disabled in direct Postgres mode'
        );

        await db.close();
    });
}

