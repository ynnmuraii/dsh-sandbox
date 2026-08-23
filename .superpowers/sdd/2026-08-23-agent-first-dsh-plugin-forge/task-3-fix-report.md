# Task 3 fix report

## Summary

Addressed all three accepted P1 findings in the deterministic plugin snapshot:

- Digest records now use fixed-width length-framed fields, including arbitrary
  binary regular-file bytes and symlink targets.
- Collection reads each regular file once into immutable snapshot entry bytes;
  digesting and workspace writes use those same bytes. The optional
  `beforeCopy` seam runs after collection/digest and before copying, allowing
  TOCTOU regression coverage without changing the production source tree.
- Safe absolute symlinks are rewritten to copied-workspace targets. Windows
  directory links use junctions targeting the copied workspace, avoiding
  developer-mode symlink privilege requirements and never pointing back to the
  source tree.

Any failure after run-root creation, including `beforeCopy` and copy failures,
rolls the run root back with the default forced remover.

## Files

- `tooling/src/plugin-snapshot.ts` — production fixes.
- `.superpowers/sdd/2026-08-23-agent-first-dsh-plugin-forge/task-3-fix-report.md`
  — this report.

## Verification

- `pnpm vitest run tooling/src/plugin-snapshot.spec.ts` — PASS, 1 file / 10
  tests.
- `pnpm typecheck` — PASS (`tsc -b tooling/tsconfig.json`).
- `pnpm test` — PASS, 11 files / 132 tests.
- `git diff --check` — PASS.
- `git diff 5a81a52c4625765ebbbd30b1d5ecba8955da2055 -- '*spec.ts'` — empty;
  controller tests were not modified.

## Test-file confirmation

No test file was edited, added, deleted, renamed, reformatted, or weakened.
