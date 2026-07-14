import { assertEquals } from "jsr:@std/assert@1.0.13";
import { join } from "jsr:@std/path@1.1.2";

const repoRoot = join(import.meta.dirname!, "..");

Deno.test({
  name: "packed package preserves read-only schema inference for consumers",
  sanitizeExit: false,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "ominipg-packed-types-" });
    try {
      const archive = join(tempDir, "ominipg.tgz");
      const denoDir = join(tempDir, "deno-cache");
      await run(
        [
          Deno.execPath(),
          "pack",
          "--allow-dirty",
          "--output",
          archive,
        ],
        repoRoot,
        { DENO_DIR: denoDir },
      );

      await Deno.writeTextFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: { "@oxian/ominipg": `file:${archive}` },
        }),
      );
      await Deno.writeTextFile(
        join(tempDir, "deno.json"),
        JSON.stringify({ nodeModulesDir: "manual" }),
      );
      await Deno.writeTextFile(
        join(tempDir, "main.ts"),
        `import { defineSchema } from "npm:@oxian/ominipg";

const schema = defineSchema({
  rows: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", readOnly: true },
        namespace: { type: ["string", "null"] },
        data: { type: ["object", "null"] },
      },
      required: ["id", "namespace"],
    },
    keys: [{ property: "id" }],
    defaults: { id: () => "id" },
  },
} as const);

type Row = typeof schema.rows.$inferSelect;
type Insert = typeof schema.rows.$inferInsert;

const input: Insert = {
  namespace: "tenant",
  data: { metadata: true },
};
declare const row: Row;
const metadata = row.data?.metadata;
console.log(input, row.id, metadata);
`,
      );

      await run(
        [
          "npm",
          "install",
          "--ignore-scripts",
          "--cache",
          join(tempDir, "npm-cache"),
        ],
        tempDir,
      );
      await run(
        [Deno.execPath(), "check", "main.ts"],
        tempDir,
        { DENO_DIR: denoDir },
      );
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

async function run(
  command: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  const result = await new Deno.Command(command[0], {
    args: command.slice(1),
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(
    result.success,
    true,
    `${command.join(" ")} failed\n${new TextDecoder().decode(result.stdout)}\n${
      new TextDecoder().decode(result.stderr)
    }`,
  );
}
