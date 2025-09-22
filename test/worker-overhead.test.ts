import { assert } from "jsr:@std/assert@1.0.13";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function getRssMb(): number | null {
    try {
        if (Deno.build.os === 'linux') {
            const statm = Deno.readTextFileSync('/proc/self/statm').split(' ');
            const pages = Number(statm[1]);
            const bytes = pages * 4096;
            return Math.round(bytes / 1024 / 1024);
        }
        if (Deno.build.os === 'darwin') {
            const cmd = new Deno.Command('ps', { args: ['-o', 'rss=', '-p', String(Deno.pid)] });
            const out = cmd.outputSync();
            const text = new TextDecoder().decode(out.stdout).trim();
            const kb = parseInt(text || '0', 10);
            if (!Number.isFinite(kb) || kb <= 0) return null;
            return Math.round(kb / 1024);
        }
        return null;
    } catch (_e) {
        return null;
    }
}

Deno.test({ name: "Measure Deno Worker overhead", permissions: { run: true, read: true } }, async () => {
    const before = getRssMb();

    console.log('Baseline RSS', `${before} MB`);

    console.log('Waiting for 10 seconds');
    await sleep(10000);
    console.log('Creating worker');

    
    const worker = new Worker(new URL('./_simple_worker.ts', import.meta.url).href, { type: 'module' });

    await new Promise<void>((resolve) => {
        const onMessage = (e: MessageEvent) => {
            if (e.data?.type === 'ready') {
                worker.removeEventListener('message', onMessage as any);
                resolve();
            }
        };
        worker.addEventListener('message', onMessage as any);
    });

    const afterCreate = getRssMb();
    if (before != null && afterCreate != null) {
        console.log(`Worker created (+${afterCreate - before} MB, rss=${afterCreate} MB)`);
    } else {
        console.log('Worker created; metrics unavailable on this OS');
    }

    await sleep(10000);

    worker.postMessage('close');
    await new Promise<void>((resolve) => {
        const onMessage = (e: MessageEvent) => {
            if (e.data?.type === 'closed') {
                worker.removeEventListener('message', onMessage as any);
                resolve();
            }
        };
        worker.addEventListener('message', onMessage as any);
    });

    const afterClose = getRssMb();
    if (afterCreate != null && afterClose != null) {
        console.log(`After worker closed (delta ${afterClose - afterCreate} MB, rss=${afterClose} MB)`);
    }

    assert(true);
});


