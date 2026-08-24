# AGENTS.md

`dsh-lab` is a meta-repo and local library for creating, studying, and verifying independent DeepSeek Harness plugins. Each `plugins/<name>` is its own Git repo; this root is not a plugin monorepo.

This is an agent-first forge. The first-slice commands accept either a catalog
name or an external path:

```text
pnpm lab inspect <name>|--path P [--json]
pnpm lab dev <name>|--path P --target T
pnpm lab verify <name>|--path P --target T [--json]
pnpm lab status <name>|--path P [--json]
pnpm lab ui start <name>|--path P --target T [--json]
pnpm lab ui status <session-id> [--json]
pnpm lab ui finish <session-id> --verdict pass|fail --summary "..." [--json]
pnpm lab ui abort <session-id> [--json]
```

`dev` is live/in-place read-only for the plugin and keeps profiles/overlays in
`.lab/runtime`. `verify` includes current uncommitted and untracked files in a
temporary workspace and always removes that workspace; only minimal evidence is
kept as forge memory. Catalog lookup and init/initialization are optional. Only explicit authoring commands mutate plugin repositories. The portable agent entrypoint is `.agents/skills/dsh-plugin-development/SKILL.md`; it provides advisory methodology and does not enforce workflow state or UI behavior. Regenerate it with `pnpm lab sync-context`.

The separate `lab ui start/status/finish/abort` protocol owns a temporary
isolated runtime and factual lifecycle/evidence only. An external browser or
vision agent/harness owns browser workflow and visual decisions. Screenshots and
browser artifacts are transient and not retained by the lab; finalized evidence
is a minimal verdict, short summary, and identities.

## Source of truth

`context/*` is the single source of truth for shared rules and the portable agent skill — edit there, never in generated projections or plugin snapshots:

- `context/harness-contracts.md` — public plugin contracts and integration paths.
- `context/cordis-model.md` — Fiber/effect/inject model.
- `context/plugin-anatomy.md` — standalone plugin repo layout and package contract.
- `context/testing-policy.md` — required test levels and HMR-safety rules.
- `context/compatibility.md` — targets, `workbench/compatibility.yaml`, per-plugin target claims.
- `context/dsh-plugin-development-skill.md` — canonical body for the generated `.agents/skills/dsh-plugin-development/SKILL.md` entrypoint.

Per-plugin `AGENTS.md` files hold only local rules and must read `.dsh-lab/shared-context.md` first.

## Lab commands

```text
pnpm lab new <name>
pnpm lab dev <name>|--path P --target next|master
pnpm lab verify <name>|--path P [--target next|master|all] [--json]
pnpm lab inspect <name>|--path P [--target next|master] [--json]
pnpm lab status <name>|--path P [--json]
pnpm lab sync-context [name|--all]
pnpm lab doctor
```

- `new` creates an autonomous nested Git repo from the template (tracked as `local`).
- `dev` runs a source overlay + HMR against the chosen target.
- `verify` runs the plugin's own checks, then compatibility checks.
- `sync-context` regenerates `plugin/.dsh-lab/shared-context.md` snapshots and `.agents/skills/dsh-plugin-development/SKILL.md`.
- `doctor` checks toolchain, catalog, target pins, submodules, context hashes, and portable-skill drift without writing files.
- Root tooling never changes plugin version or publishes packages.

## Catalog policy

`catalog.yaml` tracks each plugin as one of:

- `local` — independent nested repo, ignored by the meta-repo; for experiments.
- `submodule` — meta-repo pins remote + commit of a mature plugin.

Promoting `local → submodule` is a release from the incubator: create a remote, pass stable checks, flip tracking, register the submodule. Deleting a local dir never deletes its remote; removing a submodule is an explicit catalog + `.gitmodules` operation.

## Rules

- The meta-repo never mutates plugin git state destructively (no automatic update/reset of dirty submodules, no destructive git operations inside plugin repos).
- Production plugin code imports only public npm APIs — never from an upstream Harness checkout.
- Preserve patch semantics, fix exact versions, and keep the two source/bundle acceptance boundaries separate.
- Credentials and secrets live only in ignored runtime environment, never in catalog, manifests, or snapshots.
