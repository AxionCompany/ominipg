import { Ominipg } from "../../src/client/index.ts";

const db = await Ominipg.connect({
  url: "file:///Users/vfssantos/Documents/Projetos/COPILOTZ/ominipg/tmp/pglite-repro/agents.db",
  useWorker: true,
  pgliteExtensions: ["uuid_ossp", "pg_trgm"],
  schemaSQL: [],
});

try {
  const result = await db.query(`SELECT uuid_generate_v4() as id`);
  console.log("uuid_generate_v4 result", result.rows);
} catch (error) {
  console.error("uuid_generate_v4 failed", error);
}

await db.close();

