import { PGlite } from "npm:@electric-sql/pglite@0.3.4";
import { delay, snapshotMemory } from "./_utils.ts";

console.log("PGlite direct usage\n===================");

await snapshotMemory("startup");

const db = new PGlite();

await delay(200);
await snapshotMemory("after new PGlite");

if (typeof (db as { close?: () => Promise<void> }).close === "function") {
  await (db as { close?: () => Promise<void> }).close?.();
  await delay(200);
  await snapshotMemory("after close");
}
