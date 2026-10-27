import {
  sql as sqlLanguage,
  keywordCompletionSource,
} from "@codemirror/lang-sql";
import { editorDialect } from "../lib/sql-language";
import { quoteSqlName, type SqlDialect } from "../lib/sql-portable";
import { useEffect, useRef } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import {
  syntaxHighlighting,
  HighlightStyle,
  syntaxTree,
} from "@codemirror/language";
import {
  autocompletion,
  snippetCompletion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { basicSetup } from "codemirror";
import { tags } from "@lezer/highlight";
import type { Settings, SqlCompletion } from "../lib/types";
const sqlHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--sql-keyword)", fontWeight: "600" },
  {
    tag: [tags.typeName, tags.className, tags.namespace],
    color: "var(--sql-type)",
  },
  {
    tag: [tags.propertyName, tags.variableName, tags.name],
    color: "var(--sql-name)",
  },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--sql-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--sql-number)" },
  { tag: tags.comment, color: "var(--sql-comment)", fontStyle: "italic" },
  { tag: [tags.operator, tags.punctuation], color: "var(--sql-operator)" },
  { tag: tags.function(tags.variableName), color: "var(--sql-function)" },
]);
export function SqlEditor({
  value,
  dialect,
  onChange,
  editorRef,
  suggestions,
  settings,
}: {
  value: string;
  dialect: SqlDialect;
  onChange: (value: string) => void;
  editorRef: React.MutableRefObject<EditorView | null>;
  suggestions: SqlCompletion[];
  settings: Settings;
}) {
  const container = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const currentDialect = useRef(dialect);
  currentDialect.current = dialect;
  const hints = useRef(suggestions);
  hints.current = suggestions;
  const appearance = useRef(new Compartment());
  const language = useRef(new Compartment());
  useEffect(() => {
    if (!container.current) return;
    const completion = (context: CompletionContext) => {
      const node = syntaxTree(context.state).resolveInner(context.pos, -1);
      if (/string|comment/i.test(node.name)) return null;
      const word = context.matchBefore(/[\w.]+/);
      if (!context.explicit && (!word || word.from === word.to)) return null;
      return {
        from: word?.from ?? context.pos,
        options: [
          ...hints.current.map((hint) => ({
            label: hint.label,
            type: hint.kind === "table" ? "class" : "property",
            detail: hint.detail,
            apply: hint.parts
              .map((n) => quoteSqlName(n, currentDialect.current))
              .join("."),
          })),
          snippetCompletion(
            currentDialect.current === "mssql"
              ? "SELECT TOP (100) ${columns}\nFROM ${table}\nWHERE ${condition}\nORDER BY ${column};"
              : "SELECT ${columns}\nFROM ${table}\nWHERE ${condition}\nORDER BY ${column}\nLIMIT 100;",
            {
              label: "select query",
              detail: "bounded query template",
              type: "snippet",
            },
          ),
        ],
      };
    };
    const view = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          language.current.of(
            sqlLanguage({
              dialect: editorDialect(dialect),
              upperCaseKeywords: true,
            }),
          ),
          syntaxHighlighting(sqlHighlight),
          keymap.of([
            indentWithTab,
            {
              key: "Mod-Enter",
              run: () => {
                window.dispatchEvent(new Event("kitsune:execute"));
                return true;
              },
            },
            {
              key: "Mod-s",
              run: () => {
                window.dispatchEvent(new Event("kitsune:save"));
                return true;
              },
            },
          ]),
          autocompletion({
            override: [
              completion,
              (context) =>
                keywordCompletionSource(
                  editorDialect(currentDialect.current),
                  true,
                )(context),
            ],
          }),
          appearance.current.of([]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              backgroundColor: "transparent",
              color: "var(--text)",
            },
            ".cm-scroller": {
              fontFamily: "var(--font-mono)",
              overflow: "auto",
            },
            ".cm-content": { padding: "18px 0" },
            ".cm-gutters": {
              backgroundColor: "transparent",
              color: "var(--muted)",
              border: "none",
              minWidth: "48px",
            },
            ".cm-activeLine,.cm-activeLineGutter": {
              backgroundColor: "var(--hover)",
            },
            ".cm-cursor": { borderLeftColor: "var(--accent)" },
            ".cm-tooltip": {
              backgroundColor: "var(--surface)",
              color: "var(--text)",
              border: "1px solid var(--border)",
            },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
              backgroundColor: "var(--selection)",
            },
          }),
        ],
      }),
    });
    editorRef.current = view;
    return () => {
      editorRef.current = null;
      view.destroy();
    };
  }, [editorRef]);
  useEffect(() => {
    editorRef.current?.dispatch({
      effects: language.current.reconfigure(
        sqlLanguage({
          dialect: editorDialect(dialect),
          upperCaseKeywords: true,
        }),
      ),
    });
  }, [dialect, editorRef]);
  useEffect(() => {
    const view = editorRef.current;
    if (view && value !== view.state.doc.toString())
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
  }, [value, editorRef]);
  useEffect(() => {
    editorRef.current?.dispatch({
      effects: appearance.current.reconfigure([
        EditorView.theme({
          ".cm-scroller": { fontSize: `${settings.editorFontSize}px` },
        }),
        EditorState.tabSize.of(settings.editorTabSize),
        ...(settings.editorWrap ? [EditorView.lineWrapping] : []),
      ]),
    });
  }, [
    settings.editorFontSize,
    settings.editorTabSize,
    settings.editorWrap,
    editorRef,
  ]);
  return <div className="sql-editor" ref={container} />;
}
