/** Provider-owned operational contract: native transaction holds the database's
 * query/exec mutex, and isInTransaction reports the actual SQL engine state.
 * The owner must exclude raw protocol access, background sync and concurrent
 * admission before calling this operation. No caller Boolean certifies it. */
export type ExclusiveSnapshotProvider = {
  isInTransaction(): boolean;
  transaction<T>(
    callback: (transaction: {
      query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
      rollback(): Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
};

/** Internal trusted-query surface. Only compiled snapshot reads may be sent.
 * Transaction control, SET/RESET and other session-mutating SQL are forbidden
 * by the caller contract. This is not confinement for arbitrary SQL strings. */
export type ExclusiveReadSnapshot = Readonly<{
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  /** Seals immediately, drains admitted raw work and confirms rollback. */
  close(): Promise<void>;
}>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Internal primitive; the native executor never escapes. The engine owns
 * failClose and must revoke every other admission before physical teardown.
 * The query executor is for trusted compiled reads, never worker-supplied SQL;
 * READ ONLY alone cannot protect a caller that deliberately ends its scope. */
export async function openExclusiveReadSnapshot(
  provider: ExclusiveSnapshotProvider,
  failClose: () => Promise<void>,
  signal?: AbortSignal,
): Promise<ExclusiveReadSnapshot> {
  signal?.throwIfAborted();
  if (provider.isInTransaction() !== false) {
    throw new Error(
      "Snapshot admission requires an idle database transaction.",
    );
  }
  const transaction = provider.transaction.bind(provider);
  const ready = deferred<ExclusiveReadSnapshot>();
  const finish = deferred<void>();
  const pending = new Set<Promise<unknown>>();
  let sealed = false;
  let rollbackConfirmed = false;
  const close = () => {
    sealed = true;
    finish.resolve();
    return task;
  };
  const abort = () => {
    void close().catch(() => {});
  };
  // Defer the provider call so task exists before reentrant provider callbacks.
  const task: Promise<void> = Promise.resolve().then(() =>
    transaction(async (tx) => {
      const query = tx.query.bind(tx);
      const rollback = tx.rollback.bind(tx);
      let failed = false;
      let failure: unknown;
      try {
        await query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        signal?.throwIfAborted();
        if (sealed) throw new Error("Snapshot is closed.");
        const reader = Object.freeze({
          query(sql: string, params?: unknown[]) {
            if (sealed || signal?.aborted) {
              return Promise.reject(new Error("Snapshot is closed."));
            }
            const raw = Promise.resolve().then(() => query(sql, params));
            pending.add(raw);
            void raw.then(
              () => pending.delete(raw),
              () => pending.delete(raw),
            );
            return raw;
          },
          close,
        });
        ready.resolve(reader);
        await finish.promise;
      } catch (error) {
        failed = true;
        failure = error;
      }
      sealed = true;
      await Promise.allSettled([...pending]);
      // Read-only resources end with an explicit, confirmed rollback. Do not
      // rely on provider auto-COMMIT or expose its retained transaction handle.
      try {
        await rollback();
        rollbackConfirmed = true;
      } catch (cleanupError) {
        if (failed) {
          throw new AggregateError(
            [failure, cleanupError],
            "Snapshot setup and rollback both failed.",
          );
        }
        throw cleanupError;
      }
      if (failed) throw failure;
    })
  ).catch(async (error) => {
    if (!rollbackConfirmed) {
      try {
        await failClose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Snapshot cleanup is unconfirmed and database close failed.",
        );
      }
    }
    throw error;
  });
  // Observe all outcomes even if opening fails before ready can be resolved.
  void task.then(
    () => {
      signal?.removeEventListener("abort", abort);
      ready.reject(new Error("Snapshot closed before admission."));
    },
    (error) => {
      signal?.removeEventListener("abort", abort);
      ready.reject(error);
    },
  );
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const reader = await ready.promise;
  if (sealed || signal?.aborted) {
    await close();
    signal?.throwIfAborted();
    throw new Error("Snapshot is closed.");
  }
  return reader;
}
