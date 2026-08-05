import { build, emptyDir } from "@deno/dnt";

const denoJson = JSON.parse(await Deno.readTextFile("./deno.json")) as {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  repository?: { type?: string; url?: string };
};

const outDir = Deno.env.get("OMINIPG_NPM_OUT_DIR") ?? "./npm";
const version = Deno.args[0]?.replace(/^v/, "") || denoJson.version ||
  "0.0.0";
const repository = denoJson.repository?.type && denoJson.repository.url
  ? {
    type: denoJson.repository.type,
    url: denoJson.repository.url,
  }
  : undefined;

await emptyDir(outDir);

await build({
  entryPoints: [
    { name: ".", path: "./src/client/index.ts" },
    { name: "./auto", path: "./src/auto.ts" },
    { name: "./crud", path: "./src/client/crud/index.ts" },
    { name: "./pglite", path: "./src/providers/pglite.ts" },
    { name: "./pg", path: "./src/providers/pg.ts" },
    { name: "./worker", path: "./src/worker/index.ts" },
    { name: "./workload", path: "./src/session/workload.ts" },
    { name: "./session", path: "./src/session/index.ts" },
  ],
  outDir,
  scriptModule: false,
  declaration: "separate",
  typeCheck: false,
  skipSourceOutput: true,
  test: false,
  shims: {},
  mappings: {
    "./src/auto.ts": "./src/auto.node.ts",
    "./src/providers/pglite.ts": "./src/providers/pglite.node.ts",
    "./src/providers/pg.ts": "./src/providers/pg.node.ts",
  },
  compilerOptions: {
    target: "ES2022",
    lib: ["ES2022", "DOM"],
  },
  package: {
    name: denoJson.name ?? "@oxian/ominipg",
    version,
    description: denoJson.description,
    license: denoJson.license,
    repository,
    type: "module",
    engines: {
      node: ">=22",
    },
    sideEffects: false,
    peerDependencies: {
      "@electric-sql/pglite": "^0.4.5",
      "pg": "^8.16.3",
      "pg-logical-replication": "^2.4.0",
    },
    peerDependenciesMeta: {
      "@electric-sql/pglite": { optional: true },
      "pg": { optional: true },
      "pg-logical-replication": { optional: true },
    },
    devDependencies: {
      "@types/node": "^22.0.0",
      "@types/pg": "^8.11.0",
    },
  },
  async postBuild() {
    await Deno.copyFile("README.md", `${outDir}/README.md`);
    await Deno.copyFile("LICENSE", `${outDir}/LICENSE`);
    await Deno.mkdir(`${outDir}/assets`, { recursive: true });
    await Deno.copyFile(
      "assets/logo_color.png",
      `${outDir}/assets/logo_color.png`,
    );

    const packageJsonPath = `${outDir}/package.json`;
    const packageJson = JSON.parse(
      await Deno.readTextFile(packageJsonPath),
    ) as {
      dependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
    };
    delete packageJson.dependencies?.["@electric-sql/pglite"];
    delete packageJson.dependencies?.["pg"];
    delete packageJson.dependencies?.["pg-logical-replication"];
    await Deno.writeTextFile(
      packageJsonPath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
  },
});
