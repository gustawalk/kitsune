# Reference dialog polish validation

## Validation: Reference dialog polish - PASS

Tier: express (layout and copy only).

- `src/components/ReferenceValuePicker.tsx:133`: dedicated dialog class, reference subtitle, and clearer display-column label.
- `src/App.css:4375`: scoped 360px dialog and full-width field control; other dialogs retain their dimensions.
- Native WebKit/WebDriver test: actual desktop application, actual read-only Kagura SQLite connection, isolated metadata profile. Measured dialog 360×166px and selector 318px. Selected projects.name and verified six visible issue rows show Kagura Demo.
- Actual frontend resolver against native SQLite IPC: 24 activity rows match independently queried issue titles; one metadata request and one browse request for six unique IDs. Observed 4ms lookup duration, one sample.
- `bun test`: 68 passed, 0 failed. `bun run build`: passed. Scoped Prettier check: passed.
- Evidence: `/tmp/kitsune-native-reference.py`, `/tmp/kitsune-native-reference-result.json`, `/tmp/kitsune-dialog-native.png`, `/tmp/kitsune-labels-native.png`.

## Populated PostgreSQL verification

The user identified `~/Downloads/dump_backend.sql` as the prior stress dataset. Restored the complete 130MB dump into an isolated PostgreSQL 18.1 container with temporary storage. Exact restore COPY counts: 86 tables, 389,233 rows. Created a SELECT-only account and connected the actual native Tauri/WebKit application with its own profile.

- Native dialog measured 360×166px, with a 318px selector. Column field selection persisted through native UI-state storage.
- Compared 105 rendered labels across the initial page, next page, and virtualized scrolling with an independent PostgreSQL JOIN. All matched.
- Exercised the actual frontend resolver through native PostgreSQL IPC on 5,000 rows across five pages and two relationships. Every label matched independently queried PostgreSQL records.

| Source | Offset | Rows | Unique FK keys | Batched browse calls | Resolver time |
| --- | ---: | ---: | ---: | ---: | ---: |
| peopleContacts → people.name | 0 | 1,000 | 987 | 62 | 607ms |
| peopleContacts → people.name | 1,000 | 1,000 | 991 | 62 | 352ms |
| peopleContacts → people.name | 10,000 | 1,000 | 986 | 62 | 360ms |
| dealStageHistory → deal.title | 0 | 1,000 | 929 | 59 | 488ms |
| dealStageHistory → deal.title | 10,000 | 1,000 | 941 | 59 | 463ms |

All batches remained within 16 groups and deduplicated repeated keys. These are single local runs of label-resolution duration, not a statistical performance distribution. Data, metadata, and browse requests used the actual restored PostgreSQL database; no IPC mocks were used.

Evidence: `/tmp/kitsune-native-postgres.py`, `/tmp/kitsune-postgres-reference-result.json`, `/tmp/kitsune-dialog-postgres.png`. Test container removed after verification. The dump and original database were not modified. The user's existing dev server and app were left running.
