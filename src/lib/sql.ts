export function splitSql(
  sql: string,
): { text: string; from: number; to: number }[] {
  const result: { text: string; from: number; to: number }[] = [];
  let i = 0,
    start = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (["'", '"', "`"].includes(char)) {
      const escaped =
        char === "'" &&
        i > 0 &&
        /e/i.test(sql[i - 1]) &&
        (i < 2 || !/[a-z0-9_]/i.test(sql[i - 2]));
      i++;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i++] === char) {
          if (sql[i] === char) i++;
          else break;
        }
      }
    } else if (char === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.slice(i, i + 2) === "--") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.slice(i, i + 2) === "/*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.slice(i, i + 2) === "/*") {
          depth++;
          i += 2;
        } else if (sql.slice(i, i + 2) === "*/") {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (char === "$" && /^\$[a-zA-Z_0-9]*\$/.test(sql.slice(i))) {
      const tag = sql.slice(i).match(/^\$[a-zA-Z_0-9]*\$/)![0];
      const close = sql.indexOf(tag, i + tag.length);
      i = close < 0 ? sql.length : close + tag.length;
    } else if (char === ";") {
      if (sql.slice(start, i).trim())
        result.push({
          text: sql.slice(start, i).trim(),
          from: start,
          to: i + 1,
        });
      i++;
      start = i;
    } else i++;
  }
  if (sql.slice(start).trim())
    result.push({ text: sql.slice(start).trim(), from: start, to: sql.length });
  return result;
}
export function currentStatement(sql: string, position: number) {
  return (
    splitSql(sql).find((s) => position >= s.from && position <= s.to)?.text ||
    ""
  );
}
