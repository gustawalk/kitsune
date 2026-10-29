# SQL editor shortcut precedence

`src/components/SqlEditor.tsx:SqlEditor()` installs CodeMirror `basicSetup` before app extensions. Its default command map already binds Mod-Enter to inserting a blank line, so an ordinary app keymap placed later never received Ctrl+Enter.

Run (Mod-Enter) and Save (Mod-S) use `Prec.highest(keymap.of(...))` and explicitly prevent browser defaults. Tab indentation keeps normal precedence so snippet navigation is unaffected. The shortcuts dispatch the existing execute/save events; `src/features/Query.tsx` handles them only for the active tab and uses the selected SQL or current statement.

Browser regression verified Ctrl+Enter fires once without changing SQL, preserves a selection, and keeps plain Enter, Ctrl+S and Ctrl+F working. Typecheck and SQL-language tests passed. Mod maps to Ctrl on Linux/Windows and Command on macOS.
