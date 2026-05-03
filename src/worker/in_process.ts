import type { ResponseMsg, WorkerMsg } from "../shared/types.ts";
import type { RuntimeWorker } from "../runtime/mod.ts";
import { handleWorkerMessage } from "./handler.ts";

export class InProcessWorker implements RuntimeWorker {
  private listener?: (event: MessageEvent<ResponseMsg>) => void;
  private closed = false;

  postMessage(message: unknown): void {
    if (this.closed) return;
    queueMicrotask(() => {
      handleWorkerMessage(
        message as WorkerMsg,
        (msg) => this.listener?.({ data: msg } as MessageEvent<ResponseMsg>),
        () => {
          this.closed = true;
        },
      );
    });
  }

  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ResponseMsg>) => void,
  ): void {
    if (type !== "message") return;
    this.listener = listener;
  }

  async terminate(): Promise<void> {
    this.closed = true;
  }
}
