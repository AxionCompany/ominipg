type MatrixSample = {
  runtime: string;
  case: string;
  storage: "memory" | "file";
  initialMemoryMb: number | null;
  label: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
};

type MatrixResult = {
  case: string;
  storage: "memory" | "file";
  initialMemoryMb: number | null;
  samples: MatrixSample[];
  error?: string;
};

const defaultCases = ["pglite", "ominipg-inprocess", "ominipg-worker"];
const defaultStorage = ["memory", "file"] as const;
const defaultInitialMemory = ["default", "96", "128", "192", "256"];

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

function memoryLabel(initialMemoryMb: number | null): string {
  return initialMemoryMb == null ? "default" : `${initialMemoryMb} MB`;
}

async function runVariant(
  caseName: string,
  storage: "memory" | "file",
  initialMemory: string,
  rows: string,
): Promise<MatrixResult> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--v8-flags=--expose-gc",
      "experiments/memory/deno_matrix_case.ts",
      "--case",
      caseName,
      "--storage",
      storage,
      "--initial-memory-mb",
      initialMemory,
      "--rows",
      rows,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  const samples = stdout.trim().split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as MatrixSample
  );
  const initialMemoryMb = initialMemory === "default"
    ? null
    : Number(initialMemory);
  return {
    case: caseName,
    storage,
    initialMemoryMb,
    samples,
    error: output.success
      ? undefined
      : `${caseName}/${storage}/${initialMemory} failed with code ${output.code}\n${stderr}`,
  };
}

const rows = argValue("--rows", "1000");
const cases = listArg("--cases", defaultCases);
const storageModes = listArg("--storage", [...defaultStorage]) as Array<
  "memory" | "file"
>;
const initialMemoryValues = listArg(
  "--initial-memory-mb",
  defaultInitialMemory,
);
const results: MatrixResult[] = [];

for (const caseName of cases) {
  for (const storage of storageModes) {
    for (const initialMemory of initialMemoryValues) {
      results.push(await runVariant(caseName, storage, initialMemory, rows));
    }
  }
}

console.log(JSON.stringify(
  {
    runtime: "deno",
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    rows: Number(rows),
    results,
  },
  null,
  2,
));

console.log("\nMatrix Summary");
console.log("==============");
for (const result of results) {
  const baseline = result.samples[0]?.rssMb ?? 0;
  const afterInit = result.samples.find((sample) =>
    sample.label === "after init query" ||
    sample.label === "after connect/query"
  );
  const afterWork = result.samples.find((sample) =>
    sample.label.includes("inserts")
  );
  const afterClose = result.samples.find((sample) =>
    sample.label === "after close"
  );
  const title = `${result.case} ${result.storage} initial=${
    memoryLabel(result.initialMemoryMb)
  }`;
  if (result.error) {
    console.log(`\n${title}`);
    console.log(`  failed: ${result.error.split("\n")[0]}`);
    continue;
  }
  console.log(`\n${title}`);
  if (afterInit) {
    console.log(
      `  after init:  ${format(afterInit.rssMb)} (${
        delta(afterInit.rssMb, baseline)
      })`,
    );
  }
  if (afterWork) {
    console.log(
      `  after work:  ${format(afterWork.rssMb)} (${
        delta(afterWork.rssMb, baseline)
      })`,
    );
  }
  if (afterClose) {
    console.log(
      `  after close: ${format(afterClose.rssMb)} (${
        delta(afterClose.rssMb, baseline)
      })`,
    );
  }
}
