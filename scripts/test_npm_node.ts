const packageDir = await Deno.realPath("./npm");
const smokeSource = await Deno.realPath("./test/npm-node-smoke.mjs");
const tempDir = await Deno.makeTempDir({ prefix: "ominipg-node-smoke-" });
const smokeTarget = `${tempDir}/npm-node-smoke.mjs`;

try {
  await Deno.copyFile(smokeSource, smokeTarget);
  const tarballName = await runCapture("npm", [
    "pack",
    packageDir,
    "--pack-destination",
    tempDir,
    "--silent",
  ], tempDir);
  const tarballPath = `${tempDir}/${tarballName.trim().split("\n").at(-1)}`;

  const packages = [
    tarballPath,
    "@electric-sql/pglite@0.4.5",
  ];
  if (Deno.env.get("DB_URL_PG")) {
    packages.push("pg@8.16.3", "pg-logical-replication@2.4.0");
  }

  await run("npm", [
    "install",
    "--no-save",
    "--package-lock=false",
    ...packages,
  ], tempDir);
  await run("node", [smokeTarget], tempDir);
} finally {
  await Deno.remove(tempDir, { recursive: true });
}

async function run(command: string, args: string[], cwd: string) {
  const process = new Deno.Command(command, {
    args,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await process.output();
  if (!status.success) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${status.code}`,
    );
  }
}

async function runCapture(command: string, args: string[], cwd: string) {
  const process = new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "inherit",
  });
  const output = await process.output();
  if (!output.success) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${output.code}`,
    );
  }
  return new TextDecoder().decode(output.stdout);
}
