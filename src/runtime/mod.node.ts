import { mkdir, stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { ResponseMsg } from "../shared/types.ts";

export interface RuntimeWorker {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ResponseMsg>) => void,
  ): void;
  terminate(): void | Promise<unknown>;
}

class NodeRuntimeWorker implements RuntimeWorker {
  constructor(private readonly worker: Worker) {}

  postMessage(message: unknown): void {
    this.worker.postMessage(message);
  }

  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ResponseMsg>) => void,
  ): void {
    if (type !== "message") return;
    this.worker.on("message", (data) => {
      listener({ data } as MessageEvent<ResponseMsg>);
    });
  }

  terminate(): Promise<number> {
    return this.worker.terminate();
  }
}

export async function createDatabaseWorker(
  baseUrl: string,
  _denoWorkerPath = "../worker/index.ts",
  nodeWorkerPath = "../worker/index.node.js",
): Promise<RuntimeWorker> {
  return new NodeRuntimeWorker(
    new Worker(new URL(nodeWorkerPath, baseUrl)),
  );
}

export function getRssMb(): number | null {
  try {
    return Math.round(process.memoryUsage().rss / 1024 / 1024);
  } catch (_e) {
    return null;
  }
}

export async function pathExistsAsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (_e) {
    return false;
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
