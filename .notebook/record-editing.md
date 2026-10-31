# Multi-field record editing

Entry: `src/features/Table.tsx` → `components/EditCell.tsx`.
- Double-click/F2 opens editable fields from the same loaded row, focusing the chosen column. Drafts stay local until Apply changes; Cancel discards them.
- `lib/editing.ts:recordChanges()` omits unchanged fields, preserving NULL versus empty text. Draft parsing happens before IPC; errors retain all drafts.
- `commands.rs:update_cells` → `database/mod.rs:Database.update_cells()` builds one parameterized UPDATE with before-value predicates for every changed field. One statement allows interdependent CHECK constraints to hold; existing managed transaction handling checks one affected row and rolls back conflicts.
- Single-cell IPC delegates to the same method. Identity/read-only/type/transactional-table guards remain enforced in Rust. SQLite integration tests cover multi-field saves, stale values, invalid identity edits and coupled constraints; browser interaction checks use `/tmp/playwright-test-kitsune.js` with mocked IPC.

Updated: 2026-10-30
