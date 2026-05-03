import type { ResponseMsg, WorkerMsg } from "../shared/types.ts";
import { handleWorkerMessage } from "./handler.ts";

type WorkerGlobal = {
  postMessage(message: ResponseMsg): void;
  addEventListener(
    type: "message",
    listener: (ev: MessageEvent<WorkerMsg>) => void | Promise<void>,
  ): void;
  close(): void;
};

const self = globalThis as unknown as WorkerGlobal;

// Simple postMessage wrapper
const post = (msg: ResponseMsg) => {
  self.postMessage(msg);
};

// Main worker message listener
self.addEventListener("message", async (e: MessageEvent<WorkerMsg>) => {
  await handleWorkerMessage(e.data, post, () => self.close());
});
