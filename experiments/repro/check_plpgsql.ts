import { Ominipg } from "../../src/client/index.ts";

const db = await Ominipg.connect({
  url: "file:///Users/vfssantos/Documents/Projetos/COPILOTZ/ominipg/tmp/pglite-repro/agents.db",
  useWorker: true,
  pgliteExtensions: ["uuid_ossp", "pg_trgm"],
  schemaSQL: [],
});

try {
  await db.query('CREATE EXTENSION IF NOT EXISTS plpgsql');
  console.log('plpgsql extension ensured');
} catch (error) {
  console.error('CREATE EXTENSION plpgsql failed', error);
}

await db.close();




