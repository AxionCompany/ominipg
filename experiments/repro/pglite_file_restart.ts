/**
 * Reproduction script for the PGlite file-backed restart issues.
 *
 * Run with: 
 *   deno run --allow-all experiments/repro/pglite_file_restart.ts
 */

import { Ominipg } from "../../src/client/index.ts";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import { fromFileUrl, join } from "https://deno.land/std@0.224.0/path/mod.ts";

const ROOT = fromFileUrl(new URL("../../", import.meta.url));
const TMP_DIR = join(ROOT, "tmp", "pglite-repro");
const DB_FILE = join(TMP_DIR, "agents.db");
const DB_URL = `file://${DB_FILE}`;
const SCHEMA_PATH = fromFileUrl(new URL("./agents-schema.sql", import.meta.url));

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

async function main() {
  console.log("📁 Preparing temporary directory:", TMP_DIR);
  await ensureDir(TMP_DIR);

  const schemaText = await Deno.readTextFile(SCHEMA_PATH);
  const schemaStatements = splitDDL(schemaText);

  console.log("🗄️  Database URL:", DB_URL);
  console.log("🧩  Schema statements:", schemaStatements.length);

  const connectionOptions = {
    url: DB_URL,
    useWorker: true,
    logMetrics: true,
    pgliteExtensions: ["uuid_ossp", "pg_trgm"],
    schemaSQL: schemaStatements,
  };

  console.log("▶️  First boot (expected to succeed)...");
  const first = await Ominipg.connect(connectionOptions);
  await first.close();
  console.log("✅ First boot complete.\n");

  console.log("🔁 Second boot to simulate restart...");
  try {
    const second = await Ominipg.connect(connectionOptions);
    await second.close();
    console.log("✅ Second boot completed without errors.\n");
  } catch (error) {
    console.error("❌ Second boot failed:", error);
    console.error("Stack:", error instanceof Error ? error.stack : String(error));
    return;
  }

  console.log("ℹ️  To force a clean start, delete:", TMP_DIR);
}

if (import.meta.main) {
  await main();
}

