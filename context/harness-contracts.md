# Harness Contracts

> **SOURCE OF TRUTH.** This file is compiled by `lab sync-context` into `plugins/*/.dsh-lab/shared-context.md`. Edit here, not in plugin snapshots.

Public plugin contracts of DeepSeek Harness. Grounded in upstream Harness contracts and the pinned revision.

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
- `dsh.bundle.patch` (bundle manifest) declares the bundle's patch file; `dsh.profile.bundles` (profile manifest `package.json`) is the ordered layer list — `apps/cli/README.md:Profiles`, `docs/user/develop/basic/publish.md:Two concepts`.
- `dsh.profile.bundles` names are two-anchored: resolved from the dsh installation first, then the profile's `node_modules` (`apps/cli/README.md:Bundles named … resolve from the dsh installation first`).
- Use `--dump-config` to inspect the final tree.
- Keep loader entry `id` stable.
## Client face (`dsh.client`)

Dual-face = host entry (`src/index.ts` → `lib/index.js`) + browser bundle (`src/client/**` → `lib/client.js`). Enabled by `package.json` (upstream `packages/client/modules/src/index.ts:parseDshClient`, `clientExportOf`):

```json
{ "dsh": { "client": { "platform": "web" } }, "exports": { "./client": "./lib/client.js" } }
```

- `dsh.client.platform` must be `"web"`; otherwise the package is not a client row.
- `dsh.client.inject` / `external` if present must be string arrays; `immediately` if present must be boolean (`index.ts:parseDshClient` → `client/manifest.ts:optionalStringArray`).
- `exports["./client"]` is required — string or `{ default: string }` — and resolves to `clientPath` (`clientExportOf`). Missing export throws `dsh.client but exports no "./client" bundle` and the composition fails (`MissingClientBundleError`).
- **Wire:** host composes `window.__DSH_BOOT__` (`WebBootGraph` `{ rev, entries: [{ id, url, rev, inject?, immediately?, external? }] }`) and injects a `window.__ModuleLoader__` queue (`index.ts:bootInjections`). The browser bundle must be a classic script that **synchronously** calls `window.__ModuleLoader__.load({ id, factory })` (`client/system.ts:arrive` asserts `factories.has(id)` else `loaded without registering "id" via __ModuleLoader__.load`).
- **Serving:** each entry at `/plugins/<id>/client.js?rev=<hash>` and source map at `/plugins/<id>/client.js.map` (`index.ts:graphRow`, `serveBundle`); `rev = sha1(bundle).slice(0,12)` (`shortHash`); both served `cache-control: no-cache`.
- `package.json` `files` must include the built client artifact (`lib/client.js` + map); the tarball is the browser boundary — see `plugin-anatomy.md`.
- Browser acceptance of a dual-face plugin is proved only by a real boot: `lab ui start --target next` in bundle-mode (the lab installs the built plugin package as a `file:` profile dependency and boots the extended `dsh.profile.bundles` layer). Source overlay (`--patch`) does not prove the client bundle ships or registers.

## Boundaries

- DeepSeek Harness is a developer preview with compatibility-breaking changes: fix Harness revision, vendored Cordis commit, Node/pnpm, and run mode (see `compatibility.md`).
- Plugins import only public npm APIs — never files from an upstream checkout.
