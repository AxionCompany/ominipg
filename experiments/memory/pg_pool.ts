import { delay, snapshotMemory } from "./_utils.ts";

console.log("node-postgres Pool memory\n==========================");

await snapshotMemory("startup");

const { Pool } = await import("npm:pg@8.16.3");

await snapshotMemory("after import");

const pool = new Pool({ max: 1 });

await delay(200);
await snapshotMemory("after new Pool");

await pool.end();
await delay(200);
await snapshotMemory("after pool.end");
