type TuningSample = {
  runtime: "deno";
  variant: string;
  label: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
};

type TuningResult = {
  variant: string;
  samples: TuningSample[];
  error?: string;
};

const defaultVariants = [
  "default",
  "buffers-8mb",
  "buffers-4mb",
  "buffers-1mb",
  "buffers-min",
  "minimal",
  "minimal-connections",
];

function argValue(name: string, fallback: string): string {
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] ?? fallback : fallback;
}

function listArg(name: string, fallback: string[]): string[] {
  return argValue(name, fallback.join(",")).split(",").map((item) =>
    item.trim()
  ).filter(Boolean);
}

function format(value: number): string {
  return `${value.toFixed(2)} MB`;
}

function delta(current: number, baseline: number): string {
  const value = Math.round((current - baseline) * 100) / 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} MB`;
}

async function runCase(args: string[]) {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--v8-flags=--expose-gc",
      "experiments/memory/pglite_tuning_case.ts",
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  return await command.output();
}

async function prepareDb(dbUrl: string, rows: string) {
  const output = await runCase([
    "--phase",
    "prepare",
    "--variant",
    "default",
    "--db-url",
    dbUrl,
    "--rows",
    rows,
  ]);
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(`prepare failed with code ${output.code}\n${stderr}`);
  }
}

async function measureVariant(
  variant: string,
  dbUrl: string,
  rows: string,
): Promise<TuningResult> {
  const output = await runCase([
    "--phase",
    "measure",
    "--variant",
    variant,
    "--db-url",
    dbUrl,
    "--rows",
    rows,
  ]);
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  const samples = stdout.trim().split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as TuningSample
  );
  return {
    variant,
    samples,
    error: output.success
      ? undefined
      : `${variant} failed with code ${output.code}\n${stderr}`,
  };
}

const rows = argValue("--rows", "100");
const variants = listArg("--variants", defaultVariants);
const dbPath = await Deno.makeTempDir({ prefix: "raw-pglite-tuning-" });
const dbUrl = `file://${dbPath}`;
const results: TuningResult[] = [];

try {
  await prepareDb(dbUrl, rows);
  for (const variant of variants) {
    results.push(await measureVariant(variant, dbUrl, rows));
  }
} finally {
  await Deno.remove(dbPath, { recursive: true }).catch(() => undefined);
}

console.log(JSON.stringify(
  {
    runtime: "deno",
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    rows: Number(rows),
    dbUrl,
    results,
  },
  null,
  2,
));

console.log("\nPGlite Tuning Summary");
console.log("=====================");
for (const result of results) {
  const baseline = result.samples[0]?.rssMb ?? 0;
  const afterOpen = result.samples.find((sample) =>
    sample.label === "after open/query"
  );
  const afterClose = result.samples.find((sample) =>
    sample.label === "after close"
  );
  console.log(`\n${result.variant}`);
  if (result.error) {
    console.log(`  failed: ${result.error.split("\n")[0]}`);
    continue;
  }
  if (afterOpen) {
    console.log(
      `  after open:  ${format(afterOpen.rssMb)} (${
        delta(afterOpen.rssMb, baseline)
      }), external=${format(afterOpen.externalMb)}`,
    );
  }
  if (afterClose) {
    console.log(
      `  after close: ${format(afterClose.rssMb)} (${
        delta(afterClose.rssMb, baseline)
      }), external=${format(afterClose.externalMb)}`,
    );
  }
}
