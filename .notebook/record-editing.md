# Staged multi-row table editing

Entry: `src/features/Table.tsx` → `components/EditCell.tsx` → Stage changes → table-level Apply changes.
- The modal stages typed field edits only. `TableMutation.tsx` bulk updates also stage values; inserts/deletes retain the reviewed mutation flow and require resolving pending edits first.
- `lib/editing.ts:stageRowChanges()` merges by stable record identity, retains the first before-value, and removes changes reverted to that value. `pendingResult()` overlays drafts without mutating browse results; paging/sorting/refresh and tab switching retain the pending batch.
- `TableWorkspace` owns values only in component memory. A table toolbar reviews before/after values, discards rows/the batch, and submits up to 500 cells in one `update_records` request. Failures retain drafts; success invalidates browse/record caches.
- `commands.rs:update_records` validates one connection/table, limits and distinct record keys, then calls existing guarded per-row UPDATE statements inside `Database.write_transaction()`. Read-only, identity, transactional-engine and optimistic-before guards remain enforced. A later-row error rolls back earlier rows and trigger effects.
- `store.ts:pendingEdits` stores only counts/applying flags, never values. App tab-close/bulk-close guards and updater restart/install guards protect pending edits. Pending values are not serialized into saved workspace state.
- Tests: SQLite five-row success, conflict, constraint, validation and audit-trigger rollback; network fixture helper checks success and rollback on PostgreSQL/MySQL/MariaDB/SQL Server in CI; browser fixture `/tmp/playwright-test-kitsune-batch-edit.js` covers five staged rows, no writes before Apply, paging/refresh identity, tab switching/close guard, failure retention, discard and staged bulk updates.

Updated: 2026-10-31
