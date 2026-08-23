# Agent-First DSH Plugin Forge

## Status

Design approved in conversation for the forge model and its first vertical
slice. This document is the source for a separate implementation plan.

## Purpose

`dsh-lab` is an agent-first forge for developing local DeepSeek Harness
plugins. Its primary operator is an already-running agent hosted by Codex, Pi,
DSH, or another harness. The lab does not provide its own agent runtime,
planner, task queue, or development methodology.

The external agent owns reasoning, planning, editing, delegation, and choice of
development process. The forge supplies DSH-specific knowledge, deterministic
operations, isolated target environments, diagnostics, and factual memory of
verification runs.

The forge produces a local plugin repository plus current verification
evidence. Remote creation, push, publication, and release automation are out of
scope and must not be anticipated by unused abstractions.

## Product boundary

### DSH-specific target, host-neutral operator

The forge deeply understands DSH plugin contracts and pinned DSH targets. It
must not depend on features unique to Codex, Pi, or DSH as the agent host. Its
portable interfaces are files, Markdown, process execution, exit codes, and
JSON.

The only agent skill projection is:

```text
.agents/skills/dsh-plugin-development/SKILL.md
```

`context/*` remains the source of truth. The skill will later be generated from
that context; no `.dsh`, `.codex`, root `skills/`, or other mirrors are added.
Skill generation is a later implementation slice, not part of the first slice
defined below.

### Environment, not orchestrator

The forge may recommend spec-driven development for non-trivial plugins, but it
does not require or track specs, plans, approvals, stages, or task status. Those
belong to the external agent and its host harness.

The forge must never store fields such as `currentStage`, `specApproved`, or
`readyForImplementation`. Forge status is derived from plugin contents,
declared technical metadata when present, and verification results.

### Local-only completion boundary

The terminal product is:

1. a standalone local plugin repository;
2. reproducible plugin-owned tests and package contracts;
3. local machine-readable evidence describing what the forge actually ran.

The forge does not create remotes, push commits, publish packages, or manage
releases.

## Responsibility model

| Owner | Responsibilities |
|---|---|
| External agent | Understand the request, choose methodology, design, edit code, interpret diagnostics, and decide what to run next. |
| Agent host | Provide reasoning, skills, browser/vision tools, delegation, approvals, and session lifecycle. |
| Plugin repository | Own source, package manifest, lockfile, tests, build scripts, bundle patch, optional `.dsh-lab/plugin.yaml`, and Git history. |
| Forge | Resolve plugins, inspect contracts, create temporary environments, run deterministic checks, manage pinned DSH profiles, and record minimal evidence. |
| Human | State intent and review the local result; no release responsibilities are modeled in this design. |

## Mutation boundary

Only explicit authoring commands may change a plugin repository:

```text
lab new
lab init
lab sync-context
```

All diagnostic and execution commands are product-read-only:

```text
lab inspect
lab dev
lab verify
lab status
lab ui start|status|finish|abort
lab doctor
```

Product-read-only means these commands must not edit manifests, create a
lockfile, install `node_modules`, format source, write build output, or update
lab metadata inside the source plugin repository. They may write only to the
root forge runtime and evidence directories.

`lab dev` reads live plugin files for HMR. `lab verify` operates on a temporary
snapshot and never builds in the source repository.

## Path-first plugin model

### Resolution

Every plugin operation consumes one canonical `PluginRef`. A caller identifies
the plugin by exactly one of:

```text
lab verify <catalog-name>
lab verify --path A:/work/plugin
```

`PluginRef` contains at least:

- normalized absolute source path;
- package name read from `package.json`;
- optional catalog name and catalog entry;
- optional `.dsh-lab/plugin.yaml` metadata.

The catalog is a local inventory and alias table, not an authorization or
registration gate. `inspect`, `dev`, `verify`, and `status` must work for an
arbitrary standalone plugin path outside `plugins/` and outside the meta-repo.

The existing name-based CLI remains compatible and delegates to the same
resolver. Supplying both a catalog name and `--path`, supplying neither, a
missing directory, or a missing/unreadable `package.json` is an explicit
resolution error.

### Configuration precedence

Commands obtain required values in this order:

1. explicit CLI flags;
2. optional `.dsh-lab/plugin.yaml` values;
3. safe values inferred from `package.json` and package layout;
4. an error listing the unresolved values.

`lab init --path ...` is optional. It persists convenient forge metadata for
repeat work, but is never required before read-only inspection or an explicitly
configured `dev`/`verify` invocation.

## First vertical slice

The first implementation slice establishes this agent-facing loop:

```text
arbitrary local plugin repository
        -> lab inspect
        -> lab verify in a temporary isolated workspace
        -> minimal immutable result.json
        -> lab status
```

It also applies the shared path-first resolver to `lab dev`. It does not
implement UI sessions or generate the portable agent skill.

## `lab inspect`

### Interface

```text
lab inspect <catalog-name> [--json]
lab inspect --path <path> [--json]
```

Inspection is read-only and does not execute plugin scripts or install
dependencies. It reports structural facts and diagnostics, including:

- package name, ESM mode, `main`, `types`, and `exports` coherence;
- `files` coverage for runtime artifacts and the DSH bundle patch;
- `dsh.bundle.patch` presence and referenced patch existence;
- exact `packageManager` declaration;
- standalone `pnpm-workspace.yaml` boundary;
- committed/present `pnpm-lock.yaml` requirement;
- required script presence for `typecheck`, `test`, `build`, and `pack-smoke`;
- DSH/Cordis peer and development dependency alignment when target metadata is
  available;
- production imports that point into an upstream checkout or another private
  source tree;
- inferred host/client faces and any face-specific package inconsistencies that
  can be determined without execution.

Text output is concise and actionable. `--json` writes a single JSON document
to stdout; incidental progress belongs on stderr. Diagnostics have stable codes,
severity, message, optional location, and optional remediation text.

Inspection may operate without `.dsh-lab/plugin.yaml`. Metadata-dependent
checks report `unknown` or `not-applicable` rather than forcing initialization.

## Temporary isolated verification workspace

### Not a persistent Git worktree

Verification uses a unique temporary filesystem workspace. It is conceptually
an isolated worktree, but it must include the agent's current uncommitted and
untracked working files. A Git worktree or `git archive HEAD` alone is therefore
incorrect.

The workspace is created with `mkdtemp` under the ignored forge runtime, for
example:

```text
.lab/runtime/verify/<run-id>/workspace/
```

It is temporary by contract. It is deleted in `finally` after both success and
failure. Before removal the forge stops every child process it owns and writes
the minimal run result. Failure to remove the workspace is a cleanup failure,
not a successful verification; the exact remaining path is reported.

### Snapshot contents

The snapshot represents current filesystem contents, not only the last commit.
It includes source, tests, manifests, lockfiles, build configuration, scripts,
and other plugin inputs.

It excludes forge/runtime and derived or unsafe content at minimum:

```text
.git/
node_modules/
.lab/
lib/
dist/
coverage/
.env
.env.*
```

Old build output is excluded so source-plane and bundle-plane checks cannot pass
from stale artifacts. Credential files are excluded because the first slice is
offline/headless and does not include a real-API lane.

Symlinks are copied only when their resolved target stays within the plugin
root. An external or unresolved symlink fails snapshot creation rather than
escaping the isolation boundary.

Snapshot traversal and digesting are deterministic: normalized relative path,
file type, and file bytes contribute to a SHA-256 plugin digest. Timestamps,
absolute source paths, `.git`, and excluded runtime/build files do not.

### Temporary policy materialization

Target-owned install policy such as `allowBuilds` may be materialized into the
temporary workspace or target profile. It is never written back to the plugin.
The original plugin manifest and lockfile remain byte-identical.

## `lab verify`

### Interface

```text
lab verify <catalog-name> [--target next|master|all] [--json]
lab verify --path <path> --target next|master|all [--json]
```

When metadata is absent, an explicit target is required. CLI flags override
optional plugin metadata. The existing catalog-name syntax remains supported.

### Pipeline

The canonical offline/headless pipeline is:

1. Resolve `PluginRef` and target selection.
2. Run structural inspection; stop before install on error diagnostics.
3. Create the unique temporary workspace.
4. Copy current plugin contents using the snapshot rules.
5. Compute and record the plugin digest.
6. Materialize temporary target-owned pnpm policy.
7. Run `pnpm install --ignore-workspace --frozen-lockfile` in the temporary
   workspace.
8. Run plugin-owned `typecheck` and `test` scripts.
9. Run plugin-owned `build`.
10. Pack the plugin and run its packed-bundle smoke against the produced
    tarball.
11. For each selected DSH target, create a unique target profile, install the
    tarball through the real DSH plugin path, and verify composition.
12. Write the run result, stop owned processes, and delete the temporary
    workspace in `finally`.

Every step records `pass`, `fail`, `blocked`, `skipped`, or `not-applicable`.
The first slice does not add UI or real-API verification to this pipeline.

The source repository must remain byte-for-byte unchanged by verification. A
test fixture records relevant source-tree content before and after a run to
enforce this boundary.

### Failures

A plugin test or compatibility failure is a valid failed verification result,
not an internal forge crash. Tooling/configuration failures are distinguished in
the JSON result. Text mode still exits non-zero in both cases and provides the
failing step and concise cause.

No operation resets, cleans, checks out, or otherwise rewrites plugin Git state.
No verification failure causes automatic source modification.

## Minimal verification memory

### Storage

Execution results belong to the forge, not the plugin repository:

```text
.lab/runs/<plugin-key>/<run-id>/result.json
```

`plugin-key` is stable for a normalized source path plus package identity and
safe for use as a directory name. Runs are immutable once finalized. Result
publication uses a temporary file plus atomic rename.

The first slice does not create reports, archives, screenshots, videos, DOM
dumps, or full environment captures. A failed step stores a concise sanitized
error summary, not credentials or a raw environment dump.

### Result shape

Each result records at least:

```json
{
  "schemaVersion": 1,
  "runId": "verify-...",
  "operation": "verify",
  "result": "pass",
  "plugin": {
    "packageName": "@scope/plugin",
    "sourcePath": "A:/work/plugin",
    "digest": "sha256:..."
  },
  "targets": {
    "next": {
      "dsh": "0.1.1-rc.2",
      "result": "pass"
    }
  },
  "lab": {
    "contextDigest": "..."
  },
  "environment": {
    "node": "22.20.0",
    "pnpm": "11.7.0",
    "platform": "win32"
  },
  "steps": [],
  "cleanup": "pass",
  "startedAt": "...",
  "finishedAt": "..."
}
```

The schema stores factual execution data only. It contains no chain of thought,
agent planning state, SDD status, approval state, or release state.

## `lab status`

### Interface

```text
lab status <catalog-name> [--json]
lab status --path <path> [--json]
```

Status resolves the current plugin, computes its current digest using the same
snapshot rules, reads finalized forge runs, and derives a factual view. It does
not write to the plugin and does not advance workflow stages.

For each recorded claim, status reports one of:

- `pass` or `fail` for a result matching current inputs;
- `stale` when plugin digest, target pin, or context digest changed;
- `not-run` when no relevant evidence exists;
- `not-applicable` only when that fact is safely known.

Text output is optimized for an agent or human scanning a terminal. `--json`
uses stable keys and includes explicit stale reasons.

Example:

```text
Plugin: @scope/plugin
Structure:      PASS
Bundle:         STALE - plugin content changed
DSH next:       STALE - target pin changed
DSH master:     NOT RUN
UI review:      NOT RUN
```

## `lab dev` path support

`lab dev` uses the shared `PluginRef` resolver and accepts a catalog name or
`--path`. It continues to read the live source directory for HMR and creates all
profiles, overlays, installs, and generated files under the root forge runtime.
It does not persist settings into an uninitialized plugin.

## UI verification boundary

UI verification is deliberately a later, separate protocol rather than a
`lab verify --ui` flag. The intended future commands are:

```text
lab ui start
lab ui status
lab ui finish
lab ui abort
```

The forge will create a temporary DSH profile, select a free port, return a URL
and session identifier, and manage process cleanup. The external agent chooses
its own visual/browser mechanism, including `agent-browser` or a vision-capable
agent supplied by its host harness.

The forge will store only a minimal agent-submitted verdict bound to plugin
digest and target pin. Screenshots and other visual working material remain the
responsibility of the agent host and are not persisted by default.

UI commands, session leasing, and verdict schema are not implemented by the
first slice.

## Agent entrypoint boundary

The future canonical entry flow is:

```text
AGENTS.md
  -> .agents/skills/dsh-plugin-development/SKILL.md
  -> lab CLI
```

The skill recommends an effective DSH plugin development loop but does not
enforce SDD or orchestrate agent work. Generated skill implementation and drift
checking are outside the first slice.

## Security and privacy

- Product-read-only commands never write inside the source plugin repository.
- Snapshot traversal rejects path escapes and external symlinks.
- Credentials and `.env*` files are not copied into offline verification.
- Evidence never records the complete process environment.
- Child processes receive only the environment required by the operation;
  secret handling for a later real-API lane requires a separate design.
- Commands use argument arrays rather than shell interpolation.
- Runtime and evidence paths are always descendants of the configured forge
  root and use unique run identifiers.

## Concurrency and cleanup

- Verify workspaces and target profiles are unique per run.
- Multiple verify runs may execute concurrently without sharing mutable
  profiles or install directories.
- Each run owns and terminates its child processes.
- Cleanup executes in `finally` on success, plugin failure, tooling failure, and
  interruption paths that the process can handle.
- Evidence publication is atomic and occurs once per finalized run.
- An undeletable temporary workspace makes cleanup fail visibly with its exact
  path; it is never silently treated as a successful temporary run.

## Compatibility and migration

The first slice preserves existing name-based commands and catalog semantics.
It adds path-based operation without requiring existing local plugins to move.

The current in-place `verifyBundle` implementation is migrated behind the new
temporary workspace boundary. Existing target profile isolation, `allowBuilds`
materialization, source/bundle separation, and prebuilt `masterBin` reuse remain
valid inside the new pipeline.

Evidence directories and temporary workspaces are ignored by Git. No existing
plugin repository is initialized or modified automatically during migration.

## Testing strategy

### Unit tests

- catalog-name and arbitrary-path resolution;
- mutually exclusive identifier validation;
- configuration precedence;
- inspect diagnostic rules and stable codes;
- deterministic snapshot include/exclude behavior;
- external symlink rejection;
- digest stability across timestamps and source absolute paths;
- result schema validation and atomic publication;
- stale-reason derivation for plugin, target, and context changes.

### Integration tests

- snapshot current committed, modified, and untracked plugin files;
- exclude old `lib`, `node_modules`, `.git`, `.lab`, and `.env*` content;
- run install/build/test/pack only in a temporary workspace;
- prove the source plugin tree is byte-identical before and after verify;
- prove temporary workspace removal after pass and failure;
- prove concurrent verify runs use disjoint workspaces and profiles;
- verify an arbitrary plugin path outside the meta-repo;
- verify existing catalog-name syntax through the same resolver;
- produce a failed result for plugin failure without classifying it as a forge
  crash.

### Acceptance

The first slice is accepted when all of the following are demonstrated on the
supported Windows host:

1. `lab inspect --path <standalone-plugin> --json` succeeds without catalog or
   `.dsh-lab/plugin.yaml` and does not mutate the plugin.
2. `lab verify --path <standalone-plugin> --target next --json` uses a unique
   temporary workspace, produces a finalized result, and removes the workspace.
3. A plugin test failure still produces a failed finalized result and removes
   the workspace.
4. Modified and untracked current source files participate in the digest and
   verification snapshot.
5. `lab status --path <standalone-plugin> --json` reports current evidence and
   explains staleness after source or target changes.
6. Existing `lab dev <catalog-name>` and `lab verify <catalog-name>` behavior
   remains available through the shared resolver.
7. Root typecheck, full tests, `lab doctor`, and diff hygiene pass.

## Explicit non-goals for the first slice

- agent planning, task management, or SDD enforcement;
- remote creation, Git push, npm publication, or release workflow;
- UI session commands or visual automation;
- real-API verification or credential injection;
- generated `.agents` skill and drift gate;
- npm `next` updater changes;
- automatic fixes to plugin repositories;
- persistent verification worktrees;
- screenshots, videos, DOM archives, or report bundles.
