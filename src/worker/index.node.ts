import { parentPort } from "node:worker_threads";
import type { ResponseMsg, WorkerMsg } from "../shared/types.ts";
import { handleWorkerMessage } from "./handler.ts";

if (!parentPort) {
  throw new Error("Ominipg Node worker must run inside worker_threads.");
}

const post = (msg: ResponseMsg) => {
  parentPort!.postMessage(msg);
};

parentPort.on("message", (msg: WorkerMsg) => {
  handleWorkerMessage(msg, post, () => {
    parentPort?.close();
  });
});
