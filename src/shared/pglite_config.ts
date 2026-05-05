import type { PGliteConfig } from "./types.ts";

export const lowMemoryPGliteStartParams = [
  "--single",
  "-F",
  "-O",
  "-j",
  "-c",
  "search_path=public",
  "-c",
  "exit_on_error=false",
  "-c",
  "log_checkpoints=false",
  "-c",
  "max_worker_processes=0",
  "-c",
  "max_parallel_workers=0",
  "-c",
  "max_parallel_workers_per_gather=0",
  "-c",
  "shared_buffers=128kB",
  "-c",
  "temp_buffers=800kB",
  "-c",
  "work_mem=64kB",
  "-c",
  "maintenance_work_mem=1MB",
  "-c",
  "effective_cache_size=1MB",
  "-c",
  "max_locks_per_transaction=10",
];

export type LowMemoryPGliteConfigOptions = {
  /**
   * Additional Postgres start parameters appended after the low-memory defaults.
   * Later `-c name=value` pairs override earlier ones.
   */
  extraStartParams?: string[];
  /**
   * Additional PGlite options to merge into the returned config.
   */
  config?: PGliteConfig;
};

export function createLowMemoryPGliteConfig(
  options: LowMemoryPGliteConfigOptions = {},
): PGliteConfig {
  const { config = {}, extraStartParams = [] } = options;
  return {
    relaxedDurability: true,
    ...config,
    startParams: [
      ...lowMemoryPGliteStartParams,
      ...extraStartParams,
    ],
  };
}

export function applyDefaultLowMemoryPGliteConfig(
  config: PGliteConfig | undefined,
): PGliteConfig {
  if (config?.startParams) {
    return { ...config };
  }

  return createLowMemoryPGliteConfig({
    config,
  });
}
