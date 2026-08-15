const TYPE_KEY = "__ominipg_wire_type__";
const FRAME_MAGIC = new Uint8Array([0x4f, 0x4d, 0x50, 0x47]); // OMPG
const FRAME_PREFIX_BYTES = 12;

/** Maximum encoded header plus binary payload accepted by default. */
export const DEFAULT_MAX_SESSION_FRAME_BYTES = 512 * 1024 * 1024;

/**
 * Default producer chunk size for an encoded session frame.
 *
 * Session frames may be much larger than one transport data frame. Keeping
 * producer chunks bounded lets Oxian preserve stream backpressure without
 * staging a complete encoded response as one protocol chunk.
 */
export const DEFAULT_SESSION_STREAM_CHUNK_BYTES = 64 * 1024;

type EncodedSpecial = Readonly<{
  [TYPE_KEY]: string;
  value?: unknown;
  offset?: unknown;
  length?: unknown;
}>;

type BinaryParts = {
  parts: Uint8Array[];
  byteLength: number;
};

function encodeBytes(bytes: Uint8Array, binary: BinaryParts): EncodedSpecial {
  const offset = binary.byteLength;
  binary.parts.push(bytes);
  binary.byteLength += bytes.byteLength;
  if (binary.byteLength > 0xffff_ffff) {
    throw new RangeError("Ominipg binary frame payload exceeds 4 GiB.");
  }
  return {
    [TYPE_KEY]: "bytes",
    offset,
    length: bytes.byteLength,
  };
}

function encodeValue(
  value: unknown,
  seen: WeakSet<object>,
  binary: BinaryParts,
): unknown {
  if (value === undefined) return { [TYPE_KEY]: "undefined" };
  if (typeof value === "bigint") {
    return { [TYPE_KEY]: "bigint", value: value.toString() };
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { [TYPE_KEY]: "number", value: "nan" };
    if (value === Infinity) return { [TYPE_KEY]: "number", value: "infinity" };
    if (value === -Infinity) {
      return { [TYPE_KEY]: "number", value: "negative-infinity" };
    }
    if (Object.is(value, -0)) {
      return { [TYPE_KEY]: "number", value: "negative-zero" };
    }
    return value;
  }
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError(`Ominipg cannot encode ${typeof value} values.`);
  }
  if (typeof value !== "object") return value;
  if (seen.has(value)) {
    throw new TypeError("Ominipg cannot encode cyclic values.");
  }
  seen.add(value);
  try {
    if (value instanceof Date) {
      return { [TYPE_KEY]: "date", value: value.toISOString() };
    }
    if (value instanceof Uint8Array) return encodeBytes(value, binary);
    if (value instanceof ArrayBuffer) {
      return encodeBytes(new Uint8Array(value), binary);
    }
    if (ArrayBuffer.isView(value)) {
      return encodeBytes(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        binary,
      );
    }
    if (Array.isArray(value)) {
      return value.map((entry) => encodeValue(entry, seen, binary));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        `Ominipg cannot encode ${
          value.constructor?.name ?? "custom object"
        } values.`,
      );
    }
    const entries = Object.entries(value).map(([key, entry]) => [
      key,
      encodeValue(entry, seen, binary),
    ]);
    if (Object.prototype.hasOwnProperty.call(value, TYPE_KEY)) {
      return { [TYPE_KEY]: "escaped-object", value: entries };
    }
    return Object.fromEntries(entries);
  } finally {
    seen.delete(value);
  }
}

function integerField(
  special: EncodedSpecial,
  field: "offset" | "length",
): number {
  const value = special[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Invalid encoded byte ${field}.`);
  }
  return value as number;
}

function decodeValue(value: unknown, binary: Uint8Array): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => decodeValue(entry, binary));
  }
  const record = value as Record<string, unknown>;
  if (typeof record[TYPE_KEY] === "string") {
    const special = record as EncodedSpecial;
    switch (special[TYPE_KEY]) {
      case "undefined":
        return undefined;
      case "bigint":
        return BigInt(String(special.value));
      case "date":
        return new Date(String(special.value));
      case "bytes": {
        const offset = integerField(special, "offset");
        const length = integerField(special, "length");
        if (offset > binary.byteLength || length > binary.byteLength - offset) {
          throw new TypeError("Encoded byte range exceeds the binary payload.");
        }
        return binary.subarray(offset, offset + length);
      }
      case "number":
        if (special.value === "nan") return NaN;
        if (special.value === "infinity") return Infinity;
        if (special.value === "negative-infinity") return -Infinity;
        if (special.value === "negative-zero") return -0;
        throw new TypeError("Invalid encoded number.");
      case "escaped-object":
        if (!Array.isArray(special.value)) {
          throw new TypeError("Invalid escaped object.");
        }
        return Object.fromEntries(
          special.value.map((entry) => {
            if (!Array.isArray(entry) || entry.length !== 2) {
              throw new TypeError("Invalid escaped object entry.");
            }
            return [String(entry[0]), decodeValue(entry[1], binary)];
          }),
        );
      default:
        throw new TypeError(`Unknown Ominipg wire type: ${special[TYPE_KEY]}`);
    }
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      decodeValue(entry, binary),
    ]),
  );
}

/**
 * Encodes one frame as a small tagged-JSON header followed by raw binary parts.
 * The fixed prefix is: `OMPG`, uint32 header length, uint32 binary length.
 */
export function encodeSessionFrame(value: unknown): Uint8Array {
  const binary: BinaryParts = { parts: [], byteLength: 0 };
  const json = JSON.stringify(encodeValue(value, new WeakSet(), binary));
  const header = new TextEncoder().encode(json);
  if (header.byteLength > 0xffff_ffff) {
    throw new RangeError("Ominipg session frame header exceeds 4 GiB.");
  }
  const output = new Uint8Array(
    FRAME_PREFIX_BYTES + header.byteLength + binary.byteLength,
  );
  output.set(FRAME_MAGIC, 0);
  const prefix = new DataView(output.buffer, 0, FRAME_PREFIX_BYTES);
  prefix.setUint32(4, header.byteLength);
  prefix.setUint32(8, binary.byteLength);
  output.set(header, FRAME_PREFIX_BYTES);
  let offset = FRAME_PREFIX_BYTES + header.byteLength;
  for (const part of binary.parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** Writes one encoded session frame as ordered, backpressured byte chunks. */
export async function writeEncodedSessionFrame(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoded: Uint8Array,
  chunkBytes = DEFAULT_SESSION_STREAM_CHUNK_BYTES,
): Promise<void> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new TypeError("chunkBytes must be a positive safe integer.");
  }
  for (let offset = 0; offset < encoded.byteLength; offset += chunkBytes) {
    await writer.write(
      encoded.subarray(
        offset,
        Math.min(offset + chunkBytes, encoded.byteLength),
      ),
    );
  }
}

export function decodeSessionFrame(
  value: string,
  binary: Uint8Array = new Uint8Array(),
): unknown {
  return decodeValue(JSON.parse(value), binary);
}

class ByteQueue {
  private readonly chunks: Uint8Array[] = [];
  private headOffset = 0;
  byteLength = 0;

  push(value: Uint8Array): void {
    if (value.byteLength === 0) return;
    this.chunks.push(value);
    this.byteLength += value.byteLength;
  }

  peek(length: number): Uint8Array {
    if (length > this.byteLength) {
      throw new RangeError("Cannot peek beyond buffered bytes.");
    }
    const output = new Uint8Array(length);
    this.copyInto(output, false);
    return output;
  }

  read(length: number): Uint8Array {
    if (length > this.byteLength) {
      throw new RangeError("Cannot read beyond buffered bytes.");
    }
    const output = new Uint8Array(length);
    this.copyInto(output, true);
    return output;
  }

  private copyInto(output: Uint8Array, consume: boolean): void {
    let outputOffset = 0;
    let chunkIndex = 0;
    let chunkOffset = this.headOffset;
    while (outputOffset < output.byteLength) {
      const chunk = this.chunks[chunkIndex];
      const available = chunk.byteLength - chunkOffset;
      const length = Math.min(available, output.byteLength - outputOffset);
      output.set(
        chunk.subarray(chunkOffset, chunkOffset + length),
        outputOffset,
      );
      outputOffset += length;
      chunkOffset += length;
      if (chunkOffset === chunk.byteLength) {
        chunkIndex++;
        chunkOffset = 0;
      }
    }
    if (!consume) return;
    this.byteLength -= output.byteLength;
    this.chunks.splice(0, chunkIndex);
    this.headOffset = chunkOffset;
    if (this.byteLength === 0) {
      this.chunks.length = 0;
      this.headOffset = 0;
    }
  }
}

function readLengths(prefix: Uint8Array): {
  headerLength: number;
  binaryLength: number;
} {
  for (let index = 0; index < FRAME_MAGIC.byteLength; index++) {
    if (prefix[index] !== FRAME_MAGIC[index]) {
      throw new TypeError("Invalid Ominipg session frame magic.");
    }
  }
  const view = new DataView(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  );
  return {
    headerLength: view.getUint32(4),
    binaryLength: view.getUint32(8),
  };
}

export async function* decodeSessionFrames(
  stream: ReadableStream<Uint8Array>,
  options: Readonly<{ maxFrameBytes?: number }> = {},
): AsyncGenerator<unknown> {
  const maxFrameBytes = options.maxFrameBytes ??
    DEFAULT_MAX_SESSION_FRAME_BYTES;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new TypeError("maxFrameBytes must be a positive integer.");
  }
  const reader = stream.getReader();
  const queue = new ByteQueue();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      queue.push(value);
      while (queue.byteLength >= FRAME_PREFIX_BYTES) {
        const prefix = queue.peek(FRAME_PREFIX_BYTES);
        const { headerLength, binaryLength } = readLengths(prefix);
        const frameBytes = headerLength + binaryLength;
        if (frameBytes > maxFrameBytes) {
          throw new RangeError("Ominipg session frame exceeds maxFrameBytes.");
        }
        const totalBytes = FRAME_PREFIX_BYTES + frameBytes;
        if (queue.byteLength < totalBytes) break;
        queue.read(FRAME_PREFIX_BYTES);
        const header = queue.read(headerLength);
        const binary = queue.read(binaryLength);
        const json = new TextDecoder("utf-8", { fatal: true }).decode(header);
        yield decodeSessionFrame(json, binary);
      }
    }
    if (queue.byteLength > 0) {
      throw new TypeError("Truncated Ominipg session frame.");
    }
  } finally {
    reader.releaseLock();
  }
}
