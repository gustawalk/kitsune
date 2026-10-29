# Table search relevance

`src/lib/search.ts:rankSearch()` ranks names by case-insensitive exact match, prefix, then substring; secondary/detail matches come last. It trims query whitespace, preserves input order within each tier and for empty queries, and uses linear buckets without mutating items. Consumers apply display limits after ranking.

`src/components/Palette.tsx` gives tables both bare and schema-qualified name aliases, so `deal` ranks `public.deal` ahead of `DealContract`. Combined display name/detail text remains searchable. `src/components/Sidebar.tsx` ranks eligible All/Favorites/Recent tables and orders schema groups by their best result. `src/lib/schema.ts:filterSchemaTables()` uses the same ranking after namespace/kind filters.

Regression coverage: `tests/search.test.ts` and existing schema tests cover exact/qualified/prefix/substring ordering, whitespace/case, stable ties, empty queries, missing terms, literal punctuation, detail matches, filtering and ranking before caps. A browser fixture verified palette Enter opens the exact match even when originally beyond 100 results, plus sidebar cross-schema and qualified searches and restored ordering after clearing the query.
