# Workspace selection validation

Connecting through `src/features/Connections.tsx:ConnectionDialog()` calls `refreshConnections()` after the backend connects. That refresh validates the entire bootstrap response through `src/lib/validation.ts:validateResponse()`.

Stored workspace JSON is returned directly by `src-tauri/src/commands.rs:dispatch()` (bootstrap); unlike typed settings, it receives no Rust defaults. Older saved selections can be null. The bootstrap validator normalizes null or absent activeTab and activeConnection to empty strings, while rejecting other invalid types. Otherwise a valid connection appears to fail because the subsequent bootstrap refresh rejects the workspace.

Regression coverage: `tests/domain.test.ts`, external data validation, restores workspaces with empty saved selections.
