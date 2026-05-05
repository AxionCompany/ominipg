import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bytesToMb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

async function maybeCollectGarbage() {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    await delay(25);
  }
}

async function sample(label) {
  await maybeCollectGarbage();
  await delay(25);
  const usage = process.memoryUsage();
  return {
    runtime: "node",
    node: process.version,
    case: "pglite",
    label,
    rssMb: bytesToMb(usage.rss),
    heapUsedMb: bytesToMb(usage.heapUsed),
    heapTotalMb: bytesToMb(usage.heapTotal),
    externalMb: bytesToMb(usage.external),
    arrayBuffersMb: bytesToMb(usage.arrayBuffers),
  };
}

function print(data) {
  console.log(JSON.stringify(data));
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function resolvePgliteEntry() {
  const packageRoot = process.env.PGLITE_NODE_MODULE_ROOT ??
    new URL("../../npm/", import.meta.url).pathname;
  const requireFromPackage = createRequire(
    new URL("package.json", pathToFileURL(packageRoot + "/")),
  );
  try {
    return requireFromPackage.resolve("@electric-sql/pglite");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") {
      throw error;
    }
    throw new Error(
      `Cannot resolve @electric-sql/pglite from ${packageRoot}. Install it there with ` +
        "`npm install --prefix npm @electric-sql/pglite@0.4.5` or set " +
        "`PGLITE_NODE_MODULE_ROOT` to a package root that has @electric-sql/pglite installed.",
    );
  }
}

async function insertRows(db, rows) {
  await db.query(
    "CREATE TABLE IF NOT EXISTS memory_items(id INT PRIMARY KEY, value TEXT)",
  );
  await db.query("BEGIN");
  try {
    for (let id = 0; id < rows; id++) {
      await db.query("INSERT INTO memory_items(id, value) VALUES ($1, $2)", [
        id,
        `value-${id}`,
      ]);
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
  await db.query("SELECT count(*) AS count FROM memory_items");
}

const rows = Number(argValue("--rows", "1000"));
if (!Number.isInteger(rows) || rows < 0) {
  throw new Error(`--rows must be a non-negative integer, got ${rows}`);
}

print(await sample("startup"));
const entry = resolvePgliteEntry();
const { PGlite } = await import(pathToFileURL(entry).href);
print(await sample("after import"));
const db = new PGlite();
await db.query("SELECT 1 AS ok");
print(await sample("after init query"));
await insertRows(db, rows);
print(await sample(`after ${rows} inserts`));
await db.close();
print(await sample("after close"));
