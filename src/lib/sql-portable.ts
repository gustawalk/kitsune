/** Explicit portable SELECT AST. Unsupported SQL stays native; execution never invokes this translator. */
export type SqlDialect = "sqlite" | "postgres" | "mysql" | "duckdb" | "mssql";
export interface SqlToken {
  kind: "word" | "identifier" | "string" | "number" | "parameter" | "symbol";
  text: string;
  from: number;
  to: number;
}
export class SqlParseError extends Error {
  constructor(
    message: string,
    public from: number,
    public to: number,
  ) {
    super(message);
    this.name = "SqlParseError";
  }
}
export function tokenizeSql(source: string): SqlToken[] {
  if (source.length > 1024 * 1024)
    throw new SqlParseError("SQL exceeds 1 MiB.", 0, source.length);
  const tokens: SqlToken[] = [];
  let i = 0;
  const add = (kind: SqlToken["kind"], text: string, from: number) => {
    tokens.push({ kind, text, from, to: i });
    if (tokens.length > 20000)
      throw new SqlParseError(
        "Use a smaller query (20,000 token limit).",
        from,
        i,
      );
  };
  while (i < source.length) {
    const start = i;
    if ((source[i] === "N" || source[i] === "n") && source[i + 1] === "'") i++;
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (source.startsWith("--", i)) {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (source.startsWith("/*", i)) {
      if (/^\/\*[!]|^\/\*M!/i.test(source.slice(i)))
        throw new SqlParseError(
          "Executable comments cannot be translated.",
          i,
          i + 3,
        );
      let depth = 1;
      i += 2;
      while (i < source.length && depth) {
        if (source.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (source.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth)
        throw new SqlParseError("Unterminated block comment.", start, i);
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const end = c === "[" ? "]" : c;
      i++;
      let value = "",
        closed = false;
      while (i < source.length) {
        if (source[i] === end) {
          i++;
          if (source[i] === end) {
            value += end;
            i++;
          } else {
            closed = true;
            break;
          }
        } else {
          if (c === "'" && source[i] === "\\")
            throw new SqlParseError(
              "Backslash string escapes are dialect-specific. Use doubled quotes in portable SQL.",
              i,
              i + 1,
            );
          value += source[i++];
        }
      }
      if (!closed)
        throw new SqlParseError("Unterminated string or identifier.", start, i);
      add(c === "'" ? "string" : "identifier", value, start);
      continue;
    }
    const param = source
      .slice(i)
      .match(/^(?:@p[1-9]\d*|\$[1-9]\d*|\?[1-9]\d*|\?)/i);
    if (param) {
      i += param[0].length;
      add("parameter", param[0], start);
      continue;
    }
    const number = source
      .slice(i)
      .match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) {
      i += number[0].length;
      add("number", number[0], start);
      continue;
    }
    const word = source.slice(i).match(/^[\p{L}_][\p{L}\p{N}_$]*/u);
    if (word) {
      i += word[0].length;
      add("word", word[0], start);
      continue;
    }
    const op = source.slice(i).match(/^(?:<>|!=|<=|>=|\|\||[(),.;*+\-/%=<>])/);
    if (op) {
      i += op[0].length;
      add("symbol", op[0], start);
      continue;
    }
    throw new SqlParseError(
      `Unsupported token ${JSON.stringify(c)}. Keep this query in native SQL mode.`,
      start,
      start + 1,
    );
  }
  return tokens;
}
export type Expr =
  | { kind: "name"; parts: string[] }
  | { kind: "literal"; type: "string" | "number" | "keyword"; value: string }
  | { kind: "parameter"; index: number }
  | { kind: "star"; table?: string[] }
  | { kind: "call"; name: string; args: Expr[]; distinct: boolean }
  | { kind: "unary"; op: string; value: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "null"; value: Expr; not: boolean }
  | { kind: "in"; value: Expr; items: Expr[]; not: boolean }
  | { kind: "between"; value: Expr; low: Expr; high: Expr; not: boolean };
interface Table {
  name: string[];
  alias?: string;
}
export interface SelectAst {
  kind: "select";
  distinct: boolean;
  columns: { value: Expr; alias?: string }[];
  from?: Table;
  joins: { type: string; table: Table; on?: Expr }[];
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
  orderBy: { value: Expr; descending: boolean }[];
  limit?: string;
  offset?: string;
}
const reserved = new Set(
  "SELECT DISTINCT TOP FROM AS WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET FETCH NEXT FIRST ROWS ROW ONLY UNION EXCEPT INTERSECT RETURNING INTO FOR WINDOW QUALIFY WHEN THEN ELSE END AND OR IS NOT IN BETWEEN LIKE NULL TRUE FALSE".split(
    " ",
  ),
);
class Parser {
  private i = 0;
  private depth = 0;
  private parameter = 0;
  constructor(
    private tokens: SqlToken[],
    private length: number,
  ) {}
  private peek() {
    return this.tokens[this.i];
  }
  private is(text: string) {
    const t = this.peek();
    return (
      !!t &&
      t.kind !== "identifier" &&
      t.kind !== "string" &&
      t.text.toUpperCase() === text
    );
  }
  private take(text: string) {
    if (this.is(text)) {
      this.i++;
      return true;
    }
    return false;
  }
  private fail(message: string): never {
    const t = this.peek();
    throw new SqlParseError(
      message,
      t?.from ?? this.length,
      t?.to ?? this.length,
    );
  }
  private need(text: string) {
    if (!this.take(text)) this.fail(`Expected ${text}.`);
  }
  private identifier() {
    const t = this.peek();
    if (
      !t ||
      !["word", "identifier"].includes(t.kind) ||
      (t.kind === "word" && reserved.has(t.text.toUpperCase()))
    )
      this.fail(
        "Expected a table, column, or alias name. Quote reserved names.",
      );
    this.i++;
    return t.text;
  }
  private names() {
    const parts = [this.identifier()];
    while (this.take(".")) {
      if (this.is("*")) break;
      parts.push(this.identifier());
    }
    return parts;
  }
  private alias() {
    if (this.take("AS")) return this.identifier();
    const t = this.peek();
    if (
      t &&
      (t.kind === "identifier" ||
        (t.kind === "word" && !reserved.has(t.text.toUpperCase())))
    )
      return this.identifier();
    return undefined;
  }
  private table(): Table {
    return { name: this.names(), alias: this.alias() };
  }
  private list<T>(read: () => T): T[] {
    const result = [read()];
    while (this.take(",")) result.push(read());
    return result;
  }
  private integer() {
    const t = this.peek();
    if (
      !t ||
      t.kind !== "number" ||
      !/^\d+$/.test(t.text) ||
      BigInt(t.text) > 2147483647n
    )
      this.fail("Paging requires an integer from 0 to 2,147,483,647.");
    this.i++;
    return t.text;
  }
  parse(): SelectAst {
    this.need("SELECT");
    const distinct = this.take("DISTINCT");
    let limit: string | undefined;
    if (this.take("TOP")) {
      const paren = this.take("(");
      limit = this.integer();
      if (paren) this.need(")");
    }
    const columns = this.list(() => ({
      value: this.expr(),
      alias: this.alias(),
    }));
    const result: SelectAst = {
      kind: "select",
      distinct,
      columns,
      joins: [],
      groupBy: [],
      orderBy: [],
      limit,
    };
    if (this.take("FROM")) result.from = this.table();
    while (
      this.is("JOIN") ||
      ["INNER", "LEFT", "RIGHT", "FULL", "CROSS"].some((x) => this.is(x))
    ) {
      let type = "INNER";
      if (!this.is("JOIN")) {
        type = this.peek()!.text.toUpperCase();
        this.i++;
        this.take("OUTER");
      }
      this.need("JOIN");
      const table = this.table();
      let on: Expr | undefined;
      if (type !== "CROSS") {
        this.need("ON");
        on = this.expr();
      }
      result.joins.push({ type, table, on });
    }
    if (result.joins.length && !result.from)
      this.fail("JOIN requires a FROM table.");
    if (this.take("WHERE")) result.where = this.expr();
    if (this.take("GROUP")) {
      this.need("BY");
      result.groupBy = this.list(() => this.expr());
    }
    if (this.take("HAVING")) result.having = this.expr();
    if (this.take("ORDER")) {
      this.need("BY");
      result.orderBy = this.list(() => {
        const value = this.expr();
        const descending = this.take("DESC");
        if (!descending) this.take("ASC");
        return { value, descending };
      });
    }
    if (this.take("LIMIT")) {
      if (result.limit !== undefined) this.fail("Use only one row limit.");
      result.limit = this.integer();
      if (this.take(",")) {
        result.offset = result.limit;
        result.limit = this.integer();
      }
    }
    if (this.take("OFFSET")) {
      result.offset = this.integer();
      this.take("ROWS");
      if (this.take("FETCH")) {
        if (!this.take("NEXT")) this.need("FIRST");
        result.limit = this.integer();
        this.need("ROWS");
        this.need("ONLY");
      }
    }
    this.take(";");
    if (this.peek())
      this.fail(
        `Portable mode does not support ${this.peek()!.text}. Use native SQL for CTEs, subqueries, casts, writes, and engine-specific extensions.`,
      );
    return result;
  }
  private expr(min = 0): Expr {
    if (++this.depth > 64) this.fail("Expression nesting exceeds 64 levels.");
    let left = this.atom();
    const precedences: Record<string, number> = {
      OR: 1,
      AND: 2,
      "=": 4,
      "!=": 4,
      "<>": 4,
      "<": 4,
      ">": 4,
      "<=": 4,
      ">=": 4,
      LIKE: 4,
      "||": 5,
      "+": 6,
      "-": 6,
      "*": 7,
      "/": 7,
      "%": 7,
    };
    while (this.peek()) {
      if (min <= 4 && this.take("IS")) {
        const not = this.take("NOT");
        this.need("NULL");
        left = { kind: "null", value: left, not };
        continue;
      }
      const negated =
        this.is("NOT") &&
        ["IN", "BETWEEN", "LIKE"].includes(
          this.tokens[this.i + 1]?.text.toUpperCase(),
        );
      const op = negated
        ? this.tokens[this.i + 1].text.toUpperCase()
        : this.peek()!.text.toUpperCase();
      if (min <= 4 && (op === "IN" || op === "BETWEEN")) {
        this.i += negated ? 2 : 1;
        if (op === "IN") {
          this.need("(");
          const items = this.list(() => this.expr());
          this.need(")");
          left = { kind: "in", value: left, items, not: negated };
        } else {
          const low = this.expr(5);
          this.need("AND");
          const high = this.expr(5);
          left = { kind: "between", value: left, low, high, not: negated };
        }
        continue;
      }
      const priority = precedences[op];
      if (
        priority === undefined ||
        priority < min ||
        this.peek()!.kind === "identifier" ||
        this.peek()!.kind === "string"
      )
        break;
      this.i += negated ? 2 : 1;
      left = {
        kind: "binary",
        op: negated ? "NOT LIKE" : op,
        left,
        right: this.expr(priority + 1),
      };
    }
    this.depth--;
    return left;
  }
  private atom(): Expr {
    const t = this.peek();
    if (!t) this.fail("Expected an expression.");
    if (this.take("(")) {
      const value = this.expr();
      this.need(")");
      return value;
    }
    if (this.take("NOT"))
      return { kind: "unary", op: "NOT", value: this.expr(3) };
    if (this.take("-") || this.take("+"))
      return {
        kind: "unary",
        op: this.tokens[this.i - 1].text,
        value: this.expr(8),
      };
    if (this.take("*")) return { kind: "star" };
    if (t.kind === "string" || t.kind === "number") {
      this.i++;
      return { kind: "literal", type: t.kind, value: t.text };
    }
    if (t.kind === "parameter") {
      this.i++;
      const index =
        t.text === "?"
          ? ++this.parameter
          : Number(t.text.slice(t.text.toLowerCase().startsWith("@p") ? 2 : 1));
      this.parameter = Math.max(this.parameter, index);
      if (!Number.isSafeInteger(index) || index < 1 || index > 30000)
        this.fail("Parameter index exceeds 30,000.");
      return { kind: "parameter", index };
    }
    if (
      t.kind === "word" &&
      ["NULL", "TRUE", "FALSE", "CURRENT_TIMESTAMP", "CURRENT_DATE"].includes(
        t.text.toUpperCase(),
      )
    ) {
      this.i++;
      return { kind: "literal", type: "keyword", value: t.text.toUpperCase() };
    }
    const parts = this.names();
    if (this.is("*") && this.tokens[this.i - 1]?.text === ".") {
      this.i++;
      return { kind: "star", table: parts };
    }
    if (this.take("(")) {
      if (parts.length !== 1)
        this.fail("Qualified functions are native SQL only.");
      const distinct = this.take("DISTINCT");
      let args: Expr[] = [];
      if (!this.take(")")) {
        args = this.list(() => this.expr());
        this.need(")");
      }
      return { kind: "call", name: parts[0].toUpperCase(), args, distinct };
    }
    return { kind: "name", parts };
  }
}
export function parsePortableSql(source: string): SelectAst {
  return new Parser(tokenizeSql(source), source.length).parse();
}
export function quoteSqlName(name: string, dialect: SqlDialect) {
  return dialect === "mysql"
    ? "`" + name.split("`").join("``") + "`"
    : dialect === "mssql"
      ? "[" + name.split("]").join("]]") + "]"
      : '"' + name.split('"').join('""') + '"';
}
export function emitPortableSql(
  ast: SelectAst,
  dialect: SqlDialect,
  parameterOrder: number[] = [],
): string {
  const stack: [unknown, number][] = [[ast, 0]];
  let count = 0;
  while (stack.length) {
    const [value, depth] = stack.pop()!;
    if (++count > 100000 || depth > 128)
      throw new Error("Portable query tree is too large or deeply nested.");
    if (value && typeof value === "object")
      for (const child of Object.values(value)) stack.push([child, depth + 1]);
  }
  const quote = (name: string) => quoteSqlName(name, dialect),
    names = (parts: string[]) => parts.map(quote).join(".");
  function expr(e: Expr): string {
    switch (e.kind) {
      case "name":
        return names(e.parts);
      case "star":
        return e.table ? names(e.table) + ".*" : "*";
      case "literal":
        if (e.type === "string") {
          if (dialect === "mysql" && e.value.includes("\\"))
            throw new Error(
              "Backslashes in portable strings are unavailable for MySQL's native escaping modes.",
            );
          return (
            (dialect === "mssql" ? "N" : "") +
            "'" +
            e.value.split("'").join("''") +
            "'"
          );
        }
        if (
          e.type === "keyword" &&
          dialect === "mssql" &&
          ["TRUE", "FALSE"].includes(e.value)
        )
          throw new Error(
            "SQL Server has no SQL boolean literal. Use an explicit comparison in native SQL.",
          );
        if (
          e.type === "keyword" &&
          dialect === "mssql" &&
          e.value === "CURRENT_DATE"
        )
          throw new Error(
            "Use a native SQL Server date expression for CURRENT_DATE.",
          );
        return e.value;
      case "parameter":
        parameterOrder.push(e.index);
        return dialect === "mysql"
          ? "?"
          : dialect === "postgres" || dialect === "duckdb"
            ? `$${e.index}`
            : dialect === "mssql"
              ? `@p${e.index}`
              : `?${e.index}`;
      case "unary":
        return `(${e.op} ${expr(e.value)})`;
      case "binary":
        if (e.op === "||") {
          if (dialect === "mssql")
            throw new Error(
              "SQL Server concatenation has different NULL semantics. Use native SQL for this expression.",
            );
          return dialect === "mysql"
            ? `CONCAT(${expr(e.left)}, ${expr(e.right)})`
            : `(${expr(e.left)} || ${expr(e.right)})`;
        }
        return `(${expr(e.left)} ${e.op} ${expr(e.right)})`;
      case "null":
        return `(${expr(e.value)} IS ${e.not ? "NOT " : ""}NULL)`;
      case "in":
        return `(${expr(e.value)} ${e.not ? "NOT " : ""}IN (${e.items.map(expr).join(", ")}))`;
      case "between":
        return `(${expr(e.value)} ${e.not ? "NOT " : ""}BETWEEN ${expr(e.low)} AND ${expr(e.high)})`;
      case "call": {
        if (["NOW", "GETDATE"].includes(e.name) && !e.args.length)
          return "CURRENT_TIMESTAMP";
        if (
          ![
            "COUNT",
            "SUM",
            "AVG",
            "MIN",
            "MAX",
            "COALESCE",
            "NULLIF",
            "LOWER",
            "UPPER",
            "ABS",
            "ROUND",
          ].includes(e.name)
        )
          throw new Error(
            `${e.name} is engine-specific. Use native SQL or a supported portable function.`,
          );
        return `${e.name}(${e.distinct ? "DISTINCT " : ""}${e.args.map(expr).join(", ")})`;
      }
    }
  }
  const table = (t: Table) =>
    names(t.name) + (t.alias ? ` AS ${quote(t.alias)}` : "");
  const lines = [
    `SELECT ${ast.distinct ? "DISTINCT " : ""}${dialect === "mssql" && ast.limit !== undefined && ast.offset === undefined ? `TOP (${ast.limit}) ` : ""}${ast.columns.map((c) => expr(c.value) + (c.alias ? ` AS ${quote(c.alias)}` : "")).join(", ")}`,
  ];
  if (ast.from) lines.push(`FROM ${table(ast.from)}`);
  for (const j of ast.joins) {
    if (j.type === "FULL" && dialect === "mysql")
      throw new Error(
        "MySQL/MariaDB has no portable FULL JOIN. Use an explicit native query.",
      );
    lines.push(
      `${j.type} JOIN ${table(j.table)}${j.on ? ` ON ${expr(j.on)}` : ""}`,
    );
  }
  if (ast.where) lines.push(`WHERE ${expr(ast.where)}`);
  if (ast.groupBy.length)
    lines.push(`GROUP BY ${ast.groupBy.map(expr).join(", ")}`);
  if (ast.having) lines.push(`HAVING ${expr(ast.having)}`);
  if (ast.orderBy.length)
    lines.push(
      `ORDER BY ${ast.orderBy.map((o) => expr(o.value) + (o.descending ? " DESC" : " ASC")).join(", ")}`,
    );
  if (dialect === "mssql" && ast.offset !== undefined) {
    if (ast.limit === "0")
      throw new Error("SQL Server OFFSET/FETCH requires a positive row count.");
    if (!ast.orderBy.length)
      throw new Error(
        "SQL Server paging requires ORDER BY. Choose a stable ordering first.",
      );
    lines.push(
      `OFFSET ${ast.offset} ROWS${ast.limit !== undefined ? ` FETCH NEXT ${ast.limit} ROWS ONLY` : ""}`,
    );
  } else if (dialect !== "mssql") {
    if (ast.limit !== undefined) lines.push(`LIMIT ${ast.limit}`);
    else if (ast.offset !== undefined && ["mysql", "sqlite"].includes(dialect))
      throw new Error(
        "Add LIMIT when using OFFSET for SQLite or MySQL/MariaDB.",
      );
    if (ast.offset !== undefined) lines.push(`OFFSET ${ast.offset}`);
  }
  return lines.join("\n") + ";";
}
export function translatePortableSql(source: string, dialect: SqlDialect) {
  return emitPortableSql(parsePortableSql(source), dialect);
}
