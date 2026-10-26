import type { PgPool, PgPoolClient } from "../shared/types.ts";

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
/** Tracks ordinary provider checkouts and drains them before shutdown. */
export class AccountedPgPool implements PgPool {
  readonly options: PgPool["options"];
  private normal = 0;
  /** Physical returns that threw retain their charge and a cleanup handle. */
  private readonly failedReturns = new Set<() => void>();
  private closing = false;
  private endTask?: Promise<void>;
  private rawEndStarted = false;
  private change = changed();

  constructor(
    private readonly pool: PgPool,
    max: number,
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
    // Attach as each checkout settles.
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

  end(): Promise<void> {
    if (this.endTask) return this.endTask;
    this.closing = true;
    this.notify();
    // Publish the close promise before invoking any provider cleanup, which
    // may synchronously reenter end(). Admission is already sealed above.
    this.endTask = Promise.resolve().then(async () => {
      while (this.normal) {
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
        if (failed) throw failure;
        if (!this.normal) break;
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
