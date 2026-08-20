# Testing Policy

> **SOURCE OF TRUTH.** This file is compiled by `lab sync-context` into `plugins/*/.dsh-lab/shared-context.md`. Edit here, not in plugin snapshots.

Required test levels for plugin repos. Grounded in design spec §12 and `research/deepseek-harness-plugin-lab.md`.

## Six test levels

1. **Behavior tests** — external contract, boundaries, errors, config.
2. **Lifecycle test** — unload the contributing Fiber and prove registrations, listeners, and resources are removed.
3. **Dependency transition tests** — required provider absent / present / disappeared, and the resulting Fiber states.
4. **Loader composition smoke** — load a test-only composition through a real Loader/process.
5. **Packed bundle smoke** — install the tarball and run the built entry under plain Node.
6. **Real-API smoke** — only when the observable contract depends on a real model/provider API; skip explicitly without a key.

The meta-repo does not copy package tests; `lab verify` orchestrates the plugin's own commands and adds target checks.

## Rules

- **HMR-safety** is required for every registry: dispose the contributing Fiber and verify cleanup; source-plane tests must not accidentally pick up stale `lib/`.
- A manual `ctx.plugin()` unit test NEVER replaces a Loader/app/process smoke for a product-visible plugin.
- Cleanup failure is a lifecycle-test failure, not a warning.
- Test source and built-artifact boundaries separately (source overlay vs packed bundle).
- Pin versions in tests; do not rely on loader line order or deep-merge assumptions.
