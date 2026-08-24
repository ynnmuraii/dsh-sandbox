# Testing Policy

> **SOURCE OF TRUTH.** This file is compiled by `lab sync-context` into `plugins/*/.dsh-lab/shared-context.md`. Edit here, not in plugin snapshots.

Required test levels for plugin repos. Grounded in upstream Harness testing guidance and the pinned revision.

## Six test levels

1. **Behavior tests** — external contract, boundaries, errors, config.
2. **Lifecycle test** — unload the contributing Fiber and prove registrations, listeners, and resources are removed.
3. **Dependency transition tests** — required provider absent / present / disappeared, and the resulting Fiber states.
4. **Loader composition smoke** — load a test-only composition through a real Loader/process.
5. **Packed bundle smoke** — install the tarball and run the built entry under plain Node.
6. **Real-API smoke** — only when the observable contract depends on a real model/provider API; skip explicitly without a key.

`lab verify` then runs **target checks** against the packed tarball (`dsh plugin add` + `dsh.profile.bundles` composition): see `harness-contracts.md` patch/profile notes. For dual-face plugins this includes the lab-owned **client-smoke** gate (`tooling/src/client-smoke.ts`): on every pack, if `package.json` declares `dsh.client`, the gate extracts the `exports["./client"]` entry from the tarball and asserts it registers in a VM via a capturing `window.__ModuleLoader__.load` facade — one synchronous `{ id, factory }` row with `id === package name`; otherwise the step is skipped. A missing `lib/client.js` or an ESM output therefore fails `verify` with `loaded without registering …` even though the host `pack-smoke` stays green.

The meta-repo does not copy package tests; `lab verify` orchestrates the plugin's own commands and adds target checks.

## pnpm 11 notes

- `pnpm pack --json` emits a **single object** `{ name, version, filename, files }`, not an array (`tooling/src/package-verify.ts:resolvePackedTarball`); the lab parses it once as object-or-singleton-array.
- `--ignore-workspace` is an anti-pattern under pnpm 11: it discards the workspace `allowBuilds` policy that gates lifecycle scripts. `lab verify` already fixed this upstream — the lab no longer uses it; plugin repos and docs must not reintroduce it.

## UI session protocol

The separate `lab ui start`, `lab ui status`, `lab ui finish`, and `lab ui abort`
commands provide a temporary isolated runtime for factual UI lifecycle checks.
An external browser or vision agent/harness owns navigation, interaction, and
the visual meaning of a check. The lab retains only a minimal immutable verdict,
short summary, and captured identities; screenshots and browser artifacts remain
transient and are never retained by the lab.

## Rules

- **HMR-safety** is required for every registry: dispose the contributing Fiber and verify cleanup; source-plane tests must not accidentally pick up stale `lib/`.
- A manual `ctx.plugin()` unit test NEVER replaces a Loader/app/process smoke for a product-visible plugin.
- Cleanup failure is a lifecycle-test failure, not a warning.
- Test source and built-artifact boundaries separately (source overlay vs packed bundle).
- Pin versions in tests; do not rely on loader line order or deep-merge assumptions.
