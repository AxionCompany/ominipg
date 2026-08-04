import { createWorkerHost } from "@oxian/oxian-js/host";
import type { OminipgEngineDependencies } from "../worker/engine.ts";
import type { OminipgSessionTransport } from "./client.ts";
import { OMINIPG_SESSION_WORKLOAD } from "./protocol.ts";
import { createOminipgWorkload } from "./workload.ts";

export type EmbeddedOminipgSession = Readonly<{
  transport: OminipgSessionTransport;
  close(): Promise<void>;
}>;

/** Creates a private, event-loop-local Oxian host for one Ominipg client. */
export function createEmbeddedOminipgSession(
  dependencies: OminipgEngineDependencies,
): EmbeddedOminipgSession {
  const host = createWorkerHost({
    persistAcceptance: () => Promise.resolve(),
  });
  const worker = host.attachInProcessWorker({
    workerId: `ominipg-${crypto.randomUUID()}`,
    workloads: {
      [OMINIPG_SESSION_WORKLOAD]: createOminipgWorkload({ dependencies }),
    },
    capacity: 1,
  });
  let closed = false;
  return {
    transport: { dispatcher: host },
    async close() {
      if (closed) return;
      closed = true;
      await worker.shutdown("ominipg_session_closed");
      await host.shutdown("ominipg_session_closed");
    },
  };
}
