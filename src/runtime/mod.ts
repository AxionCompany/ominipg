import type { ResponseMsg } from "../shared/types.ts";

export interface RuntimeWorker {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<ResponseMsg>) => void,
  ): void;
  terminate(): void | Promise<unknown>;
}

export async function createDatabaseWorker(
  baseUrl: string,
  denoWorkerPath = "../worker/index.ts",
  _nodeWorkerPath = "../worker/index.node.js",
): Promise<RuntimeWorker> {
  return new Worker(new URL(denoWorkerPath, baseUrl).href, {
    type: "module",
  }) as RuntimeWorker;
}

export function getRssMb(): number | null {
  try {
    if (Deno.build.os === "linux") {
      const statm = Deno.readTextFileSync("/proc/self/statm").split(" ");
      const pages = Number(statm[1]);
      const bytes = pages * 4096;
      return Math.round(bytes / 1024 / 1024);
    }
    if (Deno.build.os === "darwin") {
      const cmd = new Deno.Command("ps", {
        args: ["-o", "rss=", "-p", String(Deno.pid)],
      });
      const out = cmd.outputSync();
      const text = new TextDecoder().decode(out.stdout).trim();
      const kb = parseInt(text || "0", 10);
      if (!Number.isFinite(kb) || kb <= 0) return null;
      return Math.round(kb / 1024);
    }
    return null;
  } catch (_e) {
    return null;
  }
}

export async function pathExistsAsDirectory(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isDirectory;
  } catch (_e) {
    return false;
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}
