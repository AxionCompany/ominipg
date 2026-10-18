/** Managed lanes accept one leading transaction-control statement per query.
 * Ordinary SQL is deliberately not parsed, including function/schema batches.
 * Transaction control embedded later in such a batch is outside this contract. */
export function transactionControl(sql: string):
  | { kind: "other" }
  | { kind: "begin" }
  | { kind: "end"; chain: boolean } {
  let index = 0;
  function trivia(): void {
    while (index < sql.length) {
      if (/\s/.test(sql[index])) index++;
      else if (sql.startsWith("--", index)) {
        const end = sql.slice(index + 2).search(/[\r\n]/);
        index = end < 0 ? sql.length : index + 2 + end + 1;
      } else if (sql.startsWith("/*", index)) {
        index += 2;
        let depth = 1;
        while (index < sql.length && depth) {
          if (sql.startsWith("/*", index)) {
            depth++;
            index += 2;
          } else if (sql.startsWith("*/", index)) {
            depth--;
            index += 2;
          } else index++;
        }
      } else break;
    }
  }
  function word(): string | undefined {
    const value = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index))?.[0];
    if (value) index += value.length;
    return value?.toUpperCase();
  }
  trivia();
  const first = word();
  if (
    !first ||
    !["BEGIN", "START", "COMMIT", "END", "ROLLBACK", "ABORT"].includes(first)
  ) {
    return { kind: "other" };
  }
  const words = [first];
  while (index < sql.length) {
    trivia();
    if (index === sql.length) break;
    if (sql[index] === ";") {
      do {
        index++;
        trivia();
      } while (sql[index] === ";");
      if (index < sql.length) {
        throw new Error(
          "Send PostgreSQL transaction-control statements one at a time; control-led batches are unsupported.",
        );
      }
      break;
    }
    const quote = sql[index];
    if (quote === '"' || quote === "'") {
      const escaped = quote === "'" && /[Ee]/.test(sql[index - 1] ?? "");
      index++;
      while (index < sql.length) {
        if (escaped && sql[index] === "\\") index += 2;
        else if (sql[index++] === quote) {
          if (sql[index] !== quote) break;
          index++;
        }
      }
      words.push(""); // A quoted identifier/literal cannot supply a keyword.
    } else if (
      sql[index] === "$" &&
      /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(index))
    ) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))![0];
      const end = sql.indexOf(tag, index + tag.length);
      index = end < 0 ? sql.length : end + tag.length;
      words.push("");
    } else {
      const token = word();
      if (token) words.push(token);
      else {
        words.push("");
        index++;
      }
    }
  }
  if (first === "BEGIN" || (first === "START" && words[1] === "TRANSACTION")) {
    return { kind: "begin" };
  }
  if (first === "START" || words[1] === "PREPARED") return { kind: "other" };
  const next = words[1] === "WORK" || words[1] === "TRANSACTION" ? 2 : 1;
  if (first === "ROLLBACK" && words[next] === "TO") return { kind: "other" };
  return {
    kind: "end",
    chain: words[next] === "AND" && words[next + 1] === "CHAIN",
  };
}
