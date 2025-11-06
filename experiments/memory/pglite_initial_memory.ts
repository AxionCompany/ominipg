import { PGlite } from "npm:@electric-sql/pglite@0.3.4";

const pg = new PGlite({ initialMemory: 128 * 1024 * 1024 });
await pg.waitReady;
console.log("INITIAL_MEMORY bytes", pg.Module.INITIAL_MEMORY);
console.log("HEAP8 byteLength", pg.Module.HEAP8.byteLength);
console.log("HEAPU8 byteLength", pg.Module.HEAPU8.byteLength);
console.log("buffer byteLength", pg.Module.HEAPU8.buffer.byteLength);
console.log(
  "buffer MB",
  pg.Module.HEAPU8.buffer.byteLength / 1024 / 1024,
);
await pg.close();

