import { rm } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { defineSchema, Ominipg } from "@oxian/ominipg";
import { autoConfigure } from "@oxian/ominipg/auto";
import { createPGliteProvider } from "@oxian/ominipg/pglite";
import { createPgProvider } from "@oxian/ominipg/pg";

const pgliteProvider = createPGliteProvider();

const schemas = defineSchema({
  users: {
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
      required: ["id", "name"],
    },
    keys: [{ property: "id" }],
  },
});

const schemaSQL = [
  `CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  )`,
];

async function smokeDeprecatedUseWorkerTrue() {
  const db = await Ominipg.connect({
    url: ":memory:",
    schemaSQL,
    pgliteProvider,
    useWorker: true,
  });
  try {
    const ping = await db.query("SELECT 1 AS ok");
    assert.equal(ping.rows[0].ok, 1);
    await smokeTransactions(db);
  } finally {
    await db.close();
  }
}

async function smokeMemorySession() {
  const db = await Ominipg.connect({
    url: ":memory:",
    schemaSQL,
    schemas,
    pgliteProvider,
  });
  try {
    await db.crud.users.create({ id: "1", name: "Ada" });
    const user = await db.crud.users.findOne({ id: "1" });
    assert.equal(user?.name, "Ada");
    const ping = await db.query("SELECT 1 AS ok");
    assert.equal(ping.rows[0].ok, 1);
  } finally {
    await db.close();
  }
}

async function smokeFileSession() {
  const path = `/tmp/ominipg-node-smoke-${process.pid}-${Date.now()}`;
  await rm(path, { recursive: true, force: true });
  const db = await Ominipg.connect({
    url: `file://${path}`,
    schemaSQL,
    pgliteProvider,
  });
  try {
    await db.query("INSERT INTO users(id, name) VALUES ($1, $2)", [
      "2",
      "Grace",
    ]);
    const { rows } = await db.query("SELECT name FROM users WHERE id = $1", [
      "2",
    ]);
    assert.equal(rows[0].name, "Grace");
  } finally {
    await db.close();
    await rm(path, { recursive: true, force: true });
  }
}

async function smokeDeprecatedUseWorkerFalse() {
  const db = await Ominipg.connect(autoConfigure({
    url: ":memory:",
    useWorker: false,
  }));
  try {
    const { rows } = await db.query("SELECT 4 AS auto_value");
    assert.equal(rows[0].auto_value, 4);
  } finally {
    await db.close();
  }
}

async function smokeTransactions(db) {
  const table = `omini_finish_node_${Date.now()}`;
  await db.query(
    `CREATE TABLE ${table} (id INT UNIQUE DEFERRABLE INITIALLY DEFERRED)`,
  );
  try {
    assert.equal(
      await db.transaction(async (tx) => {
        assert.deepEqual(
          (await tx.finish(`INSERT INTO ${table} VALUES (1) RETURNING id`))
            .rows,
          [{ id: 1 }],
        );
        await assert.rejects(
          () => tx.query("SELECT 1"),
          /Ominipg transaction is closed/,
        );
        await assert.rejects(
          () => tx.finish("SELECT 1"),
          /Ominipg transaction is closed/,
        );
        return 42;
      }),
      42,
    );
    await assert.rejects(
      () =>
        db.transaction((tx) => tx.finish(`INSERT INTO ${table} VALUES (1)`)),
      /duplicate key/,
    );
    await assert.rejects(
      () => db.transaction((tx) => tx.finish("SELECT 1 / 0")),
      /division by zero/,
    );
    assert.deepEqual(
      (await db.transaction((tx) =>
        tx.finish(`INSERT INTO ${table} VALUES ($1) RETURNING id`, [2])
      )).rows,
      [{ id: 2 }],
    );
    assert.deepEqual(
      (await db.query(`SELECT id FROM ${table} ORDER BY id`)).rows,
      [{ id: 1 }, { id: 2 }],
    );
  } finally {
    await db.query(`DROP TABLE ${table}`);
  }
  assert.equal(await db.transaction(() => 42), 42);
  await db.transaction(async (tx) => {
    assert.equal(
      (await tx.query("SHOW transaction_isolation")).rows[0]
        .transaction_isolation,
      "repeatable read",
    );
    assert.equal(
      (await tx.query("SHOW transaction_read_only")).rows[0]
        .transaction_read_only,
      "on",
    );
  }, { isolation: "repeatable read", readOnly: true });
  await assert.rejects(
    () =>
      db.transaction(
        (tx) => tx.query("CREATE TABLE forbidden_write (id int)"),
        { readOnly: true },
      ),
    /read-only transaction/,
  );
  await assert.rejects(
    () => db.transaction((tx) => tx.query("SELEC broken")),
    /syntax error/,
  );
  await db.transaction(async (tx) => {
    assert.equal(
      (await tx.query("SELECT $1::int AS value", [7])).rows[0].value,
      7,
    );
  });
}

async function smokeDirectPostgres() {
  const url = process.env.DB_URL_PG;
  if (!url) return;

  const table = `ominipg_node_smoke_${Date.now()}`;
  const db = await Ominipg.connect({
    url,
    pgProvider: createPgProvider(),
    schemaSQL: [`CREATE TABLE IF NOT EXISTS ${table}(id INT PRIMARY KEY)`],
  });
  try {
    await db.query(`INSERT INTO ${table}(id) VALUES ($1)`, [1]);
    const { rows } = await db.query(`SELECT id FROM ${table}`);
    assert.equal(rows[0].id, 1);
    await smokeTransactions(db);
  } finally {
    await db.query(`DROP TABLE IF EXISTS ${table}`);
    await db.close();
  }
}

await smokeDeprecatedUseWorkerTrue();
await smokeMemorySession();
await smokeFileSession();
await smokeDeprecatedUseWorkerFalse();
await smokeDirectPostgres();
console.log("npm Node smoke tests passed");
