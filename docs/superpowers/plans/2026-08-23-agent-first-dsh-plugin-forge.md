# Agent-First DSH Plugin Forge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any host agent inspect, verify, and resume work on an arbitrary local DSH plugin repository without catalog registration or product-tree mutation.

**Architecture:** A shared path-first `PluginRef` resolver feeds read-only inspection, live development, staged verification, and derived status. Verification snapshots current filesystem contents into a unique `mkdtemp` workspace, runs every install/build/package/DSH target operation there, publishes one immutable minimal result, and removes the workspace in `finally`.

**Tech Stack:** Node.js 22.20, TypeScript NodeNext, pnpm 11.7, Vitest, js-yaml, Node `fs`/`crypto`/`child_process`, existing DSH workbench profiles.

**Spec:** `docs/superpowers/specs/2026-08-23-agent-first-dsh-plugin-forge-design.md`

## Global Constraints

- The target ecosystem is DSH; the operating agent host remains neutral.
- The forge is an environment, not an agent orchestrator or SDD enforcement engine.
- Remote creation, push, publication, release automation, UI sessions, real-API checks, and skill generation are out of scope.
- `context/*` remains the shared source of truth; this slice does not create skill mirrors.
- `inspect`, `dev`, `verify`, and `status` accept exactly one catalog name or `--path` and do not require `lab init`.
- Explicit CLI values override optional `.dsh-lab/plugin.yaml`; safely inferred values come last.
- Only `new`, `init`, and `sync-context` may edit a plugin repository. This plan implements no new product mutation.
- `dev` reads live source; canonical `verify` operates only in a unique temporary workspace created with `mkdtemp`.
- The verification snapshot includes current committed, modified, and untracked files, not only Git `HEAD`.
- Exclude `.git`, `node_modules`, `.lab`, `lib`, `dist`, `coverage`, `.env`, and `.env.*` from snapshots and digests.
- Reject unresolved symlinks and symlinks whose resolved target leaves the plugin root.
- Target-owned `allowBuilds` may be written only into temporary workspace/profile policy.
- Use `pnpm install --ignore-workspace --frozen-lockfile` inside the temporary workspace.
- Stop owned child processes and remove the temporary workspace in `finally` after pass and failure. Cleanup failure makes verification fail visibly.
- Evidence is forge-owned under `.lab/runs`, immutable after atomic publication, minimal, sanitized, and contains no complete environment dump, screenshots, chain of thought, workflow stage, or release state.
- Preserve existing name-based CLI behavior, exact target pins, source/bundle acceptance separation, and unique verify profiles.
- Do not modify `catalog.yaml`, unrelated untracked documents, or plugin Git state.
- Use TDD: every production behavior starts with a focused failing test and a witnessed RED run.
- Do not commit or publish from the controller's dirty root. SDD execution occurs on `feature/agent-first-forge` in an isolated worktree and uses task-scoped commits there.

## Planned file structure

```text
tooling/src/plugin-ref.ts             catalog/path resolution and CLI-neutral PluginRef
tooling/src/plugin-ref.spec.ts        resolver and precedence tests
tooling/src/inspect.ts                read-only package/DSH contract diagnostics
tooling/src/inspect.spec.ts           diagnostic behavior and JSON shape tests
tooling/src/plugin-snapshot.ts        deterministic copy, digest, symlink and cleanup primitives
tooling/src/plugin-snapshot.spec.ts   snapshot/digest/isolation tests
tooling/src/evidence.ts               run schema, atomic publication, loading and freshness
tooling/src/evidence.spec.ts          immutable publication and staleness tests
tooling/src/package-verify.ts         staged install/check/build/pack orchestration
tooling/src/package-verify.spec.ts    command order and failure classification tests
tooling/src/verify.ts                 end-to-end staged DSH verification and result finalization
tooling/src/verify.spec.ts            pass/fail/cleanup/source-read-only integration tests
tooling/src/status.ts                 derived current/stale/not-run view
tooling/src/status.spec.ts            status derivation tests
tooling/src/cli.ts                    inspect/status routes and path-first dev/verify parsing
tooling/src/cli.spec.ts               exit codes, JSON stdout and compatibility routing
tooling/src/run.ts                    live dev and packed-target seams reused by verify.ts
tooling/src/run.spec.ts               path-independent runtime seam tests
docs/using-the-lab.md                 agent-first command reference
README.md                             concise forge entrypoint
AGENTS.md                             path-first commands and mutation boundary
```

---

### Task 1: Path-First Plugin Resolution

**Files:**
- Create: `tooling/src/plugin-ref.ts`
- Create: `tooling/src/plugin-ref.spec.ts`
- Modify: `tooling/src/cli.ts`
- Modify: `tooling/src/cli.spec.ts`

**Interfaces:**
- Consumes: `loadCatalogFromFile`, `loadPluginConfig`, `ROOT_PATHS.catalog`.
- Produces:

```ts
export interface PluginRef {
  sourcePath: string
  packageName: string
  catalogName?: string
  catalogEntry?: CatalogEntry
  metadata?: PluginConfig
}

export interface PluginSelector {
  name?: string
  path?: string
}

export function resolvePluginRef(opts: {
  root: string
  selector: PluginSelector
}): PluginRef

export function parsePluginSelector(args: string[]): {
  selector: PluginSelector
  rest: string[]
}
```

- `sourcePath` is normalized with `resolve()` and package identity comes from readable `package.json`.
- Exactly one of `selector.name` or `selector.path` is required.
- Catalog and `.dsh-lab/plugin.yaml` data are optional for path selectors.

- [ ] **Step 1: Add failing resolver tests**

Create fixtures for a catalog plugin and an external plugin without `.dsh-lab`. Cover catalog name, absolute/relative `--path`, optional metadata, both identifiers, neither identifier, missing directory, and unreadable/missing package name.

```ts
expect(resolvePluginRef({ root, selector: { path: external } })).toMatchObject({
  sourcePath: resolve(external),
  packageName: '@fixture/external',
})
expect(() => resolvePluginRef({ root, selector: { name: 'demo', path: external } }))
  .toThrow(/exactly one/i)
```

- [ ] **Step 2: Run resolver tests and witness RED**

Run: `pnpm vitest run tooling/src/plugin-ref.spec.ts`

Expected: FAIL because `plugin-ref.js` does not exist.

- [ ] **Step 3: Implement the minimal resolver**

Read `catalog.yaml` only for name selection. Read `.dsh-lab/plugin.yaml` only when present. Parse package JSON with errors that include the resolved source path. Return optional properties using conditional spreads so `exactOptionalPropertyTypes` passes.

- [ ] **Step 4: Run resolver tests and typecheck**

Run:

```text
pnpm vitest run tooling/src/plugin-ref.spec.ts
pnpm typecheck
```

Expected: resolver tests PASS and typecheck exits 0.

- [ ] **Step 5: Add failing CLI selector tests**

Test parsing without invoking real dev/verify processes:

```ts
expect(parsePluginSelector(['demo', '--target', 'next'])).toEqual({
  selector: { name: 'demo' },
  rest: ['--target', 'next'],
})
expect(parsePluginSelector(['--path', 'A:/plugin', '--target', 'master'])).toEqual({
  selector: { path: 'A:/plugin' },
  rest: ['--target', 'master'],
})
```

Cover missing `--path` value and conflicting positional names.

- [ ] **Step 6: Run CLI selector tests and witness RED**

Run: `pnpm vitest run tooling/src/cli.spec.ts tooling/src/plugin-ref.spec.ts`

Expected: new selector expectations FAIL before CLI integration.

- [ ] **Step 7: Integrate the shared selector parser without changing command behavior**

Export the parser from `plugin-ref.ts`; make `dev` and `verify` route through it while still passing catalog names to their current implementation. Path execution is completed in later tasks; Task 1 only establishes unambiguous parsing and compatibility.

- [ ] **Step 8: Run focused tests**

Run: `pnpm vitest run tooling/src/cli.spec.ts tooling/src/plugin-ref.spec.ts`

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```text
git add tooling/src/plugin-ref.ts tooling/src/plugin-ref.spec.ts tooling/src/cli.ts tooling/src/cli.spec.ts
git commit -m "feat: resolve plugins by catalog name or path"
```

---

### Task 2: Read-Only Plugin Inspection

**Files:**
- Create: `tooling/src/inspect.ts`
- Create: `tooling/src/inspect.spec.ts`
- Modify: `tooling/src/cli.ts`
- Modify: `tooling/src/cli.spec.ts`

**Interfaces:**
- Consumes: `PluginRef`, compatibility loader, Node filesystem APIs.
- Produces:

```ts
export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface InspectDiagnostic {
  code: string
  severity: DiagnosticSeverity
  message: string
  location?: string
  remediation?: string
}

export interface InspectionResult {
  schemaVersion: 1
  plugin: { packageName: string; sourcePath: string }
  faces: { host: boolean; client: boolean | 'unknown' }
  diagnostics: InspectDiagnostic[]
  ok: boolean
}

export function inspectPlugin(opts: {
  root: string
  plugin: PluginRef
  target?: 'next' | 'master'
}): InspectionResult
```

- Stable diagnostic codes use uppercase snake case, including `PACKAGE_NOT_ESM`, `LOCKFILE_MISSING`, `WORKSPACE_BOUNDARY_MISSING`, `SCRIPT_MISSING`, `BUNDLE_PATCH_MISSING`, `EXPORT_MISMATCH`, `PRIVATE_UPSTREAM_IMPORT`, and `DEPENDENCY_PIN_MISMATCH`.
- Inspection never executes Git mutation, package scripts, install, build, or writes.

- [ ] **Step 1: Write failing inspection tests for a valid standalone fixture**

Build a temporary plugin fixture with package.json, lockfile, workspace marker, source, bundle patch, and required scripts. Assert `ok: true`, no error diagnostics, host face true, and JSON-serializable stable fields.

- [ ] **Step 2: Add table-driven failing diagnostic tests**

For one defect per fixture mutation, assert exact diagnostic code and severity. Include private imports matching `upstream/deepseek-harness`, missing lock/workspace/scripts, wrong `type`, broken patch path, incoherent exports, and target pin mismatch when metadata supplies a target.

- [ ] **Step 3: Run inspection tests and witness RED**

Run: `pnpm vitest run tooling/src/inspect.spec.ts`

Expected: FAIL because `inspect.js` does not exist.

- [ ] **Step 4: Implement inspection as pure read-only rules**

Keep each rule in a small function returning zero or more diagnostics. Sort diagnostics by code then location for deterministic JSON. Infer client face only from explicit package client exports/DSH client metadata; otherwise use `unknown` rather than guessing from filenames.

- [ ] **Step 5: Run inspection tests and typecheck**

Run:

```text
pnpm vitest run tooling/src/inspect.spec.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Add failing CLI tests for text and JSON inspection**

Mock `resolvePluginRef` and `inspectPlugin`. Assert:

```text
lab inspect --path X        -> concise diagnostics, exit 0/1
lab inspect --path X --json -> one JSON document on stdout
```

No progress text may share stdout with JSON.

- [ ] **Step 7: Implement the inspect CLI route**

Parse optional `--target` and `--json`, reject unknown flags, print stable text lines or JSON, and return 0 only when `result.ok` is true.

- [ ] **Step 8: Run focused CLI and inspection tests**

Run: `pnpm vitest run tooling/src/inspect.spec.ts tooling/src/cli.spec.ts`

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```text
git add tooling/src/inspect.ts tooling/src/inspect.spec.ts tooling/src/cli.ts tooling/src/cli.spec.ts
git commit -m "feat: inspect standalone plugin contracts"
```

---

### Task 3: Deterministic Temporary Plugin Snapshots

**Files:**
- Create: `tooling/src/plugin-snapshot.ts`
- Create: `tooling/src/plugin-snapshot.spec.ts`

**Interfaces:**
- Consumes: normalized `PluginRef.sourcePath`, forge runtime path.
- Produces:

```ts
export interface PluginSnapshot {
  runRoot: string
  workspacePath: string
  digest: `sha256:${string}`
  files: string[]
  cleanup(): void
}

export function computePluginDigest(sourcePath: string): {
  digest: `sha256:${string}`
  files: string[]
}

export function createPluginSnapshot(opts: {
  sourcePath: string
  runtimeRoot: string
}): PluginSnapshot
```

- Use `mkdtempSync(join(runtimeRoot, 'verify-'))` and a `workspace` child.
- Apply one shared deterministic traversal to digesting and copying.

- [ ] **Step 1: Write failing include/exclude and current-content tests**

Create committed-like source plus modified and untracked fixture files. Add excluded `.git`, `node_modules`, `.lab`, `lib`, `dist`, `coverage`, `.env`, and `.env.local` sentinels. Assert included current files appear in `files` and copied workspace; excluded sentinels do not.

- [ ] **Step 2: Write failing digest stability tests**

Assert identical relative files and bytes under two different absolute roots produce the same digest; changing a file byte or adding an untracked source file changes it; changing timestamps does not.

- [ ] **Step 3: Write failing symlink boundary tests**

When symlink creation is available, assert an internal symlink is handled deterministically and an external/unresolved link throws a path-escape diagnostic. Skip only when the platform reports that symlink creation itself is unavailable.

- [ ] **Step 4: Write failing cleanup tests**

Assert `cleanup()` removes `runRoot`, is idempotent after successful removal, and throws an error containing the exact path when removal is deliberately prevented through an injected remover seam.

- [ ] **Step 5: Run snapshot tests and witness RED**

Run: `pnpm vitest run tooling/src/plugin-snapshot.spec.ts`

Expected: FAIL because snapshot implementation is absent.

- [ ] **Step 6: Implement deterministic traversal, copy, digest, and cleanup**

Normalize relative paths to `/`, sort directory entries, hash path + type + bytes, create parents explicitly, preserve only safe internal symlinks, and never follow excluded directories. Add a test-only optional remover dependency rather than mocking Node globally.

- [ ] **Step 7: Run snapshot tests and typecheck**

Run:

```text
pnpm vitest run tooling/src/plugin-snapshot.spec.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```text
git add tooling/src/plugin-snapshot.ts tooling/src/plugin-snapshot.spec.ts
git commit -m "feat: snapshot plugins into temporary workspaces"
```

---

### Task 4: Immutable Minimal Evidence

**Files:**
- Create: `tooling/src/evidence.ts`
- Create: `tooling/src/evidence.spec.ts`

**Interfaces:**
- Consumes: plugin digest, package/path identity, target pins, step outcomes.
- Produces:

```ts
export type StepStatus = 'pass' | 'fail' | 'blocked' | 'skipped' | 'not-applicable'
export type RunOutcome = 'pass' | 'fail' | 'blocked'

export interface RunStepResult {
  id: string
  status: StepStatus
  durationMs: number
  summary?: string
}

export interface VerifyRunResultV1 {
  schemaVersion: 1
  runId: string
  operation: 'verify'
  result: RunOutcome
  plugin: { packageName: string; sourcePath: string; digest: `sha256:${string}` }
  targets: Record<string, { dsh?: string; commit?: string; result: StepStatus }>
  lab: { contextDigest: string }
  environment: { node: string; pnpm: string; platform: NodeJS.Platform }
  steps: RunStepResult[]
  cleanup: 'pass' | 'fail'
  startedAt: string
  finishedAt: string
}

export function pluginEvidenceKey(plugin: { packageName: string; sourcePath: string }): string
export function publishRunResult(opts: { runsRoot: string; result: VerifyRunResultV1 }): string
export function loadRunResults(opts: { runsRoot: string; pluginKey: string }): VerifyRunResultV1[]
```

- [ ] **Step 1: Write failing schema and serialization tests**

Assert required fields, stable plugin key, JSON round-trip, no arbitrary environment map, and concise optional summaries.

- [ ] **Step 2: Write failing atomic/immutable publication tests**

Use an injected rename seam to assert publication writes `<run-id>.tmp` then atomically renames to `result.json`; reject a duplicate finalized run rather than overwrite it; remove the temp file on pre-publication failure where possible.

- [ ] **Step 3: Write failing load-order and corruption tests**

Assert finalized results load newest-first by `finishedAt`; ignore unrelated files; report malformed finalized JSON with its exact path instead of silently dropping it.

- [ ] **Step 4: Run evidence tests and witness RED**

Run: `pnpm vitest run tooling/src/evidence.spec.ts`

Expected: FAIL because evidence implementation is absent.

- [ ] **Step 5: Implement minimal evidence storage**

Sanitize plugin key to a readable package-name fragment plus a short SHA-256 of normalized source path. Validate run IDs before path construction. Write formatted JSON with a final newline. Do not store raw stdout/stderr, screenshots, DOM, full environment, agent identity, planning state, or Git release state.

- [ ] **Step 6: Run evidence tests and typecheck**

Run:

```text
pnpm vitest run tooling/src/evidence.spec.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```text
git add tooling/src/evidence.ts tooling/src/evidence.spec.ts
git commit -m "feat: persist minimal immutable verification evidence"
```

---

### Task 5: Staged Package Verification

**Files:**
- Create: `tooling/src/package-verify.ts`
- Create: `tooling/src/package-verify.spec.ts`
- Modify: `tooling/src/proc.ts`

**Interfaces:**
- Consumes: `PluginSnapshot.workspacePath`, target-owned `allowBuilds`, existing pnpm process helper.
- Produces:

```ts
export interface PackageVerifyResult {
  tarball: string
  steps: RunStepResult[]
}

export interface PackageVerifyRunner {
  pnpm(args: string[], opts: RunOpts): string | Buffer
}

export function verifyPackageInWorkspace(opts: {
  workspacePath: string
  allowBuilds: Record<string, boolean>
  runner?: PackageVerifyRunner
}): PackageVerifyResult
```

- The function operates only on the temporary workspace.
- It materializes/merges target-owned `allowBuilds` only in the copied `pnpm-workspace.yaml`.

- [ ] **Step 1: Write failing command-order tests**

With an injected runner, assert exact calls:

```text
pnpm install --ignore-workspace --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack --json
pnpm pack-smoke <absolute-tarball>
```

Assert every cwd equals `workspacePath`, the packed JSON filename is resolved inside it, and no command uses the source plugin path.

- [ ] **Step 2: Write failing prerequisite tests**

Assert missing lockfile, workspace boundary, required package scripts, malformed pack JSON, empty pack result, and tarball path escape fail before a later unsafe step. Assert temporary `allowBuilds` policy contains only normalized booleans sorted by package name.

- [ ] **Step 3: Write failing step-result tests**

Inject a failure at `test` and assert completed steps are `pass`, the failing step is `fail` with a sanitized summary, later steps are `skipped`, and the error carries structured step results for the outer verifier.

- [ ] **Step 4: Run package verification tests and witness RED**

Run: `pnpm vitest run tooling/src/package-verify.spec.ts`

Expected: FAIL because package verifier is absent.

- [ ] **Step 5: Implement staged package verification**

Reuse the Windows-safe pnpm command helper. Never enable shell execution. Parse `pack --json` exactly once. Require the plugin-owned `pack-smoke` script. Measure durations with a monotonic clock and sanitize error summaries to omit environment values.

- [ ] **Step 6: Run package tests and typecheck**

Run:

```text
pnpm vitest run tooling/src/package-verify.spec.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```text
git add tooling/src/package-verify.ts tooling/src/package-verify.spec.ts tooling/src/proc.ts
git commit -m "feat: verify plugin packages in staged workspaces"
```

---

### Task 6: End-to-End Temporary DSH Verification

**Files:**
- Create: `tooling/src/verify.ts`
- Create: `tooling/src/verify.spec.ts`
- Modify: `tooling/src/run.ts`
- Modify: `tooling/src/run.spec.ts`
- Modify: `tooling/src/cli.ts`
- Modify: `tooling/src/cli.spec.ts`

**Interfaces:**
- Consumes: `PluginRef`, `inspectPlugin`, `createPluginSnapshot`, `verifyPackageInWorkspace`, target pins, evidence publisher, existing DSH launcher/profile logic.
- Produces:

```ts
export interface VerifyPluginOptions {
  root: string
  plugin: PluginRef
  target: 'next' | 'master' | 'all'
  runsRoot?: string
}

export async function verifyPlugin(opts: VerifyPluginOptions): Promise<VerifyRunResultV1>

export async function verifyPackedTarget(opts: {
  root: string
  pluginName: string
  target: 'next' | 'master'
  tarball: string
  compat: Compatibility
  masterBin?: string
}): Promise<void>
```

- `verifyPackedTarget` is extracted from current `run.ts` behavior and retains unique profiles, target-owned `allowBuilds`, `masterBin` reuse, `finally` cleanup, and DSH composition checks.
- Current `verifyBundle({ root, name, target })` becomes a compatibility wrapper resolving a catalog `PluginRef` then calling `verifyPlugin`.

- [ ] **Step 1: Write failing orchestration tests**

Inject seams for inspect, snapshot, package verification, target verification, evidence publication, compatibility loading, and time. Assert the order:

```text
resolve inputs -> inspect -> snapshot -> package checks -> targets -> result publication -> cleanup
```

Assert inspect errors stop before snapshot/install.

- [ ] **Step 2: Write failing pass/fail/cleanup tests**

Cover package failure, one target failure under `all`, evidence publication failure, and cleanup failure. Assert cleanup is attempted exactly once in every case. Assert cleanup failure changes `cleanup` to `fail` and prevents a successful overall result.

- [ ] **Step 3: Write failing source-read-only integration test**

Create a standalone fixture outside the meta-repo with current modified/untracked files. Hash its relevant file set before and after a real staged verification with injected external commands. Assert the source file set and bytes are identical and every generated/install artifact exists only under the snapshot runtime before cleanup.

- [ ] **Step 4: Run verifier tests and witness RED**

Run: `pnpm vitest run tooling/src/verify.spec.ts`

Expected: FAIL because `verify.js` does not exist.

- [ ] **Step 5: Extract packed-target verification from `run.ts`**

Move only target/profile composition responsibilities behind the exported seam. Preserve existing public wrappers so earlier tests stay green. Do not duplicate launcher or profile cleanup logic.

- [ ] **Step 6: Implement the outer verifier with guaranteed finalization**

Create a run ID first, collect structured steps, publish exactly one finalized result after cleanup outcome is known, and throw/return through one typed result path. If plugin verification fails, publish `result: fail`; if forge prerequisites prevent execution, publish `blocked` when enough plugin identity/digest exists.

- [ ] **Step 7: Add failing CLI path/JSON verification tests**

Mock resolver and verifier. Assert catalog and `--path` routes call the same verifier, `--json` emits exactly the finalized result on stdout, text mode prints concise step outcomes, and unknown/missing target values fail without invocation.

- [ ] **Step 8: Implement CLI integration and compatibility wrapper**

Route new calls to `verifyPlugin`. Keep `lab verify <catalog-name>` valid. Require explicit target for a path plugin lacking metadata. Keep target precedence CLI > metadata > safe error.

- [ ] **Step 9: Run verifier, run, CLI, and typecheck suites**

Run:

```text
pnpm vitest run tooling/src/verify.spec.ts tooling/src/run.spec.ts tooling/src/cli.spec.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit Task 6**

```text
git add tooling/src/verify.ts tooling/src/verify.spec.ts tooling/src/run.ts tooling/src/run.spec.ts tooling/src/cli.ts tooling/src/cli.spec.ts
git commit -m "feat: verify DSH plugins in temporary workspaces"
```

---

### Task 7: Derived Verification Status

**Files:**
- Create: `tooling/src/status.ts`
- Create: `tooling/src/status.spec.ts`
- Modify: `tooling/src/cli.ts`
- Modify: `tooling/src/cli.spec.ts`

**Interfaces:**
- Consumes: `PluginRef`, `computePluginDigest`, finalized evidence runs, current compatibility pins, current context digest.
- Produces:

```ts
export type ClaimState = 'pass' | 'fail' | 'stale' | 'not-run' | 'not-applicable'

export interface StatusClaim {
  state: ClaimState
  runId?: string
  reasons?: string[]
}

export interface PluginStatus {
  schemaVersion: 1
  plugin: { packageName: string; sourcePath: string; digest: `sha256:${string}` }
  structure: StatusClaim
  bundle: StatusClaim
  targets: Record<string, StatusClaim>
  ui: StatusClaim
}

export function derivePluginStatus(opts: {
  root: string
  plugin: PluginRef
  runsRoot?: string
}): PluginStatus
```

- [ ] **Step 1: Write failing no-run/current-result tests**

Assert no evidence yields `not-run`; a matching digest, target pin, and context digest yields current `pass`/`fail` claims with the source run ID.

- [ ] **Step 2: Write failing stale-reason tests**

Independently change plugin bytes, next DSH version, master commit, and context digest. Assert `stale` with stable reasons `PLUGIN_CONTENT_CHANGED`, `TARGET_PIN_CHANGED`, and `LAB_CONTEXT_CHANGED`. Multiple changes produce sorted unique reasons.

- [ ] **Step 3: Write failing applicability tests**

UI is `not-applicable` only when inspection safely determines no client face; otherwise it is `not-run` until the later UI protocol records a verdict. Never infer success from files alone.

- [ ] **Step 4: Run status tests and witness RED**

Run: `pnpm vitest run tooling/src/status.spec.ts`

Expected: FAIL because status implementation is absent.

- [ ] **Step 5: Implement derived status**

Read immutable runs newest-first, select the newest relevant run per claim, compare exact digests/pins/context, and never write workflow state. Corrupt finalized evidence is an explicit status error containing its path.

- [ ] **Step 6: Add failing CLI text/JSON tests**

Assert `lab status <name>` and `lab status --path X` share resolution; text contains current/stale/not-run labels; JSON is a single document; status does not create evidence.

- [ ] **Step 7: Implement status CLI route**

Use exit 0 when no current claim is failed, exit 2 when any applicable claim is stale/not-run/failed, and exit 1 only for resolution/tooling errors. Document this distinction in help.

- [ ] **Step 8: Run status and CLI tests**

Run:

```text
pnpm vitest run tooling/src/status.spec.ts tooling/src/cli.spec.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit Task 7**

```text
git add tooling/src/status.ts tooling/src/status.spec.ts tooling/src/cli.ts tooling/src/cli.spec.ts
git commit -m "feat: derive plugin status from verification evidence"
```

---

### Task 8: Path-First Dev, Documentation, and Acceptance

**Files:**
- Modify: `tooling/src/run.ts`
- Modify: `tooling/src/run.spec.ts`
- Modify: `tooling/src/cli.ts`
- Modify: `tooling/src/cli.spec.ts`
- Modify: `README.md`
- Modify: `docs/using-the-lab.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: shared `PluginRef`, existing source-overlay/profile runtime, new inspect/verify/status commands.
- Produces: complete first-slice agent-facing CLI and documented mutation/isolation contract.

- [ ] **Step 1: Write failing path-based dev tests**

Refactor the dev entry to consume `PluginRef` or add a `devPlugin({ root, plugin, target })` seam. Assert an external plugin path uses its live `src/index.ts`, optional metadata defaults, and root `.lab/runtime` for profiles/overlays without writing into the plugin.

- [ ] **Step 2: Run dev tests and witness RED**

Run: `pnpm vitest run tooling/src/run.spec.ts tooling/src/cli.spec.ts`

Expected: new external-path dev expectations FAIL.

- [ ] **Step 3: Implement path-first live dev**

Preserve `file:` URL source overlay, `tsx/esm`, stable dev profile naming, target pins, HMR root, and target-owned `allowBuilds`. Do not create `.dsh-lab` metadata for external paths.

- [ ] **Step 4: Run focused dev/CLI tests**

Run: `pnpm vitest run tooling/src/run.spec.ts tooling/src/cli.spec.ts`

Expected: PASS.

- [ ] **Step 5: Update agent-facing documentation**

Document:

```text
lab inspect <name>|--path P [--json]
lab dev <name>|--path P --target T
lab verify <name>|--path P --target T [--json]
lab status <name>|--path P [--json]
```

State plainly that `dev` is live/in-place read-only, `verify` uses and always removes a temporary workspace, current uncommitted/untracked files are included, evidence is minimal forge memory, catalog/init are optional, and only explicit authoring commands mutate plugin repositories. Keep UI sessions and agent skill generation labeled as future work, not implemented commands.

- [ ] **Step 6: Add/refresh CLI help acceptance tests**

Assert root help lists inspect/status and both identifier forms; no help text advertises UI, publication, init behavior not implemented by this slice, or generated skills.

- [ ] **Step 7: Run the complete deterministic acceptance suite**

Run:

```text
pnpm typecheck
pnpm test
pnpm lab doctor
pnpm lab --help
pnpm lab inspect --path plugins/example --json
pnpm lab status --path plugins/example --json
git diff --check
```

Expected:

- typecheck exit 0;
- every test file passes with zero failures;
- doctor exit 0;
- help documents the first-slice commands;
- inspect emits one valid JSON document and does not mutate `plugins/example`;
- status emits one valid JSON document (exit 0 or 2 according to available evidence);
- diff hygiene passes.

- [ ] **Step 8: Run the temporary-workspace failure acceptance**

Using a test fixture or dedicated acceptance helper, make a plugin test fail and assert a finalized failed result exists while the temporary `verify-*` workspace no longer exists. Do not run a destructive command against a real plugin.

- [ ] **Step 9: Review source-tree mutation evidence**

Record hashes/file lists for the standalone acceptance plugin before and after inspect/verify. Expected: no product file additions, deletions, or byte changes.

- [ ] **Step 10: Commit Task 8**

```text
git add tooling/src/run.ts tooling/src/run.spec.ts tooling/src/cli.ts tooling/src/cli.spec.ts README.md docs/using-the-lab.md AGENTS.md
git commit -m "docs: present the lab as an agent-first plugin forge"
```

---

## Final review checklist

- [ ] Every spec section in the first vertical slice maps to a completed task.
- [ ] All product-read-only commands leave source plugin fixtures byte-identical.
- [ ] Verify copies current uncommitted/untracked files and excludes every forbidden path.
- [ ] Every temporary workspace is created with `mkdtemp` and deleted in `finally`.
- [ ] Every selected DSH target uses an isolated profile and exact current pin.
- [ ] Evidence is minimal, atomic, immutable, sanitized, and forge-owned.
- [ ] Status is derived and reports explicit stale reasons; no workflow stage exists.
- [ ] Catalog-name behavior remains compatible and arbitrary paths need no init.
- [ ] JSON stdout contains only JSON; progress/diagnostics use stderr.
- [ ] No UI, SDD enforcement, skill generation, remote, release, or publication scope leaked into implementation.
- [ ] Full tests, typecheck, doctor, CLI acceptance, and diff hygiene pass freshly.
