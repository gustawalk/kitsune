# Reference dialog polish

A 360px dialog with a full-width display-field selector and a column → table subtitle replaces the oversized, mostly empty picker. No selection behavior changes.

Verification: express (layout and copy only). Verify production build, existing tests, native dialog dimensions/selection, and real-database label resolution. Native testing uses an isolated profile and read-only database connection. The user identified ~/Downloads/dump_backend.sql; native verification uses an isolated PostgreSQL 18.1 restore with a SELECT-only role.
