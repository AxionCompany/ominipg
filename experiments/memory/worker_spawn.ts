import { delay, snapshotMemory } from "./_utils.ts";

console.log("Worker spawn memory check\n=========================");

await snapshotMemory("startup");

const worker = new Worker(
  new URL("../../src/worker/index.ts", import.meta.url).href,
  { type: "module" },
);

await delay(200);
await snapshotMemory("after worker spawn");

worker.terminate();
await delay(200);
await snapshotMemory("after worker terminate");
