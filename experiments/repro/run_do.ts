import { Ominipg } from "../../src/client/index.ts";

const db = await Ominipg.connect({
  url: "file:///Users/vfssantos/Documents/Projetos/COPILOTZ/ominipg/tmp/pglite-repro/agents.db",
  useWorker: true,
  pgliteExtensions: ["uuid_ossp", "pg_trgm"],
  schemaSQL: [],
});

const doStatement = `DO $$
BEGIN
  ALTER TABLE "messages"
    ADD CONSTRAINT "messages_thread_id_threads_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "threads"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;`;

try {
  await db.query(doStatement);
  console.log("DO block succeeded");
} catch (error) {
  console.error("DO block failed", error);
}

await db.close();

