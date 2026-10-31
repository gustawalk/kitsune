# Time Machine capture and related writes

- `src-tauri/src/monitor.rs:snapshot()` identifies rows by a declared table key, otherwise by their included values and duplicate occurrence. Identity-free query updates intentionally produce resultLeft/resultEntered, never recordChanged. Joins must return each key once with its original column names.
- `monitor.rs:run()` keeps the baseline in memory, resets after restart/resume/recovery, and emits baselineCaptured only after a successful observation. Changes between polls cannot be recovered.
- `storage.rs:event()` downgrades captures above 1 MiB to metadata, adds a reason to the summary, and removes all values. Normal metadata capture is also irreversible. Excluded and sensitive columns are omitted before comparison.
- `src/lib/timeline.ts` separates lifecycle, metadata, membership, and record existence; `TimelineWorkspace` defaults to data changes, explains missing states, and lets the user reopen watch settings. NULL remains an actual typed value; absent sides have no copy action.
- `src-tauri/src/ipc_tests.rs` contains related-record mutation coverage (SQLite and opt-in PostgreSQL) and a real joined-query watch regression. PostgreSQL test requires the marker-guarded disposable fixture from compose.engines.yaml, never a user database. The local packaged libpq can be exposed with LD_LIBRARY_PATH for native tests.
- UI guidance uses `shared.tsx:WorkflowHelp`; icon Button controls inherit accessible names from titles and hover/focus tooltips from aria-labels.

- New query-watch setup defaults to paired row changes and requires an explicit identity table before saving. Membership mode remains an explicit alternative; existing identity-free watches reopen in membership mode. This is a UI setup requirement, without breaking legacy/API watch definitions.

- Watch setup now uses visible radio cards with examples, plain-language table/ID guidance, and an explicit device-storage privacy question. `lib/watch-setup.ts:watchQueryExample()` quotes the selected table for the connection dialect; the example fills SQL only after a button click. Group/timebox/column exclusions/notifications are optional, and the footer stays visible while scrolling.

- Query watches previously never received restore provenance, even for SELECT * of their identity table. `monitor.rs:restorable_query()` now certifies direct projections using the connection dialect’s SQL AST; schema qualification avoids search-path ambiguity. `restore.rs:plan()` accepts certified query provenance for recordChanged only, retaining schema/conflict/transaction guards. Existing unstamped events remain unavailable; capture a new change after restarting/resuming. Joined/computed/renamed projections remain read-only history. Timeline exposes blocked reasons visibly.

- `database/restoration.rs:restore_protection()` receives the UPDATE column set. Cascades no longer block restores of unrelated fields; incoming FK target columns and conservatively all generated columns determine whether the cascade guard applies. Record existence restores and active triggers keep their previous guards. `restore.rs:plan()` runs these checks again at commit after metadata refresh. `components/TablePicker.tsx` supplies ranked schema/name search to both watch table selectors.

Updated: 2026-10-30
