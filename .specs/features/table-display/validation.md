# Table display validation

## Validation: Table display - PASS ✅

**Date**: 2026-10-27  
**Tier**: standard  
**Spec**: `.specs/features/table-display/spec.md`  
**Diff range**: `10c6597..7bf54fd` (71a34e8, 6c3e60e and 7bf54fd).  
**Verifier**: independent sub-agent, author ≠ verifier. Implementation and existing tests were read-only.

## Task completion

The spec contains the execution plan; no separate tasks.md or STATE.md exists. Compact filters and referenced labels are implemented. This report completes its independent-review step. The spec already marks TABLE-01/02/03 Verified; independent review supports those statuses.

## Spec-anchored acceptance criteria

| Criterion | Expected outcome | Evidence and assertion | Result |
| --- | --- | --- | --- |
| Compact filters 1 | One condition omits grouping and collapses saved controls | `tests/filter-builder.test.tsx:44` excludes Join conditions; lines 45–47 exclude group join and open details. `/tmp/playwright-test-kitsune.js:16` counts zero join controls; line 17 asserts no open attribute. | PASS |
| Compact filters 2 | Added conditions/groups preserve all/any and save/load | `tests/filter-builder.test.tsx:52` asserts condition control; line 58 asserts group control. `/tmp/playwright-test-kitsune-filters.js:25` asserts groupMode any and empty legacy filters; line 26 asserts exact any/all group columns; line 34 asserts two restored chips after saved-filter load. | PASS |
| Compact filters 3 | Apply collapses, removable chips remain, reopening preserves navigation filters | `/tmp/playwright-test-kitsune.js:15` asserts reopened value created; lines 21–22 assert collapsed builder and kind eq created chip. `/tmp/playwright-test-kitsune-filters.js:35` asserts chip count decreases to one. `src/features/Table.tsx:82` merges legacy navigation filters into editorGroups without changing values. | PASS |
| Referenced values 1 | Declared FK offers target columns and Original value | `tests/reference-grid.test.tsx:40` asserts FK picker control; `/tmp/playwright-test-kitsune.js:26` selects title; line 72 selects Original value and line 73 asserts raw issue-2. `src/components/ReferenceValuePicker.tsx:176` defines Original value and lines 177–186 enumerate matching target metadata. | PASS |
| Referenced values 2 | All matching current-page cells show labels; raw copy/edit/sort/navigation remain authoritative | `tests/reference-values.test.ts:89` asserts First/Second/First/undefined and line 95 asserts unchanged source. `tests/reference-grid.test.tsx:39` asserts labeled cell. `/tmp/playwright-test-kitsune.js:35` asserts raw clipboard issue-0; line 79 checks raw id navigation filter; lines 44–45 assert raw edit before/textarea values and line 48 checks sort column issue_id. `src/components/DataGrid.tsx:283` passes original typed value to edit; line 460 sorts by original source column. | PASS |
| Referenced values 3 | Setting persists per source scope and original FK definition | `/tmp/playwright-test-kitsune.js:39` waits for label after full reload. `src/features/Table.tsx:152` scopes key by JSON connection/schema/table; `src/components/ReferenceValuePicker.tsx:120` keys selections by source column. `tests/reference-values.test.ts:221` asserts changed target definition gives zero labels; line 258 asserts no requests. `src/lib/schema.ts:6` fingerprints full FK definition. | PASS |
| Referenced values 4 | Deduplicate non-null tuples, composite match, bounded batches | `tests/reference-values.test.ts:96` asserts exact two-key lookup payload; line 127 asserts [16,16,3] groups; line 161 asserts distinct tenant labels; line 166 asserts full composite conjunction; line 298 asserts [99,9] predicate counts. | PASS |
| Referenced values 5 | Null/empty/missing/error/loading fall back; stale responses never label another scope | `tests/reference-values.test.ts:192` asserts undefined labels for null/empty/missing; line 198 asserts empty map on read error; line 214 asserts unavailable field yields empty map. `tests/reference-grid.test.tsx:43` asserts raw cell without labels. `/tmp/playwright-test-kitsune.js:60` asserts issue-2 remains after stale page request resolves; line 64 asserts current-page label; line 76 asserts issue-2 after an old response resolves against the reset setting. `src/components/ReferenceValuePicker.tsx:73` requires exact enabled/source/preferences/metadata/connection identity before exposing labels; lines 45–51 suppress invalidated completion. | PASS |

All 8 ACs have exact outcome evidence. Preference-scope isolation additionally relies on implementation inspection; UI assertions are fixture-based rather than native-engine integration.

## Gate check and test integrity

Independent commands: `bun test` → **68 passed, 0 failed, 0 skipped**, 992 assertions, 17 files; `bun run build` → exit 0, generated contracts check, TypeScript and Vite production build succeeded.

A disposable archive of `HEAD~2` with symlinked node_modules ran `bun test` → **58 passed, 0 failed**, 957 assertions, 14 files. Delta: **10 tests added**, no existing tests deleted or weakened. Author logs `/tmp/kitsune-tests-final.log` and `/tmp/kitsune-build-final.log` corroborate the gate. No separate Gate Check Commands section exists; these commands implement the spec's test/build verification.

## Discrimination sensor

Only `src/lib/reference-values.ts` was mutated, in a temporary copy of src and the narrow test file with node_modules symlinked. Each mutation started from the original copy. The scratch was deleted afterward. No stash or real-tree mutation occurred.

| Mutation | Changed introduced line | Exact command in scratch | Outcome |
| --- | --- | --- | --- |
| Disable tuple deduplication with unique sequential map keys | `src/lib/reference-values.ts:62` | `bun test tests/reference-values.test.ts` | Killed: 6 pass, 1 fail |
| Remove predicate-aware bound, always batch 16 tuples | `src/lib/reference-values.ts:76` | `bun test tests/reference-values.test.ts` | Killed: 6 pass, 1 fail |
| Bypass relationship fingerprint equality | `src/lib/reference-values.ts:44` | `bun test tests/reference-values.test.ts` | Killed: 6 pass, 1 fail |

**Budget**: 3/3 standard mutations; **3 killed, 0 survived**. Probed deduplication, wide composite bounds and FK-definition isolation. Composite matching, fallback, cancellation and hook identity guards were inspected and tested as cited above but not separately mutated, within the three-mutation ceiling.

Real `git status --porcelain` before and after sensor matched exactly:

```text
 M .notebook/INDEX.md
 M scripts/test-windows-engines.ps1
?? .notebook/windows-server-checksums.md
```

## Browser evidence and limits

Reviewed both author Playwright scripts and screenshots `/tmp/kitsune-reference-labels.png` and `/tmp/kitsune-compact-filters.png`. They exercise picker selection, grouped filters, save/load, chips, persistence, raw clipboard/navigation and delayed-page lookup. Author reports both passed. Screenshot review confirms readable labels and grouped controls hidden for a single condition. Final 7bf54fd diff limits the single-row flex layout to at most one condition and wraps controls. Updated browser line 18 asserts height under 70px at 1533px; the second script checks the 800px layout. The author reran both scripts on final code successfully, including raw edit/sort and stale-setting response assertions.

The browser harness mocks IPC metadata, browse and UI-state persistence. It validates actual React interactions and request shapes, not real SQLite/PostgreSQL/MySQL query execution, native clipboard integration or disk persistence. No human interactive UAT verdict is claimed. Browser script artifacts live in /tmp and are not durable repository tests.

## Quality and edge cases

| Check | Result |
| --- | --- |
| Scope, minimal abstractions, no unnecessary flexibility | PASS: existing metadata/browse and preference patterns reused; no backend contract changes |
| Surgical changes and surrounding style | PASS: changed implementation files support the two requested UI behaviors; README describes display behavior |
| Assertion strength and per-layer coverage | PASS: typed source is immutable, composite tuples and exact bounds asserted; UI request shapes checked by fixture |
| All added tests claimed by spec | PASS: 2 filter tests map to compact 1/2; 7 resolver tests map to referenced 2–5; grid test maps to referenced 1/2/5 |
| Project guidelines | No AGENTS.md found; skill coding-principles.md applied |

Null tuples are excluded. Repeated source tuples share lookups. Missing fields, empty/null labels and permission errors leave raw values visible. Changed FK definitions do not launch unrelated reads. Different source order and composite tenant keys resolve correctly. Disabled/inactive/page-changed hooks reject old results through cancellation and identity guards. Selection, editing and sorting continue to consume untouched original rows/column names.

No concrete correctness gaps or fix tasks identified. No lessons were added because validation found no surviving mutants, failed ACs, spec-precision gaps or deviations.

## Final layout follow-up verification

Reviewed 7bf54fd CSS and class predicate. The acceptance criteria did not change; all earlier evidence remains applicable. Resolver file and tests were untouched, so sensor results carry forward. Final author logs again record 68/0 tests and successful production build; independent final gate rerun below confirmed both. Full Prettier check passed according to author. No new gaps found.
