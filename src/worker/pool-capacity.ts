import type { PgPool, PgPoolClient } from "../shared/types.ts";

type PairSlot = {
  client: Pick<PgPoolClient, "query">;
  returnClient(destroy?: boolean): void;
  reset: boolean;
  discarded: boolean;
  released: boolean;
};
type PairState = {
  acquiring: boolean;
  sealing: boolean;
  slots: PairSlot[];
  pending: Set<Promise<unknown>>;
  release?: Promise<void>;
};
export type ReservedPgPair = Readonly<{
  clients: readonly [Pick<PgPoolClient, "query">, Pick<PgPoolClient, "query">];
  /** Seals new statements, drains admitted statements and resets both clients
   * before returning them. Caller abort alone never releases capacity. */
  release(): Promise<void>;
}>;
function changed() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function closed(): Error {
  return new Error("PostgreSQL pool is closed.");
}
function unavailable(): Error {
  return Object.assign(
    new Error("Snapshot connection capacity is unavailable."),
    {
      code: "snapshot_capacity_unavailable",
    },
  );
}

/** Only emitted when this acquisition cannot confirm return of its own
 * partially acquired clients. Capacity refusal is not this failure class. */
export class PgPairCleanupError extends AggregateError {
  constructor(causes: unknown[]) {
    super(causes, "PostgreSQL pair acquisition cleanup is unconfirmed.");
    this.name = "PgPairCleanupError";
  }
}

/** One shared checkout boundary. Normal calls retain the provider's queueing;
 * an optional pair reservation must fit within the same configured total. */
export class AccountedPgPool implements PgPool {
  readonly options: PgPool["options"];
  private normal = 0;
  /** Physical returns that threw retain their charge and a cleanup handle. */
  private readonly failedReturns = new Set<() => void>();
  private pair?: PairState;
  private closing = false;
  private endTask?: Promise<void>;
  private rawEndStarted = false;
  private change = changed();

  constructor(
    private readonly pool: PgPool,
    private readonly max: number,
    private readonly reportError: (error: Error) => void = () => {},
  ) {
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new TypeError(
        "PostgreSQL pool capacity must be a positive safe integer.",
      );
    }
    this.options = { ...pool.options, max };
    pool.on?.("error", this.onPoolError);
  }

  private readonly onPoolError = (error: Error): void => {
    try {
      void Promise.resolve(this.reportError(error)).catch(() => {});
    } catch {
      // Diagnostic observers cannot interrupt provider cleanup or query errors.
    }
  };

  private async checkout(): Promise<{
    client: PgPoolClient;
    query: PgPoolClient["query"];
    release(destroy?: boolean): void;
  }> {
    const client = await this.pool.connect();
    // Attach as EACH checkout settles, including the first half of a pair.
    // The event is independent of the active SQL promise's rejection.
    let fault: Error | undefined;
    const onError = (error: Error) => {
      fault ??= error;
      this.onPoolError(error);
    };
    const rawRelease = client.release.bind(client);
    client.on("error", onError);
    return {
      client,
      query: (sql, params) =>
        fault ? Promise.reject(fault) : client.query(sql, params),
      release(destroy) {
        // Failed returns retain the observer and the caller's capacity charge.
        // A fault never constitutes an early return or a COMMIT/rollback fact.
        rawRelease(destroy || fault !== undefined);
        client.removeListener("error", onError);
      },
    };
  }

  private notify(): void {
    const previous = this.change;
    this.change = changed();
    previous.resolve();
  }

  async connect(): Promise<PgPoolClient> {
    // No await before counting an immediately admissible borrow. Reservation
    // and checkout therefore cannot both claim the same available capacity.
    while (this.pair?.acquiring && this.normal >= this.max - 2) {
      if (this.closing) throw closed();
      await this.change.promise;
    }
    if (this.closing) throw closed();
    this.normal++;
    let borrowed: Awaited<ReturnType<AccountedPgPool["checkout"]>>;
    try {
      borrowed = await this.checkout();
    } catch (error) {
      this.normal--;
      this.notify();
      throw error;
    }
    const client = borrowed.client;
    let released = false;
    // node-postgres replaces client.release on checkout; retain this borrow's
    // release closure so an old wrapper cannot release a later reuse.
    const rawRelease = borrowed.release;
    const release = (destroy?: boolean) => {
      if (released) {
        // Preserve the provider's duplicate-release behavior without changing
        // our charge twice (node-postgres rejects a second release).
        rawRelease(destroy);
        return;
      }
      // A throwing release has not proved resource return: retain its charge.
      try {
        rawRelease(destroy);
      } catch (error) {
        this.failedReturns.add(retryRelease);
        this.notify();
        throw error;
      }
      released = true;
      this.failedReturns.delete(retryRelease);
      this.normal--;
      this.notify();
    };
    const retryRelease = () => release(true);
    if (this.closing) {
      release(true);
      throw closed();
    }
    const wrapper: PgPoolClient = new Proxy(client, {
      get(target, key) {
        if (key === "release") return release;
        if (key === "query") return borrowed.query;
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          return result === target ? wrapper : result;
        };
      },
    });
    return wrapper;
  }

  async reservePair(signal?: AbortSignal): Promise<ReservedPgPair> {
    signal?.throwIfAborted();
    if (this.closing) throw closed();
    if (this.pair || this.max < 2 || this.normal > this.max - 2) {
      throw unavailable();
    }
    const state: PairState = {
      acquiring: true,
      sealing: false,
      slots: [],
      pending: new Set(),
    };
    this.pair = state;
    // Capture synchronous provider failures without skipping the second result.
    const connect = () => this.checkout();
    const results = await Promise.allSettled([connect(), connect()]);
    let failure: unknown;
    let failed = false;
    for (const result of results) {
      if (result.status === "fulfilled") {
        state.slots.push({
          client: { query: result.value.query },
          returnClient: result.value.release,
          reset: false,
          discarded: false,
          released: false,
        });
      } else if (!failed) {
        failure = result.reason;
        failed = true;
      }
    }
    state.acquiring = false;
    this.notify();
    if (failed || this.closing || signal?.aborted) {
      // These clients have never been exposed and cannot contain our SQL.
      for (const slot of state.slots) slot.reset = true;
      try {
        await this.releasePair(state);
      } catch (error) {
        throw new PgPairCleanupError(failed ? [failure, error] : [error]);
      }
      if (failed) throw failure;
      throw signal?.aborted ? signal.reason : closed();
    }
    const executor = (slot: PairSlot): Pick<PgPoolClient, "query"> => ({
      query: (sql, params) => {
        if (this.closing || state.sealing || this.pair !== state) {
          return Promise.reject(
            new Error("Reserved PostgreSQL pair is closed."),
          );
        }
        const task = Promise.resolve().then(() =>
          slot.client.query(sql, params)
        );
        state.pending.add(task);
        void task.then(
          () => state.pending.delete(task),
          () => state.pending.delete(task),
        );
        return task;
      },
    });
    return Object.freeze({
      clients: Object.freeze([
        executor(state.slots[0]),
        executor(state.slots[1]),
      ]) as ReservedPgPair["clients"],
      release: () => this.releasePair(state),
    });
  }

  private releasePair(state: PairState): Promise<void> {
    if (state.release) return state.release;
    state.sealing = true;
    const task = (async () => {
      await Promise.allSettled([...state.pending]);
      let failure: unknown;
      let failed = false;
      for (const slot of state.slots) {
        if (slot.released) continue;
        if (!slot.reset) {
          try {
            await slot.client.query("ROLLBACK");
          } catch {
            slot.discarded = true;
          }
          slot.reset = true;
        }
        try {
          slot.returnClient(slot.discarded);
          slot.released = true;
        } catch (error) {
          if (!failed) {
            failure = error;
            failed = true;
          }
        }
      }
      if (state.slots.every((slot) => slot.released)) {
        if (this.pair === state) this.pair = undefined;
        this.notify();
      }
      if (failed) throw failure;
    })();
    state.release = task;
    void task.catch(() => {
      state.release = undefined;
    });
    return task;
  }

  end(): Promise<void> {
    if (this.endTask) return this.endTask;
    this.closing = true;
    this.notify();
    // Publish the close promise before invoking any provider cleanup, which
    // may synchronously reenter end(). Admission is already sealed above.
    this.endTask = Promise.resolve().then(async () => {
      // Pair executors are private to this reservation, so close can seal them,
      // drain their actual SQL and reset/release them. Existing normal clients
      // still own their terminal statements and must return themselves.
      while (this.normal || this.pair) {
        const wake = this.change.promise;
        let failed = false;
        let failure: unknown;
        for (const retry of [...this.failedReturns]) {
          try {
            retry();
          } catch (error) {
            if (!failed) {
              failed = true;
              failure = error;
            }
          }
        }
        const state = this.pair;
        if (state && !state.acquiring) {
          try {
            await this.releasePair(state);
          } catch (error) {
            if (!failed) {
              failed = true;
              failure = error;
            }
          }
        }
        if (failed) throw failure;
        if (!this.normal && !this.pair) break;
        await wake;
      }
      // Once physical shutdown starts its outcome is retained, including an
      // unknown failure. Only pre-shutdown resource cleanup may be retried.
      this.rawEndStarted = true;
      await this.pool.end();
      // Keep observation installed after an unconfirmed/failed shutdown.
      this.pool.removeListener?.("error", this.onPoolError);
    });
    const task = this.endTask;
    void task.catch(() => {
      if (!this.rawEndStarted && this.endTask === task) {
        this.endTask = undefined;
      }
    });
    return task;
  }
}
