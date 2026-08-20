# Compatibility

> **SOURCE OF TRUTH.** This file is compiled by `lab sync-context` into `plugins/*/.dsh-lab/shared-context.md`. Edit here, not in plugin snapshots.

How compatibility targets are managed. Grounded in design spec §8 and the research note's version-pinning constraints.

## Targets

Two daily compatibility targets:

- **next** — npm `next` tag, recorded as exact pins (`dsh`, `cordis`, `node`).
- **master** — pinned upstream `master` of `deepseek-ai/deepseek-harness`, recorded as an exact commit during setup (plus `pnpm`).

**Rules.**

- The `next` npm tag is resolved only by the target-update command; normal install/test use recorded exact versions and lockfiles.
- `upstream/deepseek-harness` is a pinned submodule and is never updated automatically.
- A new target's incompatibility is reported as an observable compatibility failure — never hidden by source-import or a local upstream patch.

## Manifest

The single machine-readable version manifest lives at `workbench/compatibility.yaml` (`targets:`). Recording the exact upstream commit is a setup-time obligation, not a runtime placeholder.

## Per-plugin declaration

Each plugin's `.dsh-lab/plugin.yaml` lists the supported target IDs it is compatible with. The catalog (`catalog.yaml`) does not duplicate version or compatibility claims; those live in the plugin repo.
