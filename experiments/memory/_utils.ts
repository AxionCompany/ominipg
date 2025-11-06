const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bytesToMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

async function maybeCollectGarbage() {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof gc === "function") {
    gc();
    await delay(10);
  }
}

export async function snapshotMemory(label: string) {
  await maybeCollectGarbage();
  const usage = Deno.memoryUsage();
  console.log(
    `${label}: rss=${bytesToMb(usage.rss)}MB heapUsed=${
      bytesToMb(usage.heapUsed)
    }MB heapTotal=${bytesToMb(usage.heapTotal)}MB`,
  );
}

export { delay };
