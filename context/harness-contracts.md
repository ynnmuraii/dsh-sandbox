# Harness Contracts

> **SOURCE OF TRUTH.** This file is compiled by `lab sync-context` into `plugins/*/.dsh-lab/shared-context.md`. Edit here, not in plugin snapshots.

Public plugin contracts of DeepSeek Harness. Grounded in `research/deepseek-harness-plugin-lab.md` and design spec §11.

## Plugin module exports

- `name` — stable plugin id.
- `inject` — declared mandatory service dependencies.
- `Config` — same-name Schemastery schema; configured via loader, validated and defaults applied.
- `apply(ctx, config?)` — the plugin entry.

**Rule.** A function plugin MUST use named exports (`name`, `inject`, `Config`, `apply`) and MUST NOT export a default; a default export lets the Loader lose the namespace. Object/class forms may use default export.

## Two official integration paths

1. **Source overlay.** Checkout Harness, point `--patch` at the absolute path of your local TS/JS module. Fast authoring/HMR loop; proof of live-source behavior against a specific checkout.
2. **Installable bundle.** A standalone npm/Git/local package whose `package.json` declares `dsh.bundle.patch`; install with `dsh plugin --profile <name> add ...`. Proves the real package boundary installs and boots.

Treat the two as independent acceptance evidence: source-mode success does not prove the packed bundle works, and vice versa.

## Patch semantics

- Eff tree builds over an empty list: bundle patches in order, then profile patch, then home-level patch, then `--patch` overlays. Later layer wins per line.
- A patch replaces the whole `config` — never deep-merges.
- Use `--dump-config` to inspect the final tree.
- Keep loader entry `id` stable.

## Boundaries

- DeepSeek Harness is a developer preview with compatibility-breaking changes: fix Harness revision, vendored Cordis commit, Node/pnpm, and run mode (see `compatibility.md`).
- Plugins import only public npm APIs — never files from an upstream checkout.
