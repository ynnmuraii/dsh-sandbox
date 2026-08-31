# Compatibility

> **SOURCE OF TRUTH.** This file is compiled by `lab sync-context` into `plugins/*/.dsh-lab/shared-context.md`. Edit here, not in plugin snapshots.

How compatibility targets are managed. Version pinning and per-target claims for the lab, against the pinned upstream revision.

## Targets

- **next** — the pinned npm `alpha` line (`@deepseek-ai/dsh@0.1.2-alpha.2` with `@deepseek-ai/cordis@4.0.2`), recorded as exact pins (`dsh`, `cordis`, `node`). It is **not** the npm `next` dist-tag: that tag still points at the previous line. `next` names the lab's pinned pre-release line, not a tag that is re-resolved at install time.
- **master** — pinned upstream `master` of `deepseek-ai/deepseek-harness`, recorded as an exact commit during setup (plus `pnpm`).

**Rules.**

- The `next` pin changes only deliberately (a target update or an explicit repin); normal install/test use the recorded exact versions and lockfiles.
- `upstream/deepseek-harness` is a pinned submodule and is never updated automatically.
- A new target's incompatibility is reported as an observable compatibility failure — never hidden by source-import or a local upstream patch.
- Every profile the lab generates carries `dsh.profile.patchReload: "startup"` (dev, verify, and UI alike). `live` is upstream's default for custom profiles and the lab generates only custom profiles, so the key is never left to be inferred: `startup` installs neither the config-patch watchers nor the launcher's watch-only HMR fallback. `patchReload` governs config-patch watching **only** — it does not disable the dev overlay's src-rooted `hmr` row, whose reload delivery is still unverified in this forge.

## Manifest

The single machine-readable version manifest lives at `workbench/compatibility.yaml` (`targets:`). Recording the exact upstream commit is a setup-time obligation, not a runtime placeholder.

## Per-plugin declaration

Each plugin's `.dsh-lab/plugin.yaml` lists the supported target IDs it is compatible with. The catalog (`catalog.yaml`) does not duplicate version or compatibility claims; those live in the plugin repo.
