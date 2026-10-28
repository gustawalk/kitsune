# Independent reference labels validation

## Validation: Independent reference labels - PASS

Date: 2026-10-27. Tier: full (asynchronous request lifecycle). Diff: `5f218a2..7cf6d04`.

Independent Coverage Verifier and Sensor Verifier reviewed the final diff separately. Neither edited implementation or tests. All seven acceptance criteria are supported; no concrete defects or outstanding coverage gaps found.

## Acceptance evidence

| Criterion | Outcome evidence | Result |
| --- | --- | --- |
| Labels 1: unchanged resolved columns remain visible without new requests | `tests/reference-values.test.ts:342` preserves First; `:344` asserts exact requests; `:353` asserts both labels. `/tmp/playwright-test-independent-fks.js:29` checks preserved label and subsequent assertions verify unchanged browse count and no raw-ID flash. | PASS |
| Labels 2: reuse pending lookup | `tests/reference-values.test.ts:395` and `:402` assert two total browses; `:398` asserts both correct labels after releasing the shared pending read. Browser script configures another FK while the original second batch is held, then releases that original batch. | PASS |
| Labels 3: invalidate only changed/removed column | `tests/reference-values.test.ts:428` and `:431` keep the new label after the old response arrives; `:358` retains the other column on removal with no extra requests. Browser script resets one column and asserts the other label and browse count stay unchanged. | PASS |
| Labels 4: reject stale scopes | `tests/reference-values.test.ts:455` asserts empty disposed cache and `:456` zero delayed publication. `/tmp/playwright-test-reference-scope.js:7` changes source, `:12` separately changes connection/metadata, `:21` disables, and `:24` reenables. Exact DOM values are checked after releasing each old response. Unmount DOM is checked at `:26`; delayed-publication guarantee is asserted by the cache unit test. | PASS |
| Labels 5: progressive rows, batching | `tests/reference-values.test.ts:493` asserts sixteen labels plus four unresolved entries before the next batch returns; `:501` preserves raw source values; `:512` asserts all labels with exactly two requests/publications. Existing deduplication and predicate-bound tests remain intact. Browser script checks Issue 0 while row 16 still shows issue-16. | PASS |
| Picker 1: direct list/current choice/original | `/tmp/playwright-test-independent-fks.js:11` asserts no nested combobox; current choice has aria-pressed true; resetting uses the direct Original value button. `src/components/ReferenceValuePicker.tsx:207` renders marked field buttons. | PASS |
| Picker 2: searchable larger lists, immediate application/close | Browser script searches title for the eight-field target and confirms no search for the two-field target; checks no-match state. `:16` checks closure and `:17` saved preference. `:48` checks saved reset plus retained assignee choice. | PASS |

## Gates

Independent `bun test && bun run build`: 73 passed, 0 failed, 0 skipped, 1,013 assertions. Generated types, TypeScript, and production Vite build pass. Baseline 68 tests; five outcome-focused asynchronous regression tests added, no existing assertions weakened/deleted. Scoped Prettier and git diff checks pass.

Author browser commands, both passed on final implementation:

- `NODE_PATH=/home/walk/.codex/skills/vendor/playwright-skill/node_modules node /tmp/playwright-test-independent-fks.js`
- `NODE_PATH=/home/walk/.codex/skills/vendor/playwright-skill/node_modules node /tmp/playwright-test-reference-scope.js`

Browser fixtures exercise the actual React components/hooks with controlled Tauri responses. This delivery does not claim a new native/PostgreSQL integration run; the prior populated-dump verification remains documented in reference-dialog-polish. Browser scripts/screenshots are temporary artifacts, not durable regression-suite files.

## Isolated mutation sensor

Only scratch copies were mutated. Narrow command for every mutant: `bun test tests/reference-values.test.ts`.

| Fault | Changed line | Result |
| --- | --- | --- |
| Disable existing-entry reuse | `src/lib/reference-values.ts:163` | Killed: 10 pass, 2 fail; resolved label lost and browse count rises from two to three |
| Disable field-signature invalidation | `src/lib/reference-values.ts:159` | Killed: 11 pass, 1 fail; expected second field request never starts |
| Make dispose a no-op | `src/lib/reference-values.ts:202` | Killed: 11 pass, 1 fail; disposed cache retains a label |
| Suppress per-batch publication | `src/lib/reference-values.ts:113` | Killed: 11 pass, 1 fail; first sixteen labels are absent while the last batch waits |

Budget: 4/5, four killed, zero survivors. Real git porcelain before/after was identical and retained only the pre-existing CI checksum and notebook changes. No stash or real-tree mutation. No grounded failures, deviations or spec gaps remained, so no lesson was recorded.
