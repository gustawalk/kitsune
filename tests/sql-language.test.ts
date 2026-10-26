import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { sql } from "@codemirror/lang-sql";
import { editorDialect } from "../src/lib/sql-language";
test("native SQL parsers distinguish keywords, quoted values and comments across engines", () => {
  for (const dialect of ["sqlite", "postgres", "mysql", "mssql"] as const) {
    const doc = "SELECT 'FROM' AS label /* JOIN */\nFROM orders";
    const state = EditorState.create({
      doc,
      extensions: [sql({ dialect: editorDialect(dialect) })],
    });
    expect(
      syntaxTree(state).resolveInner(doc.indexOf("FROM") + 1, -1).name,
    ).toMatch(/String/);
    expect(
      syntaxTree(state).resolveInner(doc.indexOf("JOIN") + 1, -1).name,
    ).toMatch(/Comment/);
    expect(
      syntaxTree(state).resolveInner(doc.lastIndexOf("FROM") + 1, -1).name,
    ).toMatch(/Keyword/);
  }
});
