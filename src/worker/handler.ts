import type { ResponseMsg, WorkerMsg } from "../shared/types.ts";
import { getRssMb, safeErr } from "./utils.ts";
import { boot, shutdown } from "./bootstrap.ts";
import { dumpDataDir, exec } from "./db.ts";

export async function handleWorkerMessage(
  msg: WorkerMsg,
  post: (msg: ResponseMsg) => void,
  close: () => void,
) {
  try {
    switch (msg.type) {
      case "init": {
        const before = getRssMb();
        await boot(msg);
        const after = getRssMb();
        if (msg.logMetrics && before != null && after != null) {
          console.log(
            `Worker boot complete (+${after - before} MB, rss=${after} MB)`,
          );
        }
        post({ type: "init-ok", reqId: msg.reqId });
        break;
      }
      case "exec": {
        const rows = await exec(msg.sql, msg.params);
        post({ type: "exec-ok", reqId: msg.reqId, rows });
        break;
      }
      case "sync": {
        const { pushBatch } = await import("./sync/pusher.ts");
        const pushed = await pushBatch();
        post({ type: "sync-ok", reqId: msg.reqId, pushed });
        break;
      }
      case "sync-sequences": {
        const { synchronizeSequences } = await import("./sync/sequences.ts");
        const synced = await synchronizeSequences();
        post({ type: "sync-sequences-ok", reqId: msg.reqId, synced });
        break;
      }
      case "dump-data-dir": {
        const dataDir = await dumpDataDir();
        post({
          type: "dump-data-dir-ok",
          reqId: msg.reqId,
          dataDirBytes: new Uint8Array(await dataDir.arrayBuffer()),
          dataDirType: dataDir.type || undefined,
        });
        break;
      }
      case "diagnostic": {
        const { getDiagnosticInfo } = await import("./diagnostics.ts");
        const info = await getDiagnosticInfo();
        post({ type: "diagnostic-ok", reqId: msg.reqId, info });
        break;
      }
      case "close": {
        await shutdown();
        post({ type: "close-ok", reqId: msg.reqId });
        close();
        break;
      }
    }
  } catch (err) {
    post({
      type: "error",
      reqId: "reqId" in msg ? msg.reqId : undefined,
      error: safeErr(err),
    });
  }
}
