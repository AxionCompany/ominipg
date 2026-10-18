import { EventEmitter } from "node:events";
import { assertEquals, assertRejects } from "@std/assert";
import { createEmbeddedOminipgSession } from "../src/session/embedded.ts";
import { openOminipgSession } from "../src/session/client.ts";
import { Ominipg } from "../src/client/index.ts";
import type { PgModule, PgPoolClient } from "../src/shared/types.ts";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
for (const continueReading of [false, true]) {
  for (const rollback of [false, true]) {
    Deno.test(`pooled ${continueReading ? "continued read then" : "direct"} ${rollback ? "rollback" : "commit"} releases a connection awaited by an unrelated timeout`, async () => {
      const operations: string[] = [];
      const waiting: Array<
        { resolve(value: PgPoolClient): void; reject(reason: Error): void }
      > = [];
      let occupied = false;
      function client(): PgPoolClient {
        occupied = true;
        let released = false;
        return Object.assign(new EventEmitter(), {
          query(sql: string) {
            operations.push(sql);
            return Promise.resolve({ rows: [] });
          },
          release() {
            if (released) {
              return;
            }
            released = true;
            occupied = false;
            const next = waiting.shift();
            if (next) next.resolve(client());
          },
        }) as unknown as PgPoolClient;
      }
      class Pool {
        connect() {
          return occupied
            ? new Promise<PgPoolClient>((resolve, reject) =>
              waiting.push({ resolve, reject })
            )
            : Promise.resolve(client());
        }
        end() {
          return Promise.resolve();
        }
      }
      const db = await Ominipg.connect({
        url: "postgres://test/test",
        pgPoolMax: 1,
        requestTimeoutMs: 40,
        pgProvider: { loadPg: () => Promise.resolve({ Pool } as PgModule) },
      });
      const entered = gate();
      const release = gate();
      let transaction: Promise<number> | undefined;
      try {
        operations.length = 0;
        transaction = db.transaction(async (tx) => {
          await tx.query("SELECT owned");
          entered.resolve();
          await release.promise;
          if (continueReading) await tx.query("SELECT continued");
          if (rollback) throw new Error("expected callback failure");
          return 42;
        }).catch((error) => {
          if (
            rollback && error instanceof Error &&
            error.message === "expected callback failure"
          ) return 42;
          throw error;
        });
        await entered.promise;
        await assertRejects(
          () => db.query("SELECT waiting"),
          Error,
          "timed out",
        );
        assertEquals(waiting.length, 1);
        release.resolve();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const outcome = await Promise.race([
            transaction,
            new Promise<string>((resolve) => {
              timer = setTimeout(
                () => resolve("terminal blocked by unrelated raw request"),
                120,
              );
            }),
          ]);
          assertEquals(outcome, 42);
        } finally {
          clearTimeout(timer);
        }
        await db.query("SELECT after");
        assertEquals(operations, [
          "BEGIN",
          "SELECT owned",
          ...(continueReading ? ["SELECT continued"] : []),
          rollback ? "ROLLBACK" : "COMMIT",
          "SELECT waiting",
          "SELECT after",
        ]);
      } finally {
        release.resolve();
        // Test-only escape lets the intentionally failing baseline drain cleanly.
        for (const request of waiting.splice(0)) {
          request.reject(new Error("test cleanup releases blocked checkout"));
        }
        await transaction?.catch(() => {});
        await db.close();
      }
    });
  }
}

for (const defaultLane of [false, true]) {
  Deno.test(`pooled ${defaultLane ? "default" : "named"} lane waits for its own raw timeout while another lane progresses`, async () => {
    const operations: string[] = [];
    const release = gate();
    const waiting = gate();
    class Pool {
      connect() {
        return Promise.resolve(Object.assign(new EventEmitter(), {
          async query(sql: string) {
            operations.push(sql);
            if (sql === "SELECT slow") await release.promise;
            return { rows: [] };
          },
          release() {},
        }) as unknown as PgPoolClient);
      }
      end() {
        return Promise.resolve();
      }
    }
    const db = await Ominipg.connect({
      url: "postgres://test/test",
      requestTimeoutMs: 40,
      pgProvider: { loadPg: () => Promise.resolve({ Pool } as PgModule) },
    });
    const run = async (query: (sql: string) => Promise<unknown>) => {
      await assertRejects(() => query("SELECT slow"), Error, "timed out");
      const next = query("SELECT next");
      waiting.resolve();
      await next;
    };
    const operation = defaultLane
      ? run((sql) => db.query(sql))
      : db.transaction((tx) => run((sql) => tx.query(sql)));
    void operation.catch(() => {});
    try {
      await waiting.promise;
      if (defaultLane) {
        await db.transaction((tx) => tx.query("SELECT independent"));
      } else await db.query("SELECT independent");
      await new Promise((done) => setTimeout(done, 70));
      assertEquals(operations.includes("SELECT independent"), true);
      assertEquals(
        operations.includes("SELECT next"),
        false,
        "same lane query must not be sent or start its deadline yet",
      );
      release.resolve();
      await operation;
      assertEquals(operations.includes("SELECT next"), true);
    } finally {
      release.resolve();
      await operation.catch(() => {});
      await db.close();
    }
  });
}

const postgresUrl = Deno.env.get("DB_URL_PG");
for (const listen of [false, true]) {
  Deno.test({
    name: `real PostgreSQL: occupied ${
      listen ? "two-slot pool with LISTEN" : "one-slot pool"
    } still permits named read and terminal after checkout timeout`,
    ignore: !postgresUrl,
    async fn() {
      const { createPgProvider } = await import("../src/providers/pg.ts");
      const db = await Ominipg.connect({
        url: postgresUrl!,
        pgProvider: createPgProvider(),
        pgPoolMax: listen ? 2 : 1,
        requestTimeoutMs: 100,
      });
      const entered = gate();
      const release = gate();
      let transaction: Promise<void> | undefined;
      let transactionDone = false;
      let backendPid: number | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let current: Promise<unknown> | undefined;
      let subscription: Awaited<ReturnType<typeof db.listen>> | undefined;
      try {
        if (listen) {
          subscription = await db.listen("ominipg_lane_progress", () => {});
        }
        transaction = db.transaction(async (tx) => {
          await tx.query(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
          );
          backendPid =
            (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
              .rows[0].pid;
          entered.resolve();
          await release.promise;
          await tx.query("SELECT 2");
        });
        void transaction.then(() => {
          transactionDone = true;
        }, () => {
          transactionDone = true;
        });
        await Promise.race([entered.promise, transaction]);
        current = db.query("SELECT 1");
        await assertRejects(() => current!, Error, "timed out");
        release.resolve();
        const ended = await Promise.race([
          transaction.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), 2000);
          }),
        ]);
        assertEquals(
          ended,
          true,
          "named lane must not deadlock behind the timed-out checkout",
        );
        assertEquals((await db.query("SELECT 3 AS value")).rows, [{
          value: 3,
        }]);
      } finally {
        clearTimeout(timer);
        release.resolve();
        if (!transactionDone && backendPid !== undefined) {
          // Only a failed regression uses this separate test-owned connection.
          // Release our observed backend so even a failing test drains cleanly.
          const rescue = await Ominipg.connect({
            url: postgresUrl!,
            pgProvider: createPgProvider(),
            pgPoolMax: 1,
          });
          try {
            await rescue.query("SELECT pg_terminate_backend($1)", [backendPid]);
          } finally {
            await rescue.close();
          }
        }
        await transaction?.catch(() => {});
        await current?.catch(() => {});
        await subscription?.close();
        await db.close();
      }
    },
  });
}

Deno.test("queued session payload cannot change the transaction scope after admission", async () => {
  const a = gate(), b = gate();
  const operations: string[] = [];
  class Pool {
    connect() {
      return Promise.resolve(Object.assign(new EventEmitter(), {
        async query(sql: string) {
          operations.push(sql);
          if (sql === "SELECT holdA") await a.promise;
          if (sql === "SELECT holdB") await b.promise;
          return { rows: [] };
        },
        release() {},
      }) as unknown as PgPoolClient);
    }
    end() {
      return Promise.resolve();
    }
  }
  const embedded = await createEmbeddedOminipgSession({
    pgProvider: { loadPg: () => Promise.resolve({ Pool } as PgModule) },
  });
  const session = await openOminipgSession(embedded.transport, {
    onError() {},
    onClose: () => embedded.close(),
    requestTimeoutMs: 50,
  });
  let next: Promise<unknown> | undefined;
  try {
    await session.request("initialize", {
      url: "postgres://test/test",
      pgPoolMax: 3,
    });
    await session.request("query", { sql: "BEGIN", transaction: "A" });
    await session.request("query", { sql: "BEGIN", transaction: "B" });
    await Promise.all([
      assertRejects(
        () =>
          session.request("query", { sql: "SELECT holdA", transaction: "A" }),
        Error,
        "timed out",
      ),
      assertRejects(
        () =>
          session.request("query", { sql: "SELECT holdB", transaction: "B" }),
        Error,
        "timed out",
      ),
    ]);
    const payload = { sql: "SELECT afterA", transaction: "A" };
    next = session.request("query", payload);
    void next.catch(() => {});
    payload.transaction = "B";
    a.resolve();
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(
      operations.includes("SELECT afterA"),
      true,
      "queued query changed to still-held B rather than its admitted A scope",
    );
    await next;
  } finally {
    a.resolve();
    b.resolve();
    await next?.catch(() => {});
    await session.whenIdle();
    await session.request("query", { sql: "ROLLBACK", transaction: "A" }).catch(
      () => {},
    );
    await session.request("query", { sql: "ROLLBACK", transaction: "B" }).catch(
      () => {},
    );
    await session.close();
    await embedded.close();
  }
});

Deno.test("unlisten completes independently while unrelated default checkout is timed out", async () => {
  const operations: string[] = [];
  const waiting: Array<(x: PgPoolClient) => void> = [];
  let occupied = 0;
  function client(): PgPoolClient {
    occupied++;
    let released = false;
    const c = {
      query(sql: string) {
        operations.push(sql);
        return Promise.resolve({ rows: [] });
      },
      release() {
        if (released) return;
        released = true;
        occupied--;
        const next = waiting.shift();
        if (next) next(client());
      },
      on() {
        return c;
      },
      removeListener() {
        return c;
      },
    };
    return c as unknown as PgPoolClient;
  }
  class Pool {
    options = { max: 2 };
    connect() {
      return occupied >= 2
        ? new Promise<PgPoolClient>((r) => waiting.push(r))
        : Promise.resolve(client());
    }
    end() {
      return Promise.resolve();
    }
  }
  const db = await Ominipg.connect({
    url: "postgres://test/test",
    pgPoolMax: 2,
    requestTimeoutMs: 40,
    pgProvider: { loadPg: () => Promise.resolve({ Pool } as PgModule) },
  });
  const entered = gate(), release = gate();
  let tx: Promise<unknown> | undefined;
  let subscription: Awaited<ReturnType<typeof db.listen>> | undefined;
  let closed: Promise<void> | undefined;
  let done = false;
  try {
    subscription = await db.listen("review_listener", () => {});
    tx = db.transaction(async (t) => {
      await t.query("SELECT owned");
      entered.resolve();
      await release.promise;
    });
    void tx.catch(() => {});
    await entered.promise;
    await assertRejects(() => db.query("SELECT waiter"), Error, "timed out");
    assertEquals(waiting.length, 1);
    closed = subscription.close().then(() => {
      done = true;
    });
    void closed.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    assertEquals(
      done,
      true,
      "unlisten must not wait for an unrelated default checkout",
    );
    assertEquals(operations.some((s) => s.startsWith("UNLISTEN")), true);
  } finally {
    release.resolve();
    await tx?.catch(() => {});
    await closed?.catch(() => {});
    await subscription?.close();
    await db.close();
  }
});

Deno.test("unlisten waits for its own pending listen before starting a deadline", async () => {
  const entered = gate();
  const release = gate();
  const operations: string[] = [];
  class Pool {
    options = { max: 2 };
    connect() {
      const c = {
        async query(sql: string) {
          operations.push(sql);
          if (sql.startsWith("LISTEN")) {
            entered.resolve();
            await release.promise;
          }
          return { rows: [] };
        },
        release() {},
        on() {
          return c;
        },
        removeListener() {
          return c;
        },
      };
      return Promise.resolve(c as unknown as PgPoolClient);
    }
    end() {
      return Promise.resolve();
    }
  }
  const embedded = await createEmbeddedOminipgSession({
    pgProvider: { loadPg: () => Promise.resolve({ Pool } as PgModule) },
  });
  const session = await openOminipgSession(embedded.transport, {
    onError() {},
    onClose: () => embedded.close(),
    requestTimeoutMs: 40,
  });
  let closing: Promise<unknown> | undefined;
  let listened: Promise<unknown> | undefined;
  try {
    await session.request("initialize", {
      url: "postgres://test/test",
      pgPoolMax: 2,
    });
    listened = assertRejects(
      () =>
        session.request("listen", {
          subscriptionId: "one",
          channel: "pending_listener",
        }),
      Error,
      "timed out",
    );
    await entered.promise;
    let ended = false;
    let failed = false;
    closing = session.request("unlisten", { subscriptionId: "one" });
    void closing.then(() => {
      ended = true;
    }, () => {
      failed = true;
    });
    await new Promise((done) => setTimeout(done, 70));
    assertEquals(ended, false);
    assertEquals(failed, false);
    assertEquals(operations.some((sql) => sql.startsWith("UNLISTEN")), false);
    release.resolve();
    await listened;
    await closing;
    assertEquals(ended, true);
    assertEquals(
      operations.filter((sql) => sql.startsWith("UNLISTEN")).length,
      1,
    );
  } finally {
    release.resolve();
    await listened?.catch(() => {});
    await closing?.catch(() => {});
    await session.close();
    await embedded.close();
  }
});

Deno.test("unsupported request encoding leaves no pending raw request or timer", async () => {
  class Pool {
    connect() {
      return Promise.resolve(Object.assign(new EventEmitter(), {
        query() {
          return Promise.resolve({ rows: [] });
        },
        release() {},
      }) as unknown as PgPoolClient);
    }
    end() {
      return Promise.resolve();
    }
  }
  const embedded = await createEmbeddedOminipgSession({
    pgProvider: { loadPg: () => Promise.resolve({ Pool } as PgModule) },
  });
  const session = await openOminipgSession(embedded.transport, {
    onError() {},
    onClose: () => embedded.close(),
    requestTimeoutMs: 100,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await session.request("initialize", { url: "postgres://test/test" });
    class UnsupportedEnvelope {
      sql = "SELECT unsupported";
    }
    await assertRejects(
      () => session.request("query", new UnsupportedEnvelope()),
      TypeError,
      "cannot encode UnsupportedEnvelope",
    );
    class UnsupportedParameter {}
    await assertRejects(
      () =>
        session.request("query", {
          sql: "SELECT unsupported",
          params: [new UnsupportedParameter()],
        }),
      TypeError,
      "cannot encode UnsupportedParameter",
    );
    const drained = await Promise.race([
      session.whenIdle().then(() => true),
      new Promise<boolean>((done) => {
        timer = setTimeout(() => done(false), 20);
      }),
    ]);
    assertEquals(
      drained,
      true,
      "encoding failure must never install a raw response waiter",
    );
  } finally {
    clearTimeout(timer);
    await session.close();
    await embedded.close();
  }
});
