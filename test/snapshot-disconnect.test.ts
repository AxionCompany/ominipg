import { assertEquals, assertRejects } from "@std/assert";
import { Ominipg, type OminipgTransaction } from "../src/client/index.ts";
import type { OminipgDispatcher } from "../src/session/client.ts";
import {
  decodeSessionFrames,
  encodeSessionFrame,
} from "../src/session/codec.ts";
import {
  OMINIPG_SESSION_PROTOCOL,
  type OminipgSessionRequest,
} from "../src/session/protocol.ts";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Disconnect cancellation deadline")),
          300,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
for (const loss of ["eof", "error"] as const) {
  Deno.test(`terminal transport ${loss} cancels a held snapshot with unknown cleanup`, async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let inputTask: Promise<void> | undefined;
    const completed = gate(), entered = gate(), release = gate();
    const dispatcher = {
      dispatch(input: { body: ReadableStream<Uint8Array> }) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            output = controller;
          },
        });
        inputTask = (async () => {
          for await (const raw of decodeSessionFrames(input.body)) {
            const request = raw as OminipgSessionRequest;
            const value = request.operation === "initialize"
              ? { concurrent: true, snapshotProtocol: 1 }
              : request.operation === "snapshot-open"
              ? { kind: "pooled" }
              : { rows: [] };
            output.enqueue(
              encodeSessionFrame({
                protocol: OMINIPG_SESSION_PROTOCOL,
                kind: "response",
                id: request.id,
                ok: true,
                value,
              }),
            );
          }
        })().catch(() => {});
        return Promise.resolve({
          started: Promise.resolve(),
          metadata: Promise.resolve({ protocol: OMINIPG_SESSION_PROTOCOL }),
          output: stream,
          completed: completed.promise,
          cancel: () => Promise.resolve(),
        });
      },
    } as unknown as OminipgDispatcher;
    const db = await Ominipg.connect({
      url: "postgres://fixture/fixture",
      oxian: { dispatcher },
    });
    const reports: string[] = [];
    let retained: OminipgTransaction | undefined;
    const work = db.withReadSnapshot(async ({ snapshot }) => {
      retained = snapshot;
      await snapshot.query("SELECT 1");
      entered.resolve();
      await release.promise;
      return 42;
    }, {
      onCleanup(value) {
        reports.push(value);
      },
    });
    const observed = work.then(() => "unexpected success", () => "rejected");
    try {
      await entered.promise;
      if (loss === "eof") output.close();
      else output.error(new Error("transport lost"));
      completed.resolve();
      assertEquals(await deadline(observed), "rejected");
      assertEquals(reports, ["unknown"]);
      await assertRejects(() => retained!.query("SELECT 2"), Error, "closed");
      release.resolve();
      await Promise.resolve();
      assertEquals(reports, ["unknown"]);
    } finally {
      release.resolve();
      await work.catch(() => {});
      await db.close().catch(() => {});
      await inputTask;
    }
  });
}
