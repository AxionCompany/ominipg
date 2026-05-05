type MemoryUsage = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
};

type StorageMode = "memory" | "file";

type MatrixSample = {
  runtime: "deno";
  case: string;
  storage: StorageMode;
  initialMemoryMb: number | null;
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

async function sample(
  caseName: string,
  storage: StorageMode,
  initialMemoryMb: number | null,
  label: string,
): Promise<MatrixSample> {
  await maybeCollectGarbage();
  await delay(25);
  const usage = Deno.memoryUsage() as MemoryUsage;
  return {
    runtime: "deno",
    case: caseName,
    storage,
    initialMemoryMb,
    label,
    rssMb: bytesToMb(usage.rss),
    heapUsedMb: bytesToMb(usage.heapUsed),
    heapTotalMb: bytesToMb(usage.heapTotal),
    externalMb: bytesToMb(usage.external),
  };
}

function print(sample: MatrixSample) {
  console.log(JSON.stringify(sample));
}

function argValue(name: string, fallback: string): string {
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] ?? fallback : fallback;
}

function pgliteConfig(initialMemoryMb: number | null) {
  return initialMemoryMb == null
    ? undefined
    : { initialMemory: initialMemoryMb * 1024 * 1024 };
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

async function tempDbPath(caseName: string, initialMemoryMb: number | null) {
  return await Deno.makeTempDir({
    prefix: `ominipg-memory-${caseName}-${initialMemoryMb ?? "default"}-`,
  });
}

async function runPglite(
  caseName: string,
  storage: StorageMode,
  initialMemoryMb: number | null,
  rows: number,
) {
  print(await sample(caseName, storage, initialMemoryMb, "startup"));
  const { PGlite } = await import("npm:@electric-sql/pglite@0.4.5");
  print(await sample(caseName, storage, initialMemoryMb, "after import"));

  const config = pgliteConfig(initialMemoryMb);
  const path = storage === "file"
    ? await tempDbPath(caseName, initialMemoryMb)
    : undefined;
  try {
    const db = path
      ? config ? new PGlite(path, config) : new PGlite(path)
      : config
      ? new PGlite(config)
      : new PGlite();
    await db.query("SELECT 1 AS ok");
    print(await sample(caseName, storage, initialMemoryMb, "after init query"));
    await insertRows((sql, params) => db.query(sql, params), rows);
    print(
      await sample(caseName, storage, initialMemoryMb, `after ${rows} inserts`),
    );
    await db.close();
    print(await sample(caseName, storage, initialMemoryMb, "after close"));
  } finally {
    if (path) {
      await Deno.remove(path, { recursive: true }).catch(() => undefined);
    }
  }
}

async function runOminipg(
  caseName: string,
  storage: StorageMode,
  initialMemoryMb: number | null,
  rows: number,
  useWorker: boolean,
) {
  print(await sample(caseName, storage, initialMemoryMb, "startup"));
  const [{ Ominipg }, { createPGliteProvider }] = await Promise.all([
    import("../../src/client/index.ts"),
    import("../../src/providers/pglite.ts"),
  ]);
  print(await sample(caseName, storage, initialMemoryMb, "after import"));

  const path = storage === "file"
    ? await tempDbPath(caseName, initialMemoryMb)
    : undefined;
  const url = path ? `file://${path}` : ":memory:";
  try {
    const db = await Ominipg.connect({
      url,
      pgliteProvider: createPGliteProvider(),
      pgliteConfig: pgliteConfig(initialMemoryMb),
      useWorker,
    });
    await db.query("SELECT 1 AS ok");
    print(
      await sample(caseName, storage, initialMemoryMb, "after connect/query"),
    );
    await insertRows((sql, params) => db.query(sql, params), rows);
    print(
      await sample(caseName, storage, initialMemoryMb, `after ${rows} inserts`),
    );
    await db.close();
    print(await sample(caseName, storage, initialMemoryMb, "after close"));
  } finally {
    if (path) {
      await Deno.remove(path, { recursive: true }).catch(() => undefined);
    }
  }
}

const caseName = argValue("--case", "pglite");
const storage = argValue("--storage", "memory") as StorageMode;
const rows = Number(argValue("--rows", "1000"));
const initialMemoryArg = argValue("--initial-memory-mb", "default");
const initialMemoryMb = initialMemoryArg === "default"
  ? null
  : Number(initialMemoryArg);

if (storage !== "memory" && storage !== "file") {
  throw new Error(`--storage must be memory or file, got ${storage}`);
}
if (!Number.isInteger(rows) || rows < 0) {
  throw new Error(`--rows must be a non-negative integer, got ${rows}`);
}
if (
  initialMemoryMb != null &&
  (!Number.isInteger(initialMemoryMb) || initialMemoryMb <= 0)
) {
  throw new Error(
    `--initial-memory-mb must be "default" or a positive integer, got ${initialMemoryArg}`,
  );
}

switch (caseName) {
  case "pglite":
    await runPglite(caseName, storage, initialMemoryMb, rows);
    break;
  case "ominipg-inprocess":
    await runOminipg(caseName, storage, initialMemoryMb, rows, false);
    break;
  case "ominipg-worker":
    await runOminipg(caseName, storage, initialMemoryMb, rows, true);
    break;
  default:
    throw new Error(
      `Unknown --case '${caseName}'. Expected pglite, ominipg-inprocess, or ominipg-worker.`,
    );
}
