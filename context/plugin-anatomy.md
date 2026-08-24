# Plugin Anatomy

> **SOURCE OF TRUTH.** This file is compiled by `lab sync-context` into `plugins/*/.dsh-lab/shared-context.md`. Edit here, not in plugin snapshots.

The standalone plugin repo layout and package contract. Grounded in upstream Harness package conventions and the pinned revision.

## Standalone repo layout

```text
plugin-repo/
├─ AGENTS.md
├─ .dsh-lab/
│  ├─ plugin.yaml
│  └─ shared-context.md
├─ src/
│  └─ index.ts
├─ tests/
├─ cordis.patch.yml
├─ package.json
├─ pnpm-lock.yaml
├─ tsconfig.json
└─ README.md
```

The plugin repo owns implementation, bundle patch, manifest, tests, dev deps and peer ranges, CI, versioning/changelog, and publication. The meta-repo does not.

## Package manifest contract

- ESM package (`"type": "module"`).
- Unambiguous `main`/`exports` and declarations.
- `files` includes only the artifacts needed at install.
- `dsh.bundle.patch` points at the bundle patch.
- Function plugin: named exports `name`, `inject`, `Config`, `apply`; no default export.

## Dual-face package (host + browser)

A dual-face plugin adds a browser face to the host package (upstream `packages/client/modules/src/index.ts`, `packages/client/modules/src/client/system.ts`):

```text
package.json  { "dsh": { "client": { "platform": "web" } }, "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" } }
src/index.ts       → lib/index.js   (loader entry, Cordis `name`/`inject`/`apply`)
src/client/**      → lib/client.js  (browser face; built with the shared tsdown client preset)
cordis.patch.yml   loader row patch (same `name` governs host lifecycle; `dsh.client` governs browser graph membership)
```

- `dsh.client` + `exports["./client"]` is the dual-face marker (see `harness-contracts.md#client-face`). The built `lib/client.js` is the artifact served at `/plugins/<id>/client.js`.
- **Bundle format:** the client bundle must be a classic script that synchronously calls `window.__ModuleLoader__.load({ id, factory })`. The vendored Loader calls `factory` synchronously at materialization; an ESM output (top-level `import`/`export`) loads without registering and fails `loaded without registering "id" via __ModuleLoader__.load` (`client/system.ts:arrive`).
- **Pack boundary:** `files` must list the built `lib/client.js` (and map). `pnpm pack` is the browser boundary — a source-only `lib/` produces a tarball that fails the lab `client-smoke` gate; `pnpm pack --json` under pnpm 11 emits a single object `{ name, version, filename, files }` (`tooling/src/package-verify.ts:resolvePackedTarball`).

## Dependency split

- Harness/Cordis service packages live in `peerDependencies`; the exact instances used for build/test are duplicated in `devDependencies`.
- Use only public npm APIs in production code — never import from an upstream Harness checkout (`upstream/deepseek-harness`).
- Keep a single scoped Harness Cordis peer boundary; avoid pulling in a second upstream Cordis instance. [РЕКОМЕНДАЦИЯ]

## Boundaries

- External resources are acquired inside `ctx.effect()` and return a disposer (see `cordis-model.md`).
- Network/persistent emissions are non-revertible; document them and add application-level compensation where needed.
- A simple tool plugin stays one package. Split a capability into Definition/Provider/Consumer only when the roles are independently swappable or change separately.
