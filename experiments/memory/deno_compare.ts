type MemoryUsage = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
};

type MemorySample = {
  runtime: "deno";
  case: string;
  label: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bytesToMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

async function maybeCollectGarbage() {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof gc === "function") {
    gc();
    await delay(25);
  }
}

async function sample(caseName: string, label: string): Promise<MemorySample> {
  await maybeCollectGarbage();
  await delay(25);
  const usage = Deno.memoryUsage() as MemoryUsage;
  return {
    runtime: "deno",
    case: caseName,
    label,
    rssMb: bytesToMb(usage.rss),
    heapUsedMb: bytesToMb(usage.heapUsed),
    heapTotalMb: bytesToMb(usage.heapTotal),
    externalMb: bytesToMb(usage.external),
  };
}

function print(sample: MemorySample) {
  console.log(JSON.stringify(sample));
}

function argValue(name: string, fallback: string): string {
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] ?? fallback : fallback;
}

async function insertRows(
  query: (sql: string, params?: unknown[]) => Promise<unknown>,
  rows: number,
) {
  await query(
    "CREATE TABLE IF NOT EXISTS memory_items(id INT PRIMARY KEY, value TEXT)",
  );
  await query("BEGIN");
  try {
    for (let id = 0; id < rows; id++) {
      await query("INSERT INTO memory_items(id, value) VALUES ($1, $2)", [
        id,
        `value-${id}`,
      ]);
    }
    await query("COMMIT");
  } catch (error) {
    await query("ROLLBACK");
    throw error;
  }
  await query("SELECT count(*) AS count FROM memory_items");
}

async function runPglite(caseName: string, rows: number) {
  print(await sample(caseName, "startup"));
  const { PGlite } = await import("npm:@electric-sql/pglite@0.4.5");
  print(await sample(caseName, "after import"));
  const db = new PGlite();
  await db.query("SELECT 1 AS ok");
  print(await sample(caseName, "after init query"));
  await insertRows((sql, params) => db.query(sql, params), rows);
  print(await sample(caseName, `after ${rows} inserts`));
  await db.close();
  print(await sample(caseName, "after close"));
}

async function runOminipg(caseName: string, rows: number, useWorker: boolean) {
  print(await sample(caseName, "startup"));
  const [{ Ominipg }, { createPGliteProvider }] = await Promise.all([
    import("../../src/client/index.ts"),
    import("../../src/providers/pglite.ts"),
  ]);
  print(await sample(caseName, "after import"));
  const db = await Ominipg.connect({
    url: ":memory:",
    pgliteProvider: createPGliteProvider(),
    useWorker,
  });
  await db.query("SELECT 1 AS ok");
  print(await sample(caseName, "after connect/query"));
  await insertRows((sql, params) => db.query(sql, params), rows);
  print(await sample(caseName, `after ${rows} inserts`));
  await db.close();
  print(await sample(caseName, "after close"));
}

const caseName = argValue("--case", "pglite");
const rows = Number(argValue("--rows", "1000"));

if (!Number.isInteger(rows) || rows < 0) {
  throw new Error(`--rows must be a non-negative integer, got ${rows}`);
}

switch (caseName) {
  case "pglite":
    await runPglite(caseName, rows);
    break;
  case "ominipg-inprocess":
    await runOminipg(caseName, rows, false);
    break;
  case "ominipg-worker":
    await runOminipg(caseName, rows, true);
    break;
  default:
    throw new Error(
      `Unknown --case '${caseName}'. Expected pglite, ominipg-inprocess, or ominipg-worker.`,
    );
}
