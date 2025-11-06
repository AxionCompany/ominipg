import { delay, snapshotMemory } from "./_utils.ts";

console.log("Baseline memory check\n======================");

await snapshotMemory("startup");
await delay(100);
await snapshotMemory("after 100ms idle");
