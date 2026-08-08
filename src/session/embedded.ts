import { createHypervisor } from "@oxian/oxian-js/hypervisor";
import { createWorker } from "@oxian/oxian-js/worker";
import type { OminipgEngineDependencies } from "../worker/engine.ts";
import type { OminipgSessionTransport } from "./client.ts";
import { OMINIPG_SESSION_WORKLOAD } from "./protocol.ts";
import { createOminipgWorkload } from "./workload.ts";

export type EmbeddedOminipgSession = Readonly<{
  transport: OminipgSessionTransport;
  close(): Promise<void>;
}>;

/** Creates a private, event-loop-local Oxian topology for one Ominipg client. */
export async function createEmbeddedOminipgSession(
  dependencies: OminipgEngineDependencies,
): Promise<EmbeddedOminipgSession> {
  const hypervisor = createHypervisor({
    persistAcceptance: () => Promise.resolve(),
  });
  const worker = createWorker({
    id: `ominipg-${crypto.randomUUID()}`,
    transport: { type: "in-process", hypervisor },
    workloads: {
      [OMINIPG_SESSION_WORKLOAD]: createOminipgWorkload({ dependencies }),
    },
    capacity: 1,
  });
  const running = worker.run();
  void running.catch(() => {});
  try {
    await worker.whenReady();
  } catch (error) {
    await worker.stop("ominipg_session_start_failed").catch(() => {});
    await hypervisor.shutdown("ominipg_session_start_failed").catch(() => {});
    throw error;
  }
  let closed = false;
  return {
    transport: { dispatcher: hypervisor },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await worker.stop("ominipg_session_closed");
        await running;
      } finally {
        await hypervisor.shutdown("ominipg_session_closed");
      }
    },
  };
}
