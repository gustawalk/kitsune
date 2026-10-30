# Workspace tab ordering and bulk close

- `lib/tabs.ts:reorderedTabs()` preserves tab/session objects and IDs; `tabCloseIds()` derives scopes from current visible order. Workspace persistence serializes that same order.
- `App.tsx` wraps each tab in a Radix context-menu trigger; `data-app-context-menu` is required because document-level desktop interactions otherwise cancel the event before Radix handles it.
- Native drag/drop only accepts a source tracked in this app instance. Menu move-left/right actions provide an alternative.
- `advanceCloseQueue()` reads fresh store state and pauses for each unsaved SQL/active transaction. Confirmation closes the editor session before removing the tab and continuing. Cancellation drops the remaining queue. Protected tabs are not silently discarded.
- Coverage: pure ordering/scope tests plus visible-browser tests with the real desktop interaction installer, drag events, close scopes, cancellation, and queued transaction/unsaved confirmations.
