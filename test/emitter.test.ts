import { assertEquals } from "@std/assert";
import { TypedEmitter } from "../src/client/emitter.ts";

type Events = {
  value: (value: number) => void;
};

Deno.test("runtime-neutral emitter preserves listener ordering and duplicates", () => {
  const emitter = new TypedEmitter<Events>();
  const values: number[] = [];
  const listener = (value: number) => values.push(value);

  emitter.on("value", listener);
  emitter.on("value", listener);
  emitter.prependOnceListener("value", (value) => values.push(value * 10));

  assertEquals(emitter.listenerCount("value"), 3);
  assertEquals(emitter.emit("value", 2), true);
  assertEquals(emitter.emit("value", 3), true);
  assertEquals(values, [20, 2, 2, 3, 3]);

  emitter.off("value", listener);
  assertEquals(emitter.listenerCount("value", listener), 1);
  assertEquals(emitter.eventNames(), ["value"]);
  emitter.removeAllListeners();
  assertEquals(emitter.emit("value", 4), false);
});
