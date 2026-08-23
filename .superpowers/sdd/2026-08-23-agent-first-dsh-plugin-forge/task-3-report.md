# Task 3 report: deterministic temporary plugin snapshots

## Summary

Implemented deterministic current-filesystem snapshots for standalone plugins.
Snapshot traversal is shared by digesting and copying, sorts paths
independently of absolute roots, excludes VCS/runtime/build/credential inputs,
and preserves only symlinks whose resolved targets remain inside the plugin
root. External and unresolved symlinks fail before a workspace is created.

Each snapshot uses a unique `verify-*` run root under the forge runtime, and
cleanup is idempotent while reporting the exact run root on removal failure.
Construction failures remove any partially created run root.

## Files

- `tooling/src/plugin-snapshot.ts` — production traversal, digest, copy, and
  cleanup implementation.
- `.superpowers/sdd/2026-08-23-agent-first-dsh-plugin-forge/task-3-report.md` —
  this evidence report.

## Verification

- `pnpm vitest run tooling/src/plugin-snapshot.spec.ts` — PASS, 1 file / 7
  tests.
- `pnpm typecheck` — PASS (`tsc -b tooling/tsconfig.json`).
- `pnpm test` — PASS, 11 files / 129 tests.
- `git diff --check` — PASS.
- `git diff 2f22871ef940f797aa874ee3cded93d6fe9eb4ad -- '*spec.ts'` — empty;
  test files were not modified.

## Risks and decisions

- Symlink digests preserve normalized relative link bytes and canonicalize safe
  absolute links to root-relative targets, so absolute source roots do not
  introduce digest-specific bytes; copied symlinks retain their original link
  text.
- Unsupported special filesystem entries fail snapshot construction instead of
  being silently omitted.
- Snapshot construction reads source contents before creating its run root and
  removes the run root if workspace creation or copying fails.

## Commit

`feat: snapshot plugins into temporary workspaces`

## Test-file confirmation

No test file was edited, added, deleted, renamed, reformatted, or weakened.
