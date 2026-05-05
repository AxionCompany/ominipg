type PrepopulateSample = {
  runtime: "deno";
  variant: string;
  label: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
};

type PrepopulateResult = {
  variant: string;
  samples: PrepopulateSample[];
  error?: string;
};

const defaultVariants = [
  "fresh-memory",
  "fresh-memory-minimal",
  "load-dump",
  "load-dump-minimal",
  "official-prepopulatedfs",
  "official-prepopulatedfs-minimal",
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
      "experiments/memory/pglite_prepopulate_case.ts",
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  return await command.output();
}

async function prepareDump(dumpFile: string, rows: string) {
  const output = await runCase([
    "--phase",
    "prepare-dump",
    "--dump-file",
    dumpFile,
    "--rows",
    rows,
  ]);
  if (!output.success) {
    throw new Error(
      `prepare-dump failed with code ${output.code}\n${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  }
}

async function measureVariant(
  variant: string,
  dumpFile: string,
  rows: string,
): Promise<PrepopulateResult> {
  const output = await runCase([
    "--phase",
    "measure",
    "--variant",
    variant,
    "--dump-file",
    dumpFile,
    "--rows",
    rows,
  ]);
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  const samples = stdout.trim().split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as PrepopulateSample
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
const dumpFile = await Deno.makeTempFile({
  prefix: "raw-pglite-datadir-",
  suffix: ".tgz",
});
const results: PrepopulateResult[] = [];

try {
  await prepareDump(dumpFile, rows);
  for (const variant of variants) {
    results.push(await measureVariant(variant, dumpFile, rows));
  }
} finally {
  await Deno.remove(dumpFile).catch(() => undefined);
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

console.log("\nPGlite Prepopulate Summary");
console.log("==========================");
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
