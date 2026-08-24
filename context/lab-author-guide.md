# dsh-lab — author guide

The plugin laboratory (`dsh-lab`) is a meta-repo that teaches and verifies how to
author **external** DeepSeek Harness plugins that ship as installable bundles.
This guide is for plugin authors working inside the lab.

## First-slice agent contract

The lab is a forge used by an agent and its harness. The supported entry points
are:

```text
lab inspect <name>|--path P [--json]
lab dev <name>|--path P --target T
lab verify <name>|--path P --target T [--json]
lab status <name>|--path P [--json]
lab ui start <name>|--path P --target T [--json]
lab ui status <session-id> [--json]
lab ui finish <session-id> --verdict pass|fail --summary "..." [--json]
lab ui abort <session-id> [--json]
```

`dev` is live/in-place read-only: it reads the plugin's current source and puts
profiles and overlays under the lab root's `.lab/runtime`, never in the plugin.
Current uncommitted and untracked files are included in verification. `verify`
uses a temporary workspace and always removes it, while finalized evidence is
minimal forge memory rather than a second working tree. Catalog lookup is
optional; `init`/initialization is optional as well. Only explicit authoring
commands mutate plugin repositories. The portable agent entrypoint is the
hand-authored `.agents/skills/dsh-plugin-development/SKILL.md`. It is advisory
guidance for the agent, not workflow-state or UI enforcement. `pnpm lab
sync-context` regenerates only the plugin shared-context snapshots; `pnpm lab
doctor` reports missing or stale snapshots without writing them.

The `lab ui start/status/finish/abort` family is separate from `verify`: it owns
only a temporary isolated runtime and factual lifecycle/evidence. An external
browser or vision agent/harness owns navigation, interaction, and visual meaning.
Screenshots and browser artifacts are transient and not retained by the lab; the
final record is a minimal verdict, short summary, and captured identities.

> Scope note. Everything here is against the **pinned** revision of upstream
> DeepSeek Harness recorded in `workbench/compatibility.yaml`. DeepSeek Harness
> is a developer preview whose API can change; never assume `master` is stable.
> Do not ship recommendations in this guide as upstream contract.

## Layout

```
dsh-sandbox/
├── context/                 root context library (shared snapshots derive from here)
├── workbench/compatibility.yaml   target pins: next (rc.2), master (commit), node, pnpm
├── catalog.yaml             index of every plugin in the lab (path / tracking / maturity)
├── plugins/<name>/          a standalone nested repo per plugin
├── upstream/deepseek-harness  pinned master submodule (Task 8)
├── tooling/                 the lab CLI source
└── context/lab-author-guide.md  this guide
```

Every plugin lives in its own **nested git repo** (`plugins/<name>`). The parent
meta-repo deliberately does **not** track plugin internals; only `catalog.yaml`
is committed in the parent. `tracking: local` keeps the plugin as an independent
nested repo; `tracking: submodule` pins an external repository + commit (see the
elevation recipe below).

## The six command families

| Command | What it does |
|---|---|
| `pnpm lab new <name>` | Scaffold a standalone plugin repo from `templates/plugin`, write `.dsh-lab/plugin.yaml`, append a `catalog.yaml` entry. |
| `pnpm lab dev <name>\|--path P --target next\|master` | Read live source, emit a **source overlay** (`cordis.patch.yml`), materialize a pinned profile, and boot `dsh` against it watching source for HMR. |
| `pnpm lab verify <name>\|--path P --target next\|master\|all` | Copy the current source, build + pack the bundle in a temporary workspace, install the tarball via the real `dsh plugin add`, and assert the composed `--dump-config` contains the plugin. |
| `pnpm lab sync-context [name\|--all]` | Regenerate `.dsh-lab/shared-context.md` snapshots inside each plugin repo from `context/`, embedding a content hash. The agent skill is hand-authored and not regenerated. |
| `pnpm lab doctor` | Validate toolchain, catalog, target pins, context-snapshot freshness, and the upstream submodule (present + pinned to `master.commit` + clean). Exit 0 only when green. |
| `pnpm lab upstream check\|update [--verify]` | Read-only compare the pinned `master` SHA, or explicitly adopt it with clean-tree gates, detached checkout, doctor, and optional full plugin verification. |

`upstream check` exits `0` when current, `2` when an update is available, and
`1` on configuration/network errors. `upstream update` never commits, pushes,
merges, resets, cleans, or rolls back; a failed adopted candidate remains
visible for inspection.

## Recipe: scaffold a new plugin

```bash
pnpm lab new my-plugin     # creates plugins/my-plugin + catalog entry
cd plugins/my-plugin
pnpm install --config.minimumReleaseAge=0 --config.strictDepBuilds=false
pnpm typecheck && pnpm test
```

`lab new` writes `.dsh-lab/plugin.yaml` declaring the plugin's declared targets
(e.g. `targets: [next]`), registers a `catalog.yaml` entry (`tracking: local,
maturity: experiment`), and scaffolds a self-contained `package.json` with the
runnable dev deps needed to `install`/`typecheck`/`test` on its own. Add a target
there before expecting `dev`/`verify` to accept it for that target.

## Recipe: `lab dev` — iterate on live source

```bash
pnpm lab dev my-plugin --target next
```

This writes a source overlay to `.lab/runtime/overlays/my-plugin/cordis.patch.yml`
and boots the pinned `next` profile with `--patch <overlay>`. The overlay both
inserts your `src/index.ts` and re-enables Cordis module HMR with a module `root`
pointing at the plugin's `src/` dir, so an edit there is watched and the running
instance reloads. The entry is emitted as a `file:` URL and the child runtime
loads `tsx/esm`, so Windows drive paths and full TypeScript/ESM source imports
remain valid. The stable runtime profile is named `<plugin>-<target>-dev`.

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
config. This is the packaged-bundle path. Master composes against the **built**
pinned upstream (`apps/cli/lib/bin.js`), never a profile-local install.
Each target run uses a unique `<plugin>-<target>-verify-<run-id>` profile and
cleans it up in a `finally` block. Target-specific `allowBuilds` policy is
materialized from `workbench/compatibility.yaml`; it is not written into the
plugin repository. Plugin installs use the plugin-local `pnpm-workspace.yaml`
boundary with `--ignore-workspace`, so a parent workspace cannot capture them.

## Recipe: `lab sync-context` — refresh shared context

```bash
pnpm lab sync-context --all        # refresh every plugin's snapshot
pnpm lab sync-context my-plugin    # just one
```

Each run embeds a `context version: <12-hex>` hash of `context/*.md` into a
plugin's `.dsh-lab/shared-context.md`. If the root context changes, re-sync so
plugins see current guidance; the hash lets you notice staleness at a glance.
The portable agent skill `.agents/skills/dsh-plugin-development/SKILL.md` is
hand-authored and outside this command's scope. Doctor reports missing or stale
snapshots without repairing them; run `pnpm lab sync-context` to resolve that
drift.

## Recipe: elevate a plugin from local to submodule

There is no `lab promote` command yet; this is a manual, careful transition.

1. Decide the submodule source — practically a fork/standalone repo you control,
   because the plugin must be self-sufficient (its own `package.json`,
   self-contained `tsconfig.json`, committed lockfile and `shared-context.md`).
2. Register a remote on the **existing nested repo** and push it (this keeps the
   full history and the committed `shared-context.md`):
   ```bash
   git -C plugins/<name> remote add origin <url>
   git -C plugins/<name> push -u origin HEAD
   ```
3. The parent does **not** track the local plugin's internals (`tracking: local`),
   so there is nothing to `git rm -cached`. Snapshot the reviewed commit, then
   remove the nested working copy so `git submodule add` can take the path. The
   parent ignores `plugins/*`, so the add must be forced (`-f`) to record the
   gitlink at the otherwise-ignored path:
   ```bash
   HEAD=$(git -C plugins/<name> rev-parse HEAD)
   rm -rf plugins/<name>
   git submodule add -f <url> plugins/<name>      # from the parent root (-f: path is gitignored)
   git -C plugins/<name> checkout "$HEAD"          # pin the reviewed commit
   ```
4. Update `catalog.yaml` for the plugin: `tracking: submodule` **and** the
   required `repository: <url>` (a `submodule` entry without `repository` fails
   the catalog schema). Keep `maturity` as-is. The parent commit then records the
   submodule gitlink + the updated catalog entry; push both repos.
5. Re-run `pnpm lab doctor` and `pnpm lab verify <name> --target all` from the
   parent to confirm the submodule path still resolves and the pinned commit is
   clean.

> Only ever track reviewed, pinned source. Commit `prepare`/build scripts run on
> the author's machine; pin commits and review before trusting a submodule.

## Troubleshooting

### Stale shared context

`shared-context.md` carries an explicit `context version:` hash. When the root
`context/*.md` moves on but a plugin's snapshot is old, the hash won't match —
and `lab doctor` now flags it: `stale shared context for plugin '<name>'`.
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

Both `lab doctor` and `verify --target master` require the pinned upstream
checkout at `upstream/deepseek-harness` whose HEAD equals `compat.targets.master.commit`
(enforced by `verifyUpstreamCommit`). Doctor reports **errors** (exit 1) for a
missing upstream, a HEAD that does not match the pinned commit, or a dirty
working tree; a mismatched/missing/dirty upstream also throws a prerequisite
error in `verify` and refuses to report a master pass — **fix or skip, don't
fake**. To fix: `git -C upstream/deepseek-harness status`, then restore the pin or
stash/restore your working tree before verifying and running doctor again.

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
- `pnpm test` — 31 passed
- `pnpm lab doctor` — clean, exit 0 (node pin, catalog, context snapshots, pinned
  upstream submodule, upstream clean)
- `pnpm lab verify example --target all` — next **and** master both pass
- **Fresh scaffold** `lab new demo` — install → typecheck → test (1 real lifecycle
  test) → build all pass standalone
- **Standalone clone** of `plugins/example` (install → typecheck → 3 tests → build →
  pack) — all pass without the meta-repo
- **`lab dev`** emits an overlay that re-enables Cordis module HMR with a module
  `root` at the plugin's `src/` (asserted by unit test); a live reload boot was not
  re-run (it binds a running web server)
