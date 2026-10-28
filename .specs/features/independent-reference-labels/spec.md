# Independent referenced values

## Problem Statement

The shared preferences effect clears and reloads all FK labels after any column changes. The generic dialog still requires a nested dropdown for a small field choice.

## Out of Scope

Backend contract changes, one database query per row, cross-page result caches, and modifying stored FK values.

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale |
| --- | --- | --- |
| Row updates | Publish each resolved batch immediately | Individual rows update without per-row queries |
| Cache lifetime | Current source page, metadata instance and connection | Refresh and pagination request fresh labels |
| Picker | Direct field buttons; search when more than six fields | Minimal for short lists, usable for large tables |

Open questions: none.

## User Stories

### Independent labels

Acceptance Criteria:
1. WHEN a second FK is configured, unchanged resolved labels SHALL stay visible without any repeat metadata or browse request for that column.
2. WHEN another FK is configured during an existing lookup, the original lookup SHALL continue once and publish its own correct labels.
3. WHEN an FK display field changes or is removed, only that column SHALL invalidate and stale responses SHALL not replace its new state.
4. WHEN a page, connection, metadata or enabled scope changes, the old cache SHALL be disposed and SHALL not publish delayed results into the new scope.
5. WHEN a lookup batch completes, its matching rows SHALL show labels immediately while unresolved rows retain original IDs, preserving bounded/deduplicated requests.

### Minimal picker

Acceptance Criteria:
1. WHEN a picker opens, it SHALL show a direct field list with the current choice marked and Original value available, without a nested display-field dropdown.
2. WHEN the target has more than six fields, the picker SHALL provide a field search; selecting any field SHALL save immediately and close.

## Execution Plan

1. Page-scoped independent column cache and progressive row labels; verify cache regressions and build; commit fix(table): resolve foreign key labels independently.
2. Direct searchable field picker; verify browser/native selection and build; commit feat(table): simplify referenced field selection.
3. Independent coverage and isolated mutation verification, record report.

Verification: full (asynchronous request lifecycle and cancellation).

## Requirement Traceability

| ID | Requirement | Status |
| --- | --- | --- |
| REF-01 | Independent completed and pending columns | Verified |
| REF-02 | Scope cancellation and progressive rows | Verified |
| REF-03 | Minimal direct field selection | Verified |
