# Connection colors

## Problem Statement

Tabs from several databases are difficult to distinguish. Connection settings need an optional main color that remains visible across that connection's tabs.

## Out of Scope

Changing theme colors, database contents, connection credentials, or automatic color assignment.

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale |
| --- | --- | --- |
| Scope | Saved per connection | Matches existing connection settings |
| No color | Empty string, preserving current tab-type colors | Backward-compatible existing connections |
| Color format | Six-digit hex color or empty | Native picker and preset compatibility |
| Tab accent | Thin top stripe and existing icon/active indicator color | Visible without obscuring labels or tab kinds |

Open questions: none.

## User Stories

### Saved connection color

Acceptance Criteria:
1. WHEN a connection is saved or connected with a selected color, the color SHALL persist and return through bootstrap.
2. WHEN an existing connection has no color field, it SHALL load with an empty/default color.
3. WHEN a nonempty invalid color is submitted, validation SHALL reject it without saving.

### Minimal color selection and tabs

Acceptance Criteria:
1. WHEN connection settings open, the user SHALL be able to choose a preset, choose a custom color, or restore Default, with the current choice marked.
2. WHEN a connection color is configured, every tab for that connection SHALL show a matching thin top accent and icon/active color and its sidebar database icon SHALL use that color; other connections and uncolored tabs SHALL retain their own appearance.
3. WHEN settings are reopened after saving, the chosen color SHALL be selected; restoring Default SHALL remove the custom tab accents.
4. WHEN a swatch is hovered or focused, it SHALL retain its fill and show a clean, single focus/selection treatment.

### Resize interaction

Acceptance Criteria:
1. WHILE a panel or table column is being resized, background text selection SHALL be suppressed and existing selection SHALL be cleared.
2. WHEN resizing ends through release, pointer cancellation, or window blur, normal text selection SHALL be restored and movement handlers SHALL be detached.

## Execution Plan

1. Persist optional connection color and verify compatibility/validation/storage; commit feat(connections): persist optional connection colors.
2. Add compact picker and tab accents, verify rendered selection/save/reopen behavior and build; commit feat(connections): show database colors in workspace tabs.
3. Guard panel/column resize interaction and verify real pointer dragging/cleanup; commit fix(layout): prevent text selection while resizing.
4. Independent standard verification and targeted isolated mutation checks; record validation.

Verification: standard (presentation settings following existing persistence patterns).

## Requirement Traceability

| ID | Requirement | Status |
| --- | --- | --- |
| COLOR-01 | Persistence, old connections, validation | Verified |
| COLOR-02 | Picker and tab appearance | Verified |
| COLOR-03 | Resize selection suppression and cleanup | Verified |
