/**
 * Ensures an identifier is safe for use in a SQL query.
 * Throws an error for invalid identifiers.
 * @param s The identifier string.
 * @returns The quoted identifier.
 */
export const ident = (s: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
    throw new Error(`Unsafe identifier: ${s}`);
  }
  return `"${s}"`;
};

/**
 * Safely extracts an error message from an unknown value.
 * @param e The value to extract the message from.
 * @returns The error message as a string.
 */
export const safeErr = (e: unknown): string =>
  (e && typeof e === "object" && "message" in e)
    ? (e as Error).message
    : String(e);

/**
 * Returns the current process RSS in MB (Linux only). If not available, returns null.
 */
export function getRssMb(): number | null {
  try {
    if (Deno.build.os === "linux") {
      const statm = Deno.readTextFileSync("/proc/self/statm").split(" ");
      const pages = Number(statm[1]);
      const bytes = pages * 4096; // Linux page size
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

/**
 * Detects the database type from a connection URL.
 * @param url The connection URL.
 * @returns 'pglite' or 'postgres'.
 */
export function detectDatabaseType(url: string): "pglite" | "postgres" {
  if (url.startsWith("file://") || url === ":memory:" || url === "") {
    return "pglite";
  } else if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return "postgres";
  } else {
    throw new Error(
      `Unsupported database URL format: ${url}. Use 'file://' for PGlite, ':memory:' for in-memory, or 'postgres://' for PostgreSQL`,
    );
  }
}
