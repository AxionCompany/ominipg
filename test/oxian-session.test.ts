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
