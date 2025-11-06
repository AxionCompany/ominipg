import { ensureDir } from "jsr:@std/fs/ensure-dir";
import { join } from "jsr:@std/path/join";
import { dirname, fromFileUrl } from "jsr:@std/path";
import { PGlite } from "npm:@electric-sql/pglite@0.3.4";
import { delay, snapshotMemory } from "./_utils.ts";

console.log("PGlite NodeFS usage\n====================");

await snapshotMemory("startup");

const baseDir = join(
  dirname(fromFileUrl(import.meta.url)),
  "tmp",
  "pglite-nodefs",
);
await ensureDir(baseDir);

const pg = new PGlite({ dataDir: baseDir });

await pg.waitReady;

await delay(200);
await snapshotMemory("after new PGlite (nodefs)");

await pg.close();
await delay(200);
await snapshotMemory("after close");
