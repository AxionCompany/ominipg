/** Options applied when a callback transaction begins. */
export interface OminipgTransactionOptions {
  isolation?: "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
}

/** Validate at both the client and workload boundary before constructing SQL. */
export function transactionBegin(options: OminipgTransactionOptions): string {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Transaction options must be an object.");
  }
  const { isolation, readOnly } = options;
  if (
    isolation !== undefined &&
    !["read committed", "repeatable read", "serializable"].includes(isolation)
  ) {
    throw new TypeError("Invalid transaction isolation level.");
  }
  if (readOnly !== undefined && typeof readOnly !== "boolean") {
    throw new TypeError("Transaction readOnly must be a boolean.");
  }
  return "BEGIN" +
    (isolation === undefined
      ? ""
      : ` ISOLATION LEVEL ${isolation.toUpperCase()}`) +
    (readOnly === undefined ? "" : readOnly ? " READ ONLY" : " READ WRITE");
}
