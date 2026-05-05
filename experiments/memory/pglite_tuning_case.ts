type MemoryUsage = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
};

type TuningSample = {
  runtime: "deno";
  variant: string;
  label: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
};

type PGliteConstructor = {
  new (
    dataDir?: string,
    options?: {
      initialMemory?: number;
      startParams?: string[];
      relaxedDurability?: boolean;
    },
  ): {
    query(sql: string, params?: unknown[]): Promise<unknown>;
    close(): Promise<void>;
  };
  defaultStartParams: string[];
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

async function sample(variant: string, label: string): Promise<TuningSample> {
  await maybeCollectGarbage();
  await delay(25);
  const usage = Deno.memoryUsage() as MemoryUsage;
  return {
    runtime: "deno",
    variant,
    label,
    rssMb: bytesToMb(usage.rss),
    heapUsedMb: bytesToMb(usage.heapUsed),
    heapTotalMb: bytesToMb(usage.heapTotal),
    externalMb: bytesToMb(usage.external),
  };
}

function argValue(name: string, fallback: string): string {
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] ?? fallback : fallback;
}

function print(value: unknown) {
  console.log(JSON.stringify(value));
}

function withParams(PGlite: PGliteConstructor, params: string[]) {
  return [...PGlite.defaultStartParams, ...params];
}

function optionsForVariant(PGlite: PGliteConstructor, variant: string) {
  switch (variant) {
    case "default":
      return undefined;
    case "buffers-8mb":
      return {
        startParams: withParams(PGlite, [
          "-c",
          "shared_buffers=8MB",
          "-c",
          "temp_buffers=1MB",
        ]),
      };
    case "buffers-4mb":
      return {
        startParams: withParams(PGlite, [
          "-c",
          "shared_buffers=4MB",
          "-c",
          "temp_buffers=800kB",
        ]),
      };
    case "buffers-1mb":
      return {
        startParams: withParams(PGlite, [
          "-c",
          "shared_buffers=1MB",
          "-c",
          "temp_buffers=800kB",
        ]),
      };
    case "buffers-min":
      return {
        startParams: withParams(PGlite, [
          "-c",
          "shared_buffers=128kB",
          "-c",
          "temp_buffers=800kB",
        ]),
      };
    case "minimal":
      return {
        relaxedDurability: true,
        startParams: withParams(PGlite, [
          "-c",
          "shared_buffers=128kB",
          "-c",
          "temp_buffers=800kB",
          "-c",
          "work_mem=64kB",
          "-c",
          "maintenance_work_mem=1MB",
          "-c",
          "effective_cache_size=1MB",
          "-c",
          "max_locks_per_transaction=10",
        ]),
      };
    case "minimal-initial-64mb":
      return {
        initialMemory: 64 * 1024 * 1024,
        relaxedDurability: true,
        startParams: withParams(PGlite, [
          "-c",
          "shared_buffers=128kB",
          "-c",
          "temp_buffers=800kB",
          "-c",
          "work_mem=64kB",
          "-c",
          "maintenance_work_mem=1MB",
          "-c",
          "effective_cache_size=1MB",
          "-c",
          "max_locks_per_transaction=10",
        ]),
      };
    case "minimal-initial-96mb":
      return {
        initialMemory: 96 * 1024 * 1024,
        relaxedDurability: true,
        startParams: withParams(PGlite, [
          "-c",
          "shared_buffers=128kB",
          "-c",
          "temp_buffers=800kB",
          "-c",
          "work_mem=64kB",
          "-c",
          "maintenance_work_mem=1MB",
          "-c",
          "effective_cache_size=1MB",
          "-c",
          "max_locks_per_transaction=10",
        ]),
      };
    case "minimal-connections":
      return {
        relaxedDurability: true,
        startParams: withParams(PGlite, [
          "-c",
          "shared_buffers=128kB",
          "-c",
          "temp_buffers=800kB",
          "-c",
          "work_mem=64kB",
          "-c",
          "maintenance_work_mem=1MB",
          "-c",
          "effective_cache_size=1MB",
          "-c",
          "max_connections=1",
          "-c",
          "superuser_reserved_connections=0",
          "-c",
          "max_locks_per_transaction=10",
          "-c",
          "max_pred_locks_per_transaction=10",
          "-c",
          "max_pred_locks_per_relation=10",
          "-c",
          "max_pred_locks_per_page=1",
          "-c",
          "max_wal_senders=0",
          "-c",
          "max_replication_slots=0",
        ]),
      };
    case "minimal-temp-100kb":
      return {
        relaxedDurability: true,
        startParams: withParams(PGlite, [
          "-c",
          "shared_buffers=128kB",
          "-c",
          "temp_buffers=100kB",
          "-c",
          "work_mem=64kB",
          "-c",
          "maintenance_work_mem=1MB",
          "-c",
          "effective_cache_size=1MB",
          "-c",
          "max_locks_per_transaction=10",
        ]),
      };
    case "minimal-wal":
      return {
        relaxedDurability: true,
        startParams: withParams(PGlite, [
          "-c",
          "shared_buffers=128kB",
          "-c",
          "temp_buffers=800kB",
          "-c",
          "work_mem=64kB",
          "-c",
          "maintenance_work_mem=1MB",
          "-c",
          "effective_cache_size=1MB",
          "-c",
          "max_locks_per_transaction=10",
          "-c",
          "wal_buffers=32kB",
          "-c",
          "min_wal_size=2MB",
          "-c",
          "max_wal_size=4MB",
        ]),
      };
    case "minimal-stats-off":
      return {
        relaxedDurability: true,
        startParams: withParams(PGlite, [
          "-c",
          "shared_buffers=128kB",
          "-c",
          "temp_buffers=800kB",
          "-c",
          "work_mem=64kB",
          "-c",
          "maintenance_work_mem=1MB",
          "-c",
          "effective_cache_size=1MB",
          "-c",
          "max_locks_per_transaction=10",
          "-c",
          "wal_buffers=32kB",
          "-c",
          "min_wal_size=2MB",
          "-c",
          "max_wal_size=4MB",
          "-c",
          "track_activities=off",
          "-c",
          "track_counts=off",
          "-c",
          "autovacuum=off",
        ]),
      };
    default:
      throw new Error(`Unknown variant: ${variant}`);
  }
}

const phase = argValue("--phase", "measure");
const variant = argValue("--variant", "default");
const dbUrl = argValue("--db-url", "");
const rows = Number(argValue("--rows", "100"));

if (!dbUrl) {
  throw new Error("--db-url is required");
}
if (!Number.isInteger(rows) || rows < 0) {
  throw new Error(`--rows must be a non-negative integer, got ${rows}`);
}

const { PGlite } = await import("npm:@electric-sql/pglite@0.4.5") as {
  PGlite: PGliteConstructor;
};
const options = optionsForVariant(PGlite, variant);

if (phase === "prepare") {
  const db = options ? new PGlite(dbUrl, options) : new PGlite(dbUrl);
  try {
    await db.query(
      "CREATE TABLE IF NOT EXISTS memory_items(id INT PRIMARY KEY, value TEXT)",
    );
    for (let id = 0; id < rows; id++) {
      await db.query(
        "INSERT INTO memory_items(id, value) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [id, `value-${id}`],
      );
    }
  } finally {
    await db.close();
  }
} else if (phase === "measure") {
  print(await sample(variant, "startup"));
  const db = options ? new PGlite(dbUrl, options) : new PGlite(dbUrl);
  try {
    await db.query("SELECT count(*) AS count FROM memory_items");
    print(await sample(variant, "after open/query"));
  } finally {
    await db.close();
  }
  print(await sample(variant, "after close"));
} else {
  throw new Error(`Unknown --phase: ${phase}`);
}
