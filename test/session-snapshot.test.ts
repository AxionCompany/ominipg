import { assertEquals, assertRejects } from "@std/assert";
import { createEmbeddedOminipgSession } from "../src/session/embedded.ts";
import { openOminipgSession } from "../src/session/client.ts";
import { createPGliteProvider } from "../src/providers/pglite.ts";
import { createPgProvider } from "../src/providers/pg.ts";

async function session(url = ":memory:", max = 2) {
  const embedded = await createEmbeddedOminipgSession(
    url === ":memory:"
      ? { pgliteProvider: createPGliteProvider() }
      : { pgProvider: createPgProvider() },
  );
  try {
    const client = await openOminipgSession(embedded.transport, {
      onError() {},
      onClose: () => embedded.close(),
      requestTimeoutMs: 5000,
    });
    await client.request("initialize", { url, pgPoolMax: max });
    return { client, embedded };
  } catch (error) {
    await embedded.close();
    throw error;
  }
}
const pgUrl = Deno.env.get("DB_URL_PG");
Deno.test({
  name: "pooled snapshot frames progress despite unrelated timed-out checkout",
  ignore: !pgUrl,
  async fn() {
    const { client } = await session(pgUrl!);
    try {
      await client.request("snapshot-open", { snapshotId: "pooled" });
      await assertRejects(
        () => client.request("query", { sql: "SELECT 1" }, 40),
        Error,
        "timed out",
      );
      await client.request("snapshot-query", {
        snapshotId: "pooled",
        sql: "BEGIN",
        current: true,
      });
      assertEquals(
        await client.request("snapshot-query", {
          snapshotId: "pooled",
          sql: "SELECT 42 AS value",
          current: true,
        }),
        { rows: [{ value: 42 }] },
      );
      await client.request("snapshot-query", {
        snapshotId: "pooled",
        sql: "COMMIT",
        current: true,
      });
      assertEquals(
        await client.request("snapshot-query", {
          snapshotId: "pooled",
          sql: "SELECT 43 AS value",
        }),
        { rows: [{ value: 43 }] },
      );
      await client.request("snapshot-close", { snapshotId: "pooled" });
      await client.whenIdle();
      assertEquals(
        await client.request("query", { sql: "SELECT 44 AS value" }),
        { rows: [{ value: 44 }] },
      );
    } finally {
      await client.close();
    }
  },
});
Deno.test({
  name:
    "session close releases snapshot pins before draining an ordinary checkout",
  ignore: !pgUrl,
  async fn() {
    const { client } = await session(pgUrl!);
    try {
      await client.request("snapshot-open", {
        snapshotId: "close-with-waiter",
      });
      await assertRejects(
        () => client.request("query", { sql: "SELECT 1" }, 40),
        Error,
        "timed out",
      );
      await client.close();
    } finally {
      await client.close();
    }
  },
});

async function rawSession(
  dependencies: import("../src/worker/engine.ts").OminipgEngineDependencies,
) {
  const { encodeSessionFrame, decodeSessionFrames } = await import(
    "../src/session/codec.ts"
  );
  const { sessionRequest, OMINIPG_SESSION_WORKLOAD } = await import(
    "../src/session/protocol.ts"
  );
  type Response = import("../src/session/protocol.ts").OminipgSessionResponse;
  const embedded = await createEmbeddedOminipgSession(dependencies);
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const writer = input.writable.getWriter();
  const handle = await embedded.transport.dispatcher.dispatch({
    workload: OMINIPG_SESSION_WORKLOAD,
    body: input.readable,
  });
  await handle.started;
  await handle.metadata;
  let id = 0;
  const pending = new Map<
    number,
    { resolve(value: Response): void; reject(error: unknown): void }
  >();
  const reading = (async () => {
    try {
      for await (const raw of decodeSessionFrames(handle.output)) {
        const frame = raw as Response;
        if (frame.kind !== "response") continue;
        pending.get(frame.id)?.resolve(frame);
        pending.delete(frame.id);
      }
    } finally {
      for (const entry of pending.values()) {
        entry.reject(new Error("Session ended"));
      }
      pending.clear();
    }
  })();
  void reading.catch(() => {});
  return {
    write(
      operation: import("../src/session/protocol.ts").OminipgSessionOperation,
      payload?: unknown,
    ) {
      const next = ++id;
      let reject!: (error: unknown) => void;
      const reply = new Promise<Response>((resolve, no) => {
        reject = no;
        pending.set(next, { resolve, reject: no });
      });
      void reply.catch(() => {});
      const written = writer.write(
        encodeSessionFrame(sessionRequest(next, operation, payload)),
      );
      void written.catch(reject);
      return { written, reply };
    },
    eof: () => writer.close(),
    async finish() {
      await reading;
      await handle.completed;
      await embedded.close();
    },
    async abort() {
      await handle.cancel("test_cleanup").catch(() => {});
      await embedded.close();
      await reading.catch(() => {});
    },
  };
}
async function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Bounded snapshot progress deadline")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
Deno.test({
  name:
    "input EOF releases snapshot pins before pending ordinary checkout drain",
  ignore: !pgUrl,
  async fn() {
    const raw = await rawSession({ pgProvider: createPgProvider() });
    try {
      assertEquals(
        (await raw.write("initialize", { url: pgUrl!, pgPoolMax: 2 }).reply).ok,
        true,
      );
      assertEquals(
        (await raw.write("snapshot-open", { snapshotId: "eof" }).reply).ok,
        true,
      );
      const waiting = raw.write("query", { sql: "SELECT 42 AS value" });
      await waiting.written;
      await raw.eof();
      const response = await deadline(waiting.reply);
      assertEquals(response.ok, true);
      await deadline(raw.finish());
    } finally {
      await raw.abort();
    }
  },
});
Deno.test("graceful session close drains already-accepted ordinary transaction lanes", async () => {
  type Client = import("../src/shared/types.ts").PgPoolClient;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const statements: string[] = [];
  class Pool {
    connect() {
      const value = {
        async query(sql: string) {
          statements.push(sql);
          if (sql === "SELECT held") {
            enter();
            await held;
          }
          return { rows: [] };
        },
        release() {},
        on: () => value,
        removeListener: () => value,
      };
      return Promise.resolve(value as Client);
    }
    end() {
      return Promise.resolve();
    }
  }
  const raw = await rawSession({
    pgProvider: { loadPg: () => Promise.resolve({ Pool }) },
  });
  try {
    assertEquals(
      (await raw.write("initialize", { url: "postgres://fixture/fixture" })
        .reply).ok,
      true,
    );
    assertEquals(
      (await raw.write("query", { sql: "BEGIN", transaction: "ordinary" })
        .reply).ok,
      true,
    );
    const first = raw.write("query", {
      sql: "SELECT held",
      transaction: "ordinary",
    });
    await entered;
    const update = raw.write("query", {
      sql: "UPDATE admitted",
      transaction: "ordinary",
    });
    const commit = raw.write("query", {
      sql: "COMMIT",
      transaction: "ordinary",
    });
    await Promise.all([update.written, commit.written]);
    const closing = raw.write("close");
    await closing.written;
    release();
    for (const pending of [first, update, commit, closing]) {
      assertEquals((await deadline(pending.reply)).ok, true);
    }
    assertEquals(statements.includes("UPDATE admitted"), true);
    assertEquals(statements.includes("COMMIT"), true);
    assertEquals(statements.includes("ROLLBACK"), false);
    await deadline(raw.finish());
  } finally {
    release();
    await raw.abort();
  }
});
Deno.test({
  name: "snapshot and ordinary transaction scheduling domains cannot collide",
  ignore: !pgUrl,
  async fn() {
    const { client } = await session(pgUrl!);
    try {
      await client.request("snapshot-open", { snapshotId: "collision" });
      await assertRejects(
        () =>
          client.request("query", {
            sql: "BEGIN",
            transaction: "snapshot:collision:current",
          }, 40),
        Error,
        "timed out",
      );
      assertEquals(
        await deadline(
          client.request("snapshot-query", {
            snapshotId: "collision",
            current: true,
            sql: "SELECT 42 AS value",
          }),
        ),
        { rows: [{ value: 42 }] },
      );
      await client.request("snapshot-close", { snapshotId: "collision" });
      await client.request("query", {
        sql: "ROLLBACK",
        transaction: "snapshot:collision:current",
      });
    } finally {
      await client.close();
    }
  },
});
