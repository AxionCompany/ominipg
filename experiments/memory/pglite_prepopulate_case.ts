type MemoryUsage = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
};

type PrepopulateSample = {
  runtime: "deno";
  variant: string;
  label: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
};

type PGliteOptions = {
  loadDataDir?: Blob | File;
  relaxedDurability?: boolean;
  startParams?: string[];
};

type PGliteInstance = {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
  dumpDataDir(compression?: "auto" | "gzip" | "none"): Promise<Blob | File>;
};

type PGliteConstructor = {
  new (options?: PGliteOptions): PGliteInstance;
  create(options?: PGliteOptions): Promise<PGliteInstance>;
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

async function sample(
  variant: string,
  label: string,
): Promise<PrepopulateSample> {
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

function minimalStartParams(PGlite: PGliteConstructor) {
  return [
    ...PGlite.defaultStartParams,
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
  ];
}

async function seedRows(db: PGliteInstance, rows: number) {
  await db.query(
    "CREATE TABLE IF NOT EXISTS memory_items(id INT PRIMARY KEY, value TEXT)",
  );
  for (let id = 0; id < rows; id++) {
    await db.query(
      "INSERT INTO memory_items(id, value) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [id, `value-${id}`],
    );
  }
}

async function loadPreparedDump(dumpFile: string): Promise<Blob> {
  return new Blob([await Deno.readFile(dumpFile)], {
    type: "application/x-gzip",
  });
}

async function loadOfficialPrepopulatedFs(): Promise<Blob | File> {
  const mod = await import("npm:@electric-sql/pglite-prepopulatedfs@0.0.3") as {
    dataDir: () => Promise<Blob | File>;
  };
  return await mod.dataDir();
}

const phase = argValue("--phase", "measure");
const variant = argValue("--variant", "fresh-memory");
const dumpFile = argValue("--dump-file", "");
const rows = Number(argValue("--rows", "100"));

if (!Number.isInteger(rows) || rows < 0) {
  throw new Error(`--rows must be a non-negative integer, got ${rows}`);
}

const { PGlite } = await import("npm:@electric-sql/pglite@0.4.5") as {
  PGlite: PGliteConstructor;
};

if (phase === "prepare-dump") {
  if (!dumpFile) {
    throw new Error("--dump-file is required for --phase prepare-dump");
  }
  const db = await PGlite.create();
  try {
    await seedRows(db, rows);
    const dump = await db.dumpDataDir("gzip");
    await Deno.writeFile(dumpFile, new Uint8Array(await dump.arrayBuffer()));
  } finally {
    await db.close();
  }
} else if (phase === "measure") {
  print(await sample(variant, "startup"));
  const minimalOptions = {
    relaxedDurability: true,
    startParams: minimalStartParams(PGlite),
  };
  const options: PGliteOptions | undefined = variant === "fresh-memory"
    ? undefined
    : variant === "fresh-memory-minimal"
    ? minimalOptions
    : variant === "load-dump"
    ? { loadDataDir: await loadPreparedDump(dumpFile) }
    : variant === "load-dump-minimal"
    ? { ...minimalOptions, loadDataDir: await loadPreparedDump(dumpFile) }
    : variant === "official-prepopulatedfs"
    ? { loadDataDir: await loadOfficialPrepopulatedFs() }
    : variant === "official-prepopulatedfs-minimal"
    ? { ...minimalOptions, loadDataDir: await loadOfficialPrepopulatedFs() }
    : undefined;

  if (options === undefined && variant !== "fresh-memory") {
    throw new Error(`Unknown variant: ${variant}`);
  }
  if (variant.startsWith("load-dump") && !dumpFile) {
    throw new Error("--dump-file is required for load-dump variants");
  }

  const db = options ? await PGlite.create(options) : await PGlite.create();
  try {
    if (
      variant.startsWith("fresh-memory") ||
      variant.startsWith("official-prepopulatedfs")
    ) {
      await seedRows(db, rows);
    }
    await db.query("SELECT count(*) AS count FROM memory_items");
    print(await sample(variant, "after open/query"));
  } finally {
    await db.close();
  }
  print(await sample(variant, "after close"));
} else {
  throw new Error(`Unknown --phase: ${phase}`);
}
