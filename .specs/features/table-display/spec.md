# Minimal table display

## Problem Statement

The filter editor consumes excessive vertical space. Foreign-key columns show opaque IDs instead of useful labels.

## Out of Scope

Manual relationships, automatic label guessing, multi-hop traversal, backend contract changes, and replacing stored IDs.

## Assumptions & Open Questions

| Assumption | Chosen default | Rationale |
| --- | --- | --- |
| Relationships | Declared foreign keys only, including composite keys | Existing metadata is authoritative |
| Display | User selects one target column per source column | Avoid ambiguous automatic labels |
| Persistence | Existing local UI preferences, scoped by connection/schema/table | Match grid layout persistence |
| Lookup | Current page, deduplicated, batches within 16 groups and 100 predicates | Existing browse API bounds |
| Values | Raw values remain authoritative for copy/edit/sort/navigation; unavailable labels fall back to IDs | Display-only feature |

Open questions: none.

## User Stories

### Compact filters

Acceptance Criteria:
1. WHEN one condition is edited, the filter editor SHALL omit group headers and AND/OR controls and keep saved-filter controls collapsed.
2. WHEN conditions or groups are added, the editor SHALL retain existing all/any semantics and save/load support.
3. WHEN filters are applied, the editor SHALL collapse and show removable active filter chips; reopening SHALL preserve applied conditions, including FK navigation filters.

### Referenced values

Acceptance Criteria:
1. WHEN a declared FK column is configured, the column control SHALL offer the referenced table's columns and an Original value option.
2. WHEN a display field is selected, all matching cells on the current page SHALL show that referenced value and preserve original values for copy/edit/sort/navigation.
3. WHEN the table is reopened, the setting SHALL persist per connection/schema/table/source column and match only its original FK definition.
4. WHEN lookups run, the system SHALL deduplicate non-null key tuples, support composite keys, and respect browse limits without per-row requests.
5. WHEN labels are null, empty, missing, unavailable, or loading, cells SHALL show original values; stale responses SHALL never label a different page or setting.

## Execution Plan

1. Compact filter editor and applied chips; verify rendering and build; commit feat(filters): compact table filter controls.
2. Reference label resolver and minimal column picker; verify batched lookup outcomes, fallback, preference validation, and build; commit feat(table): display referenced values in foreign key columns.
3. Independent review and isolated mutation checks; record validation evidence.

Verification: standard (UI display and filter controls using existing read APIs).

## Requirement Traceability

| ID | Requirement | Status |
| --- | --- | --- |
| TABLE-01 | Compact filters, grouping, chips | Verified |
| TABLE-02 | Referenced display and raw-value behavior | Implementing |
| TABLE-03 | Preferences, batching, composite keys, fallbacks | Implementing |

Step 1 complete: filter rendering tests (2 pass), typecheck and production build pass. Browser interactions follow in final verification.
