import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { createHypervisor } from "@oxian/oxian-js/hypervisor";
import { createWorker } from "@oxian/oxian-js/worker";
import {
  createOminipgWorkload,
  Ominipg,
  OMINIPG_SESSION_WORKLOAD,
} from "../src/client/index.ts";
import { createPGliteProvider } from "../src/providers/pglite.ts";
import {
  decodeSessionFrames,
  encodeSessionFrame,
} from "../src/session/codec.ts";

function delayedPGliteProvider(delayMs: number) {
  return {
    loadPGlite: () =>
      Promise.resolve({
        PGlite: class {
          async query() {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return { rows: [{ value: "delayed" }] };
          }

          exec() {
            return Promise.resolve();
          }

          listen() {
            return Promise.resolve();
          }

          close() {
            return Promise.resolve();
          }
        },
      }),
  };
}

Deno.test("session codec preserves database value types across arbitrary chunks", async () => {
  const original = {
    bigint: 9007199254740993n,
    bytes: new Uint8Array([0, 1, 127, 255]),
    date: new Date("2026-08-04T12:00:00.000Z"),
    values: [undefined, NaN, Infinity, -Infinity, -0],
  };
  const encoded = encodeSessionFrame(original);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < encoded.length; index += 3) {
        controller.enqueue(encoded.slice(index, index + 3));
      }
      controller.close();
    },
  });
  const decoded = [];
  for await (const value of decodeSessionFrames(stream)) decoded.push(value);
  const result = decoded[0] as typeof original;
  assertEquals(result.bigint, original.bigint);
  assertEquals(result.bytes, original.bytes);
  assertInstanceOf(result.date, Date);
  assertEquals(result.date.toISOString(), original.date.toISOString());
  assertEquals(result.values.slice(0, 4), original.values.slice(0, 4));
  assertEquals(Object.is(result.values[4], -0), true);
});

Deno.test("session codec rejects process-local objects", () => {
  class ProcessLocalValue {}
  assertThrows(
    () => encodeSessionFrame(new ProcessLocalValue()),
    TypeError,
    "cannot encode ProcessLocalValue",
  );
});

Deno.test("session codec carries large binary values without base64 expansion", async () => {
  const bytes = new Uint8Array(1024 * 1024);
  bytes[0] = 17;
  bytes[bytes.length - 1] = 29;
  const encoded = encodeSessionFrame({ bytes });
  assertEquals(encoded.byteLength < bytes.byteLength + 256, true);
  const chunks = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < encoded.length; index += 7919) {
        controller.enqueue(encoded.slice(index, index + 7919));
      }
      controller.close();
    },
  });
  for await (const decoded of decodeSessionFrames(chunks)) {
    assertEquals((decoded as { bytes: Uint8Array }).bytes, bytes);
  }
});

Deno.test("Oxian sessions stream query frames larger than one protocol chunk", async () => {
  const db = await Ominipg.connect({
    url: ":memory:",
    schemaSQL: [
      "CREATE TABLE large_values(id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    ],
    pgliteProvider: createPGliteProvider(),
  });
  const value = `start:${"x".repeat(2 * 1024 * 1024)}:end`;
  try {
    await db.query(
      "INSERT INTO large_values(id, value) VALUES ($1, $2)",
      ["large", value],
    );
    assertEquals(
      (await db.query("SELECT value FROM large_values WHERE id = $1", [
        "large",
      ])).rows,
      [{ value }],
    );
  } finally {
    await db.close();
  }
});

Deno.test("session request timeout is configurable for long queries", async () => {
  const db = await Ominipg.connect({
    url: ":memory:",
    pgliteProvider: delayedPGliteProvider(40),
    requestTimeoutMs: 1_000,
  });
  try {
    assertEquals((await db.query("SELECT delayed")).rows, [
      { value: "delayed" },
    ]);
  } finally {
    await db.close();
  }

  const expiring = await Ominipg.connect({
    url: ":memory:",
    pgliteProvider: delayedPGliteProvider(40),
    requestTimeoutMs: 10,
  });
  try {
    await assertRejects(
      () => expiring.query("SELECT delayed"),
      Error,
      "request timed out after 10ms",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await expiring.close();
  }
});

Deno.test("a timed-out request drains before the session accepts another", async () => {
  const completed: string[] = [];
  const db = await Ominipg.connect({
    url: ":memory:",
    requestTimeoutMs: 10,
    pgliteProvider: {
      loadPGlite: () =>
        Promise.resolve({
          PGlite: class {
            async query(sql: string) {
              if (sql === "SELECT slow") {
                await new Promise((resolve) => setTimeout(resolve, 40));
                completed.push("slow");
              } else if (sql === "SELECT fast") {
                completed.push("fast");
              }
              return { rows: [{ sql }] };
            }
            exec() {
              return Promise.resolve();
            }
            listen() {
              return Promise.resolve();
            }
            close() {
              return Promise.resolve();
            }
          },
        }),
    },
  });
  try {
    await assertRejects(
      () => db.query("SELECT slow"),
      Error,
      "session will drain it before accepting more work",
    );
    assertEquals((await db.query("SELECT fast")).rows, [
      { sql: "SELECT fast" },
    ]);
    assertEquals(completed, ["slow", "fast"]);
  } finally {
    await db.close();
  }
});

Deno.test("concurrent callers start request deadlines when each request begins", async () => {
  const completed: string[] = [];
  const db = await Ominipg.connect({
    url: ":memory:",
    requestTimeoutMs: 30,
    pgliteProvider: {
      loadPGlite: () =>
        Promise.resolve({
          PGlite: class {
            async query(sql: string) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              completed.push(sql);
              return { rows: [{ sql }] };
            }
            exec() {
              return Promise.resolve();
            }
            listen() {
              return Promise.resolve();
            }
            close() {
              return Promise.resolve();
            }
          },
        }),
    },
  });
  try {
    const [first, second] = await Promise.all([
      db.query("SELECT first"),
      db.query("SELECT second"),
    ]);
    assertEquals(first.rows, [{ sql: "SELECT first" }]);
    assertEquals(second.rows, [{ sql: "SELECT second" }]);
    assertEquals(completed, ["SELECT first", "SELECT second"]);
  } finally {
    await db.close();
  }
});

Deno.test("a timed-out transaction drains before rollback and later work", async () => {
  const operations: string[] = [];
  const db = await Ominipg.connect({
    url: ":memory:",
    requestTimeoutMs: 10,
    pgliteProvider: {
      loadPGlite: () =>
        Promise.resolve({
          PGlite: class {
            async query(sql: string) {
              operations.push(sql);
              if (sql === "SELECT slow") {
                await new Promise((resolve) => setTimeout(resolve, 40));
              }
              return { rows: [] };
            }
            exec() {
              return Promise.resolve();
            }
            listen() {
              return Promise.resolve();
            }
            close() {
              return Promise.resolve();
            }
          },
        }),
    },
  });
  try {
    await assertRejects(
      () => db.transaction((transaction) => transaction.query("SELECT slow")),
      Error,
      "session will drain it before accepting more work",
    );
    await db.query("SELECT after");
    assertEquals(operations, [
      "BEGIN",
      "SELECT slow",
      "ROLLBACK",
      "SELECT after",
    ]);
  } finally {
    await db.close();
  }
});

Deno.test("session request timeout must be a positive safe integer", async () => {
  await assertRejects(
    () =>
      Ominipg.connect({
        url: ":memory:",
        pgliteProvider: delayedPGliteProvider(0),
        requestTimeoutMs: 0,
      }),
    TypeError,
    "requestTimeoutMs must be a positive safe integer",
  );
  await assertRejects(
    () =>
      Ominipg.connect({
        url: ":memory:",
        pgliteProvider: delayedPGliteProvider(0),
        requestTimeoutMs: 100,
        statementTimeoutMs: 100,
      }),
    TypeError,
    "statementTimeoutMs must be shorter than requestTimeoutMs",
  );
});

Deno.test("private embedded Oxian sessions own independent engines", async () => {
  const provider = createPGliteProvider();
  const schemaSQL = [
    "CREATE TABLE items(id TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ];
  const [first, second] = await Promise.all([
    Ominipg.connect({ url: ":memory:", schemaSQL, pgliteProvider: provider }),
    Ominipg.connect({ url: ":memory:", schemaSQL, pgliteProvider: provider }),
  ]);
  try {
    await first.query("INSERT INTO items(id, value) VALUES ($1, $2)", [
      "1",
      "first",
    ]);
    await second.query("INSERT INTO items(id, value) VALUES ($1, $2)", [
      "2",
      "second",
    ]);
    assertEquals(
      (await first.query("SELECT value FROM items ORDER BY id")).rows,
      [{ value: "first" }],
    );
    assertEquals(
      (await second.query("SELECT value FROM items ORDER BY id")).rows,
      [{ value: "second" }],
    );
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

Deno.test("transactions commit or roll back inside one Oxian session", async () => {
  const db = await Ominipg.connect({
    url: ":memory:",
    schemaSQL: [
      "CREATE TABLE entries(id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    ],
    pgliteProvider: createPGliteProvider(),
  });
  try {
    const committed = await db.transaction(async (transaction) => {
      await transaction.query(
        "INSERT INTO entries(id, value) VALUES ($1, $2)",
        ["committed", "yes"],
      );
      return 42;
    });
    assertEquals(committed, 42);

    await assertRejects(
      () =>
        db.transaction(async (transaction) => {
          await transaction.query(
            "INSERT INTO entries(id, value) VALUES ($1, $2)",
            ["rolled-back", "no"],
          );
          throw new Error("force rollback");
        }),
      Error,
      "force rollback",
    );
    assertEquals(
      (await db.query("SELECT id, value FROM entries ORDER BY id")).rows,
      [{ id: "committed", value: "yes" }],
    );
  } finally {
    await db.close();
  }
});

Deno.test("concurrent queries wait for an active transaction to settle", async () => {
  const db = await Ominipg.connect({
    url: ":memory:",
    schemaSQL: [
      "CREATE TABLE entries(position SERIAL PRIMARY KEY, value TEXT NOT NULL)",
    ],
    pgliteProvider: createPGliteProvider(),
  });
  let releaseTransaction!: () => void;
  const transactionCanFinish = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  let transactionStarted!: () => void;
  const transactionDidStart = new Promise<void>((resolve) => {
    transactionStarted = resolve;
  });

  try {
    const transaction = db.transaction(async (tx) => {
      await tx.query("INSERT INTO entries(value) VALUES ($1)", ["tx-first"]);
      transactionStarted();
      await transactionCanFinish;
      await tx.query("INSERT INTO entries(value) VALUES ($1)", ["tx-second"]);
    });
    await transactionDidStart;

    const outsideQuery = db.query(
      "INSERT INTO entries(value) VALUES ($1)",
      ["outside"],
    );
    releaseTransaction();
    await Promise.all([transaction, outsideQuery]);

    assertEquals(
      (await db.query("SELECT position, value FROM entries ORDER BY position"))
        .rows,
      [
        { position: 1, value: "tx-first" },
        { position: 2, value: "tx-second" },
        { position: 3, value: "outside" },
      ],
    );
  } finally {
    await db.close();
  }
});

Deno.test("concurrent transactions execute in request order", async () => {
  const db = await Ominipg.connect({
    url: ":memory:",
    schemaSQL: [
      "CREATE TABLE entries(position SERIAL PRIMARY KEY, value TEXT NOT NULL)",
    ],
    pgliteProvider: createPGliteProvider(),
  });
  try {
    await Promise.all([
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO entries(value) VALUES ($1)", ["first-a"]);
        await Promise.resolve();
        await tx.query("INSERT INTO entries(value) VALUES ($1)", ["first-b"]);
      }),
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO entries(value) VALUES ($1)", ["second"]);
      }),
    ]);

    assertEquals(
      (await db.query("SELECT value FROM entries ORDER BY position")).rows,
      [{ value: "first-a" }, { value: "first-b" }, { value: "second" }],
    );
  } finally {
    await db.close();
  }
});

Deno.test("one shared Hypervisor carries multiple independent Ominipg sessions", async () => {
  const provider = createPGliteProvider();
  const transportDeclaration = {
    type: "in-process",
    config: { topic: `ominipg-test:${crypto.randomUUID()}` },
  } as const;
  const hypervisor = createHypervisor({
    transports: [transportDeclaration],
  });
  const worker = createWorker({
    id: "ominipg-test-worker",
    transport: transportDeclaration,
    workloads: {
      [OMINIPG_SESSION_WORKLOAD]: createOminipgWorkload({
        dependencies: { pgliteProvider: provider },
      }),
    },
    capacity: 2,
  });
  await worker.ready;
  const transport = { dispatcher: hypervisor };
  const schemaSQL = ["CREATE TABLE identity(value TEXT NOT NULL)"];
  const first = await Ominipg.connect({
    url: ":memory:",
    schemaSQL,
    oxian: transport,
  });
  const second = await Ominipg.connect({
    url: ":memory:",
    schemaSQL,
    oxian: transport,
  });
  try {
    await first.query("INSERT INTO identity(value) VALUES ('first')");
    await second.query("INSERT INTO identity(value) VALUES ('second')");
    assertEquals((await first.query("SELECT value FROM identity")).rows, [
      { value: "first" },
    ]);
    assertEquals((await second.query("SELECT value FROM identity")).rows, [
      { value: "second" },
    ]);

    await first.close();
    assertEquals(hypervisor.snapshot().inProcessWorkers, 1);
    assertEquals((await second.query("SELECT value FROM identity")).rows, [
      { value: "second" },
    ]);
  } finally {
    await Promise.all([first.close(), second.close()]);
    await worker.stop();
    await worker.closed;
    await hypervisor.shutdown();
  }
});
