import { Ominipg } from "../../src/client/index.ts";

const schemaPath = new URL("./agents-schema.sql", import.meta.url);
const schemaText = await Deno.readTextFile(schemaPath);

function splitDDL(script: string): string[] {
  const statements: string[] = [];
  const lines = script.split(/\r?\n/);
  const buffer: string[] = [];
  let inDollarBlock = false;

  for (const line of lines) {
    buffer.push(line);
    const trimmed = line.trim();

    if (!inDollarBlock && trimmed.startsWith("DO ") && trimmed.includes("$$")) {
      inDollarBlock = true;
    }

    if (inDollarBlock && trimmed.endsWith("$$;")) {
      inDollarBlock = false;
      statements.push(buffer.join("\n"));
      buffer.length = 0;
      continue;
    }

    if (!inDollarBlock && trimmed.endsWith(";")) {
      statements.push(buffer.join("\n"));
      buffer.length = 0;
    }
  }

  if (buffer.length > 0) {
    statements.push(buffer.join("\n"));
  }

  return statements.map((stmt) => stmt.trim()).filter((stmt) => stmt.length > 0);
}

const statements = splitDDL(schemaText);

const db = await Ominipg.connect({
  url: "file:///Users/vfssantos/Documents/Projetos/COPILOTZ/ominipg/tmp/pglite-repro/agents.db",
  useWorker: true,
  pgliteExtensions: ["uuid_ossp", "pg_trgm"],
  schemaSQL: [],
});

for (const stmt of statements) {
  try {
    await db.query(stmt);
    console.log("✓", stmt.split("\n")[0].slice(0, 80));
  } catch (error) {
    console.error("✗", stmt.split("\n")[0].slice(0, 80));
    console.error("Statement:\n", stmt);
    console.error(error);
    break;
  }
}

await db.close();

