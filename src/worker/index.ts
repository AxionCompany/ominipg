/// <reference lib="deno.worker" />

import type { ResponseMsg, WorkerMsg } from "../shared/types.ts";
import { handleWorkerMessage } from "./handler.ts";

// Simple postMessage wrapper
const post = (msg: ResponseMsg) => {
  self.postMessage(msg);
};

// Main worker message listener
self.addEventListener("message", async (e: MessageEvent<WorkerMsg>) => {
  await handleWorkerMessage(e.data, post, () => self.close());
});
