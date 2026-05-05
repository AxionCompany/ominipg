type MemorySample = {
  runtime: string;
  case: string;
  label: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
};

const cases = ["pglite", "ominipg-inprocess", "ominipg-worker"] as const;
const rows = Deno.args.includes("--rows")
  ? Deno.args[Deno.args.indexOf("--rows") + 1] ?? "1000"
  : "1000";

function delta(current: number, baseline: number): string {
  const value = Math.round((current - baseline) * 100) / 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)} MB`;
}

function format(value: number): string {
  return `${value.toFixed(2)} MB`;
}

async function runCase(caseName: string): Promise<MemorySample[]> {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--v8-flags=--expose-gc",
      "experiments/memory/deno_compare.ts",
      "--case",
      caseName,
      "--rows",
      rows,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    throw new Error(
      `${caseName} failed with code ${output.code}\n${stdout}\n${stderr}`,
    );
  }
  return stdout.trim().split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as MemorySample
  );
}

const allSamples: MemorySample[] = [];

for (const caseName of cases) {
  allSamples.push(...await runCase(caseName));
}

console.log(JSON.stringify(
  {
    runtime: "deno",
    deno: Deno.version.deno,
    v8: Deno.version.v8,
    rows: Number(rows),
    samples: allSamples,
  },
  null,
  2,
));

console.log("\nSummary");
console.log("=======");
for (const caseName of cases) {
  const samples = allSamples.filter((sample) => sample.case === caseName);
  const baseline = samples[0]?.rssMb ?? 0;
  const afterImport = samples.find((sample) => sample.label === "after import");
  const afterInit = samples.find((sample) =>
    sample.label === "after init query" ||
    sample.label === "after connect/query"
  );
  const afterWork = samples.find((sample) => sample.label.includes("inserts"));
  const afterClose = samples.find((sample) => sample.label === "after close");
  console.log(`\n${caseName}`);
  console.log(`  startup rss: ${format(baseline)}`);
  if (afterImport) {
    console.log(
      `  after import: ${format(afterImport.rssMb)} (${
        delta(afterImport.rssMb, baseline)
      })`,
    );
  }
  if (afterInit) {
    console.log(
      `  after init:   ${format(afterInit.rssMb)} (${
        delta(afterInit.rssMb, baseline)
      })`,
    );
  }
  if (afterWork) {
    console.log(
      `  after work:   ${format(afterWork.rssMb)} (${
        delta(afterWork.rssMb, baseline)
      })`,
    );
  }
  if (afterClose) {
    console.log(
      `  after close:  ${format(afterClose.rssMb)} (${
        delta(afterClose.rssMb, baseline)
      })`,
    );
  }
}
