# Plugin Anatomy

> **SOURCE OF TRUTH.** This file is compiled by `lab sync-context` into `plugins/*/.dsh-lab/shared-context.md`. Edit here, not in plugin snapshots.

The standalone plugin repo layout and package contract. Grounded in design spec §5.2 and §11, and `research/deepseek-harness-plugin-lab.md`.

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

## Dependency split

- Harness/Cordis service packages live in `peerDependencies`; the exact instances used for build/test are duplicated in `devDependencies`.
- Use only public npm APIs in production code — never import from an upstream Harness checkout (`upstream/deepseek-harness`).
- Keep a single scoped Harness Cordis peer boundary; avoid pulling in a second upstream Cordis instance. [РЕКОМЕНДАЦИЯ]

## Boundaries

- External resources are acquired inside `ctx.effect()` and return a disposer (see `cordis-model.md`).
- Network/persistent emissions are non-revertible; document them and add application-level compensation where needed.
- A simple tool plugin stays one package. Split a capability into Definition/Provider/Consumer only when the roles are independently swappable or change separately.
