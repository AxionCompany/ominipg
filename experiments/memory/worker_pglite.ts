import { Ominipg } from "../../src/client/index.ts";
import { delay, snapshotMemory } from "./_utils.ts";

console.log("Worker + PGlite initialization\n===============================");

await snapshotMemory("startup");

const ominipg = await Ominipg.connect({
  url: ":memory:",
  logMetrics: false,
});

await delay(200);
await snapshotMemory("after connect");

await ominipg.close();
await delay(200);
await snapshotMemory("after close");
