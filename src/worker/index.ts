/// <reference lib="deno.worker" />

import type { ResponseMsg, WorkerMsg } from "../shared/types.ts";
import { getRssMb, safeErr } from "./utils.ts";
import { boot, shutdown } from "./bootstrap.ts";
import { exec } from "./db.ts";

// Simple postMessage wrapper
const post = (msg: ResponseMsg) => {
  self.postMessage(msg);
};

// Main worker message listener
self.addEventListener("message", async (e: MessageEvent<WorkerMsg>) => {
  try {
    const m = e.data;
    switch (m.type) {
      case "init": {
        const before = getRssMb();
        await boot(m);
        const after = getRssMb();
        if (m.logMetrics && before != null && after != null) {
          console.log(
            `Worker boot complete (+${after - before} MB, rss=${after} MB)`,
          );
        }
        post({ type: "init-ok", reqId: m.reqId });
        break;
      }
      case "exec": {
        const rows = await exec(m.sql, m.params);
        post({ type: "exec-ok", reqId: m.reqId, rows });
        break;
      }
      case "sync": {
        const { pushBatch } = await import("./sync/pusher.ts");
        const pushed = await pushBatch();
        post({ type: "sync-ok", reqId: m.reqId, pushed });
        break;
      }
      case "sync-sequences": {
        const { synchronizeSequences } = await import("./sync/sequences.ts");
        const synced = await synchronizeSequences();
        post({ type: "sync-sequences-ok", reqId: m.reqId, synced });
        break;
      }
      case "diagnostic": {
        const { getDiagnosticInfo } = await import("./diagnostics.ts");
        const info = await getDiagnosticInfo();
        post({ type: "diagnostic-ok", reqId: m.reqId, info });
        break;
      }
      case "close": {
        await shutdown();
        self.close();
        break;
      }
    }
  } catch (err) {
    post({
      type: "error",
      reqId: "reqId" in e.data ? e.data.reqId : undefined,
      error: safeErr(err),
    });
  }
});
