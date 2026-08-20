# dsh-lab — author guide

The plugin laboratory (`dsh-lab`) is a meta-repo that teaches and verifies how to
author **external** DeepSeek Harness plugins that ship as installable bundles.
This guide is for plugin authors working inside the lab.

> Scope note. Everything here is against the **pinned** revision of upstream
> DeepSeek Harness recorded in `workbench/compatibility.yaml`. DeepSeek Harness
> is a developer preview whose API can change; never assume `master` is stable.
> Do not ship recommendations in this guide as upstream contract.

## Layout

```
dsh-sandbox/
├── context/                 root context library (shared snapshots derive from here)
├── workbench/compatibility.yaml   target pins: next (rc.8), master (commit), node, pnpm
├── catalog.yaml             index of every plugin in the lab (path / tracking / maturity)
├── plugins/<name>/          a standalone nested repo per plugin
├── upstream/deepseek-harness  pinned master submodule (Task 8)
├── tooling/                 the lab CLI source
└── docs/using-the-lab.md    this guide
```

Every plugin lives in its own **nested git repo** (`plugins/<name>`). The parent
meta-repo deliberately does **not** track plugin internals (`tracking: local` is
the only mode today); only `catalog.yaml` is committed in the parent.

## The five commands

| Command | What it does |
|---|---|
| `pnpm lab new <name>` | Scaffold a standalone plugin repo from `templates/plugin`, write `.dsh-lab/plugin.yaml`, append a `catalog.yaml` entry. |
| `pnpm lab dev <name> --target next\|master` | Emit a **source overlay** (`cordis.patch.yml`) that points at the plugin's `src/index.ts`, materialize a pinned profile, and boot `dsh web` against it watching source for HMR. |
| `pnpm lab verify <name> --target next\|master\|all` | Build + pack the bundle, install the tarball into an ephemeral profile via the real `dsh plugin add`, and assert the composed `--dump-config` contains the plugin. |
| `pnpm lab sync-context [name\|--all]` | Regenerate `.dsh-lab/shared-context.md` snapshots inside each plugin repo from `context/`, embedding a content hash. |
| `pnpm lab doctor` | Validate toolchain, catalog, target pins (node version, manifest, upstream git dir). Exit 0 only when green. |

## Recipe: scaffold a new plugin

```bash
pnpm lab new my-plugin     # creates plugins/my-plugin + catalog entry
cd plugins/my-plugin
pnpm install --config.minimumReleaseAge=0 --config.strictDepBuilds=false
pnpm typecheck && pnpm test
```

`lab new` writes `.dsh-lab/plugin.yaml` declaring the plugin's declared targets
(e.g. `targets: [next]`). Add a target there before expecting `dev`/`verify` to
accept it for that target.

## Recipe: `lab dev` — iterate on live source

```bash
pnpm lab dev my-plugin --target next
```

This writes a source overlay to `.lab/runtime/overlays/my-plugin/cordis.patch.yml`
and boots the pinned `next` profile with `--patch <overlay>`, watching your source
for HMR. Type-code, save, and watch the running instance reload.

- Source mode proves your **live source** behaves; it does **not** prove the
  packed bundle works. Keep the two boundaries separate (see `lab verify`).
- `dev` binds a running web server. Use it interactively; for a non-interactive
  gate use `lab verify` (never binds a port).

## Recipe: `lab verify` — gate the packaged bundle

```bash
pnpm lab verify my-plugin --target next     # against rc.8
pnpm lab verify my-plugin --target master   # against pinned master source
pnpm lab verify my-plugin --target all      # both
```

`verify` proves the plugin (1) builds, (2) packs to a tarball, (3) installs as an
**active profile bundle** through the real `dsh plugin add` + `dsh.bundle.patch`
reconciliation, and (4) its patch layer is observable in the composed profile
config. This is the publish-tutorial path. Master composes against the **built**
pinned upstream (`apps/cli/lib/bin.js`), never a profile-local install.

## Recipe: `lab sync-context` — refresh shared context

```bash
pnpm lab sync-context --all        # refresh every plugin's snapshot
pnpm lab sync-context my-plugin    # just one
```

Each run embeds a `context version: <12-hex>` hash of `context/*.md` into a
plugin's `.dsh-lab/shared-context.md`. If the root context changes, re-sync so
plugins see current guidance; the hash lets you notice staleness at a glance.

## Recipe: elevate a plugin from local to submodule

There is no `lab promote` command yet; this is a manual, careful transition.

1. Decide the submodule source — practically a fork/standalone repo you control,
   because the plugin must be self-sufficient (its own `package.json`,
   self-contained `tsconfig.json`, committed lockfile and `shared-context.md`).
2. `git -C plugins/<name> remote add origin <url>` then `git push -u origin HEAD`.
3. Remove `plugins/<name>` from the parent working tree and re-add it as a
   submodule pinned to the reviewed commit:
   ```bash
   git -C ../.. rm --cached plugins/<name>
   git submodule add <url> plugins/<name>
   ```
4. Update `catalog.yaml` `tracking: local -> submodule` for the plugin; keep
   `maturity` as-is. Commit the parent (submodule + catalog) and push both repos.
5. Re-run `pnpm lab doctor` and `pnpm lab verify <name> --target all` from the
   parent to confirm the submodule path still resolves.

> Only ever track reviewed, pinned source. Commit `prepare`/build scripts run on
> the author's machine; pin commits and review before trusting a submodule.

## Troubleshooting

### Stale shared context

`shared-context.md` carries an explicit `context version:` hash. When the root
`context/*.md` moves on but a plugin's snapshot is old, the hash won't match.
Fix:

```bash
pnpm lab sync-context --all
git -C plugins/<name> add .dsh-lab/shared-context.md
git -C plugins/<name> commit -m "chore: refresh shared context snapshot"
```

### Version mismatch

`lab doctor` and `lab verify` compare the running toolchain against
`workbench/compatibility.yaml`:

- **Node**: `next.node` is pinned to `22.20.0`. Run `node --version`; if your host
  differs, doctor reports `node version mismatch: manifest pins 22.20.0, running X`.
  Install the pinned node (or record a **deliberate, documented pin change** in
  `compatibility.yaml` — never edit the pin silently).
- **Cordis / dsh**: `next.cordis`/`next.dsh` and `master.commit` are the pinned
  boundaries. A mismatch usually means the pinned dsh/cordis changed; do not chase
  upstream — record the deviation as a deliberate choice instead.

### Dirty or missing upstream submodule

`verify --target master` requires the pinned upstream checkout at
`upstream/deepseek-harness` whose HEAD equals `compat.targets.master.commit`
(enforced by `verifyUpstreamCommit`). A mismatched or missing checkout throws a
prerequisite error and refuses to report a master pass — **fix or skip, don't
fake**. If your local upstream working tree is dirty, `git -C upstream/deepseek-harness status`
and stash/restore before verifying.

### Master build failure on Windows

Upstream's native deps (node-pty, koffi, …) can fail to build on some Windows
toolchains. If `pnpm lab verify my-plugin --target master` cannot build the pinned
upstream on your host:

1. Confirm the failure is environmental (toolchain) and not a source regression —
   capture the build error.
2. Keep the `next` packed-bundle result as your local acceptance evidence, and
   record the master result as **blocked by environment**, linking to the last
   recorded master PASS (e.g. Task 10's) rather than inventing a fresh pass.
3. The lab's own master evidence is recorded from a real build in Task 10; rely on
   that recorded PASS and note that you did not re-run it on this host.

### `dev` surfaces a boot error for master

If the master profile does not yet have dsh installed, a `dev --target master`
boot can fail — that is an expected scaffolding-stage failure (asserted by the
Task 9 e2e test), not a plugin bug. Use `--target next` for active source
iteration, and `verify` for the master gate.

## Verification status of this guide (Task 11)

All gates below ran green on this host (Windows, node v22.20.0 = the pinned
`22.20.0`):

- `pnpm typecheck` — 0 errors
- `pnpm test` — 21 passed
- `pnpm lab doctor` — clean, exit 0
- `pnpm lab verify example --target all` — next **and** master both pass
- **Standalone clone** of `plugins/example` (install → typecheck → test → build →
  pack) — all pass without the meta-repo
