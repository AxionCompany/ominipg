
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
 * Detects the database type from a connection URL.
 * @param url The connection URL.
 * @returns 'pglite' or 'postgres'.
 */
export function detectDatabaseType(url: string): 'pglite' | 'postgres' {
    if (url.startsWith('file://')) {
        return 'pglite';
    } else if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
        return 'postgres';
    } else {
        throw new Error(`Unsupported database URL format: ${url}. Use 'file://' for PGlite or 'postgres://' for PostgreSQL`);
    }
} 