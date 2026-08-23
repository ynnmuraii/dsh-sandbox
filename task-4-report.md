# Task 4 report: immutable minimal evidence

Implemented `tooling/src/evidence.ts` with strict V1 runtime validation, stable
plugin keys, safe run IDs, per-plugin/per-run evidence paths, formatted JSON,
exclusive publication locking, same-directory temporary files, atomic rename,
immutable duplicate rejection, best-effort temporary cleanup, and validated
newest-first loading with corruption paths in errors.

Verification:

- `pnpm vitest run tooling/src/evidence.spec.ts` — 12 passed.
- `pnpm vitest run` — 144 passed across 12 files.
- `pnpm typecheck` — passed.
- `git diff ae9bea5bcdea484ca13ff1f26ec63b1811ba5a52 -- '*spec.ts'` — empty.
