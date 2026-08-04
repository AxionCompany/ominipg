/**
 * Compatibility entrypoint for the Oxian-native Ominipg workload.
 *
 * This module no longer installs Web Worker or worker_threads listeners.
 */
export {
  createOminipgWorkload,
  OMINIPG_SESSION_PROTOCOL,
  OMINIPG_SESSION_WORKLOAD,
} from "../session/index.ts";
export type { OminipgWorkloadOptions } from "../session/index.ts";
