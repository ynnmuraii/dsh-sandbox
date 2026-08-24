---
name: dsh-plugin-development
description: Use when creating, studying, debugging, or verifying a DeepSeek Harness plugin in dsh-lab.
---

# DSH Plugin Development

This is the agent-owned forge for creating, studying, debugging, and verifying independent DeepSeek Harness plugins. Keep shared rules in the canonical context, keep plugin implementation in its standalone repository, and collect evidence at both integration boundaries so a fast local loop does not masquerade as a packaged release.

## When to use this skill

Use it when creating a plugin repository, changing plugin code, debugging a boot or HMR failure, running any `lab` command, or proving a plugin against a pinned target. When a command fails, jump straight to the matching section: [inspection diagnostics](#inspection-diagnostics), [UI session outcomes](#ui-session-protocol), or the troubleshooting recipes in the [lab author guide](../../../context/lab-author-guide.md).

## Canonical routing

| Concern | Canonical document |
| --- | --- |
| Public exports, patch layers, and API boundaries | [Harness contracts](../../../context/harness-contracts.md) |
| Fiber, effects, injection, and disposal | [Cordis model](../../../context/cordis-model.md) |
| Repository layout and package metadata | [Plugin anatomy](../../../context/plugin-anatomy.md) |
| Required behavior, lifecycle, and compatibility evidence | [Testing policy](../../../context/testing-policy.md) |
| Target claims and pinned compatibility | [Compatibility](../../../context/compatibility.md) |
| Authoring loop and lab commands | [Lab author guide](../../../context/lab-author-guide.md) |

## The loop at a glance

| Step | Command | Proves | A non-zero exit means |
| --- | --- | --- | --- |
| Inspect | `pnpm lab inspect <name>\|--path P --target T [--json]` | the repo satisfies the plugin contract for the target | typed contract violation — see the diagnostics table |
| Iterate | `pnpm lab dev <name>\|--path P --target T` | live source loads and hot-reloads under a real web composition | boot or source error — read it, fix it, repeat |
| Verify | `pnpm lab verify <name>\|--path P [--target T] [--json]` | the plugin's own checks pass and the packed tarball installs against the pin | own-check failure or target/compatibility violation |
| Status | `pnpm lab status <name>\|--path P [--json]` | which evidence is current, stale, or missing | stale or missing evidence for the target |
| UI session | the four verbs in the [UI session protocol](#ui-session-protocol) | a real browser-facing lifecycle plus a verdict | crashed, stale, fail, or cleanup-incomplete outcome |

Every command takes a catalog name or `--path P` for an external standalone repo. `--json` reserves stdout for exactly one machine-readable document and sends progress to stderr. Exit `0` is success, `2` is a valid non-pass outcome (stale, crash, fail, cleanup-incomplete), and `1` is misuse, corruption, unsafe input, or tooling failure.

## Recommended loop

Before production code, read the relevant canonical contracts and the [lab author guide](../../../context/lab-author-guide.md). Use the smallest useful loop: `pnpm lab inspect <name> --target <target>`, then `pnpm lab dev <name> --target <target>` while iterating, `pnpm lab verify <name> --target <target>` before handoff, and `pnpm lab status <name>` to distinguish current, stale, and missing evidence and summarize repository state. Use `--path` for an external standalone plugin.

`inspect` fails closed with typed diagnostics; fix them before `dev`, `verify`, or `ui start`.

## Inspection diagnostics

`inspect` never mutates the plugin; it reports typed diagnostics that name the missing contract:

| Diagnostic | Missing contract |
| --- | --- |
| `PACKAGE_NOT_ESM` / `EXPORT_MISMATCH` | `type: "module"`, with `main`/`types` matching the root `exports` entries |
| `PACKAGE_MANAGER_MISMATCH` | an exact `pnpm@<version>` pin in `packageManager` |
| `LOCKFILE_MISSING` / `WORKSPACE_BOUNDARY_MISSING` | a committed `pnpm-lock.yaml` and a standalone `pnpm-workspace.yaml` |
| `SCRIPT_MISSING` | the required scripts: `typecheck`, `test`, `build`, `pack-smoke` |
| `BUNDLE_PATCH_MISSING` | `dsh.bundle.patch` naming a patch file that exists inside the repo |
| `FILES_COVERAGE_MISSING` | `files` entries covering `main`, `types`, and the bundle patch |
| `DEPENDENCY_PIN_MISMATCH` | `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` pinned in both `peerDependencies` and `devDependencies` exactly as `workbench/compatibility.yaml` pins the target |
| `PRIVATE_UPSTREAM_IMPORT` | production code importing an upstream checkout instead of public npm APIs |

## Source overlay vs packed bundle

Treat source overlay and installable bundle as separate acceptance boundaries. Source mode proves live source behavior and HMR against a fixed checkout; bundle mode proves the packed package installs and boots. Test both when the change affects either boundary. A source-mode pass never substitutes for bundle proof, and vice versa.

## Dual-face (browser) plugins

A plugin with `dsh.client` adds a browser face — `exports["./client"] → lib/client.js` (§ contracts). Detect it by `package.json: dsh.client.platform === "web"`; if present the tarball must contain the built `lib/client.js`.

- **Build before boot:** `lab ui start` bundle-mode installs the packed tarball, so `pnpm run build` must have produced `lib/client.js` as a classic script that synchronously calls `window.__ModuleLoader__.load({ id, factory })` (an ESM output fails the client-smoke gate with `loaded without registering`).
- **Prove the browser face:** after `pnpm lab ui start … --target next` and the browser loads the loopback URL, read `window.__DSH_BOOT__.entries` (injected by the host, `rev` is the content hash) and assert an entry with `id === package name` exists and its fetch → registration succeeds; the source overlay does not prove this.
- **Keyless headless onboarding:** the browser-host RPC envelope is `POST` to `api/<method>` with JSON body `{ type: "client-request", rpcId, method, payload }` (upstream `packages/host/apiproxy/src/api/rpc.ts:ClientRequest`, `rpc-map.ts` keys `workspace.create` / `session.create`). For automation without credentials, `fetch` that envelope from the booted host to create a workspace/session; `rpcId` is client-minted and echoed in the `server-response`.
## HMR safety

Every registry, listener, adapter, and external resource must be HMR-safe: register through the contributing Fiber, acquire resources inside `ctx.effect()` with a disposer, and prove cleanup on unload. Keep order-dependent asynchronous teardown in one disposer that awaits each step. Declare mandatory services with `inject`; resolve optional services only at their point of use. A manual `ctx.plugin()` unit test never replaces a Loader/app/process smoke for a product-visible plugin.

## UI session protocol
For browser-facing checks, use the separate protocol:

```text
pnpm lab ui start <name>|--path P --target next|master [--json]
pnpm lab ui status <session-id> [--json]
pnpm lab ui finish <session-id> --verdict pass|fail --summary "..." [--json]
pnpm lab ui abort <session-id> [--json]
```

The lab owns only the temporary isolated session runtime and its factual
cleanup/evidence boundary. An external browser or vision agent/harness chooses
navigation and interactions and decides what the visual result means. Screenshots
and browser artifacts are transient and not retained; finalized evidence is only
a minimal verdict/result, short summary, and identities. SDD, TDD, planning,
orchestration, and agent-browser are advisory recommendations, never required
tools or workflows.

| Outcome | Meaning | What to do |
| --- | --- | --- |
| `ready` | DSH announced a loopback URL and the process tree is alive | hand the URL to the browser/vision agent; it owns the visual judgment |
| `starting` | the supervisor exists but DSH is not ready yet | poll `ui status`; a bounded startup failure lands in `crashed` |
| `crashed`, live recovery owner | startup or running DSH died; the supervisor still polls controls | `finish --verdict fail` or `abort` both work |
| `crashed`, orphaned (`orphan: true` in `--json`) | no process left to consume controls | remove the named session directory manually — `abort` cannot complete |
| `stopping` | a finish or abort control is being processed | wait; the finisher publishes evidence after cleanup |
| `stale`, latched | `plugin-changed`, `context-changed`, or `target-changed` observed | start a new session; reverting files never un-stales a latched one |
| cleanup failure | forge-owned runtime remained unaccounted | the runtime is preserved for diagnosis; then abort or remove it manually |

`finish --verdict pass` requires a `ready` session and publishes only after complete runtime cleanup; cleanup failure preserves the runtime and never fabricates a `pass`. On Windows, transient `EPERM`/`EACCES` during cleanup is retried automatically; only a persistent failure becomes cleanup-incomplete.

## Common mistakes

- Skipping `inspect` and debugging `dev` boot errors that are really contract violations — run `inspect` first and fix what it names.
- Treating a source-overlay pass as bundle proof, or skipping the lifecycle test because the plugin "only registers a tool".
- Running `abort` on an orphaned crash — the control is never consumed and the command always ends in cleanup-incomplete.
- Reverting edited files to rescue a stale session — stale reasons latch permanently; start a new session.
- Expecting a `pass` while runtime residue exists — publication is refused until cleanup accounts for every forge-owned file.
- Writing credentials into manifests, catalog, or snapshots — secrets live only in ignored runtime environment.

SDD, TDD, planning, review, and orchestration are advisory workflows chosen by the agent and host harness: use them to clarify seams, risks, evidence, and ownership, but let the canonical contracts and tests decide behavior. Prefer a narrow red-green cycle and review the resulting diff independently.

## Boundaries

Only explicit authoring commands may mutate plugin repositories. Never manufacture plugin state during inspection or synchronization. Keep credentials and secrets in ignored runtime environment only. Release a plugin as its own repository with its own versioning, package, tests, and publication decisions; the meta-repo does not publish it. Production code imports public npm APIs only, never files from an upstream Harness checkout.

Plans, approvals, and session memory belong to the agent and host harness, never to `.lab/runtime`; the lab keeps runtime descendants and factual verification evidence only.
