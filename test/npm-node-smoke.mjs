import { rm } from "node:fs/promises";
import { strict as assert } from "node:assert";
import { defineSchema, Ominipg } from "@oxian/ominipg";
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

async function smokeMemoryWorker() {
  const db = await Ominipg.connect({
    url: ":memory:",
    schemaSQL,
    pgliteProvider,
    useWorker: true,
  });
  try {
    const ping = await db.query("SELECT 1 AS ok");
    assert.equal(ping.rows[0].ok, 1);
  } finally {
    await db.close();
  }
}

async function smokeMemoryInProcess() {
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

async function smokeFileWorker() {
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
  } finally {
    await db.query(`DROP TABLE IF EXISTS ${table}`);
    await db.close();
  }
}

await smokeMemoryWorker();
await smokeMemoryInProcess();
await smokeFileWorker();
await smokeDirectPostgres();
console.log("npm Node smoke tests passed");
