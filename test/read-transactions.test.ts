import { assertEquals } from "@std/assert";
import { Ominipg, type OminipgTransaction } from "../src/client/index.ts";
import { createPgProvider } from "../src/providers/pg.ts";
import { OminipgEngine } from "../src/worker/engine.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Transaction progress deadline")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const url = Deno.env.get("DB_URL_PG");
for (const mode of ["callback", "raw lane"] as const) {
  for (const max of [1, 3]) {
    Deno.test({
      name:
        `real postgres: ${mode} read-only REPEATABLE READ transactions fill pool ${max} and queue beyond it`,
      ignore: !url,
      async fn() {
        const options = {
          url: url!,
          pgPoolMax: max,
          pgProvider: createPgProvider(),
        };
        const db = mode === "callback"
          ? await Ominipg.connect(options)
          : undefined;
        const engine = mode === "raw lane"
          ? new OminipgEngine({ pgProvider: options.pgProvider })
          : undefined;
        if (engine) await engine.initialize(options);
        const transaction = async (
          callback: (tx: OminipgTransaction) => Promise<void>,
        ) => {
          if (db) {
            return await db.transaction(async (tx) => {
              await tx.query(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
              );
              await callback(tx);
            });
          }
          const lane = crypto.randomUUID();
          const query: OminipgTransaction["query"] = async <
            T extends Record<string, unknown>,
          >(sql: string, params?: unknown[]) => ({
            rows: await engine!.query(sql, params, lane) as T[],
          });
          await query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
          try {
            await callback({ query, queryRaw: query });
            await query("COMMIT");
          } catch (error) {
            await query("ROLLBACK");
            throw error;
          }
        };
        const releases = Array.from({ length: max }, gate);
        const entered = Array.from({ length: max }, gate);
        const pids = new Set<number>();
        const work: Promise<void>[] = [];
        const inspect = async (tx: OminipgTransaction) => {
          const { rows } = await tx.query<
            { pid: number; readonly: string; isolation: string }
          >(
            "SELECT pg_backend_pid() AS pid, current_setting('transaction_read_only') AS readonly, current_setting('transaction_isolation') AS isolation",
          );
          assertEquals(rows[0].readonly, "on");
          assertEquals(rows[0].isolation, "repeatable read");
          return rows[0].pid;
        };
        try {
          for (let i = 0; i < max; i++) {
            const task = transaction(async (tx) => {
              const pid = await inspect(tx);
              pids.add(pid);
              entered[i].resolve();
              await releases[i].promise;
              assertEquals(await inspect(tx), pid);
            });
            void task.catch(() => {});
            work.push(task);
          }
          await bounded(Promise.all(entered.map((value) => value.promise)));
          assertEquals(pids.size, max);
          let queuedEntered = false;
          const queued = transaction(async (tx) => {
            queuedEntered = true;
            assertEquals(pids.has(await inspect(tx)), true);
          });
          void queued.catch(() => {});
          work.push(queued);
          await new Promise((resolve) => setTimeout(resolve, 50));
          assertEquals(queuedEntered, false);
          releases[0].resolve();
          await bounded(queued);
          assertEquals(queuedEntered, true);
          for (const release of releases) release.resolve();
          await bounded(Promise.all(work));
          // All returned connections remain usable after ordinary cleanup.
          await transaction(async (tx) => {
            await inspect(tx);
          });
        } finally {
          for (const release of releases) release.resolve();
          await Promise.allSettled(work);
          await db?.close();
          await engine?.close();
        }
      },
    });
  }
}
