import { assertEquals } from "jsr:@std/assert@1.0.13";
import { Ominipg } from "../src/client/index.ts";
import { createPgProvider } from "../src/providers/pg.ts";

const pgUrl = Deno.env.get("DB_URL_PG");

if (!pgUrl) {
  Deno.test({
    name: "PostgreSQL notifications integration: skipped (missing DB_URL_PG)",
    ignore: true,
    fn: () => {},
  });
} else {
  Deno.test("PostgreSQL notifications deliver through a real direct connection", async () => {
    const db = await Ominipg.connect({
      url: pgUrl,
      useWorker: false,
      pgProvider: createPgProvider(),
      pgPoolMax: 3,
    });
    const channel = `ominipg_${crypto.randomUUID().replaceAll("-", "")}`;
    const payload = crypto.randomUUID();
    let timer: number | undefined;
    let resolveDelivered!: (payload: string) => void;
    let rejectDelivered!: (error: Error) => void;
    const delivered = new Promise<string>((resolve, reject) => {
      resolveDelivered = resolve;
      rejectDelivered = reject;
    });
    const subscription = await db.listen(channel, (notification) => {
      if (notification.payload === payload) {
        resolveDelivered(notification.payload);
      }
    });

    try {
      timer = Number(setTimeout(
        () =>
          rejectDelivered(
            new Error("Timed out waiting for PostgreSQL notification."),
          ),
        5_000,
      ));
      await db.notify(channel, payload);
      assertEquals(await delivered, payload);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await subscription.close();
      await db.close();
    }
  });
}
