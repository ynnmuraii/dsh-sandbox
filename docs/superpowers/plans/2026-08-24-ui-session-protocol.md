# UI Session Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an agent-owned UI verification protocol that runs a temporary, loopback-only DSH source session and stores only a minimal immutable pass/fail verdict.

**Architecture:** A small immutable-evidence module and read-only status integration sit outside the active runtime. A validated session store coordinates a detached supervisor that owns the DSH child process, while a service layer implements start/status/finish/abort and the CLI only parses and renders the protocol. The browser and visual reasoning remain external to the lab.

**Tech Stack:** TypeScript 6, Node.js 22 child processes and filesystem APIs, Vitest 4, existing DSH profile/overlay tooling, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-08-24-ui-session-protocol-design.md`

## Global Constraints

- Work only in the temporary isolated branch `feature/ui-session-stage3`; never write implementation changes in the main checkout.
- The controller writes and commits every `*.spec.ts` change. Luna production implementers must not edit, delete, rename, stage, or commit tests without explicit controller approval.
- Use a fresh `gpt-5.6-luna` implementer for each production task, never two production implementers concurrently, and run an independent task review after each production task.
- The final whole-branch research review runs on `gpt-5.6-sol` after all task reviews are clean.
- `lab verify` remains unchanged; UI verification is only `lab ui start/status/finish/abort`.
- Bind only to `127.0.0.1`, pass `--port 0` and `--no-open`, and launch every command with an argument array and no shell interpolation.
- The plugin repository is read-only. All overlays, profiles, homes, leases, logs, and controls live under `.lab/runtime/ui-sessions/<session-id>`.
- Final evidence lives only under `.lab/ui-runs/<plugin-key>/<session-id>/result.json` and contains exactly the `UiResultV1` fields from the spec.
- Do not persist screenshots, DOM, traces, videos, browser scripts, URLs, PIDs, environments, logs, or credentials in finalized evidence.
- A UI result is current only for the captured plugin digest, canonical context digest, and exact target pin.
- Once a mismatch is observed, stale reasons are latched; `finish` refuses stale sessions.
- Cleanup must complete before evidence publication. `abort` never publishes evidence.
- JSON mode writes exactly one JSON document to stdout; progress and diagnostics go to stderr.
- Exit `0` for current success/pass/abort, `2` for valid non-pass/stale/crashed/fail, and `1` for usage, corruption, unsafe paths, or tooling errors.
- Run targeted tests after each production task, then `pnpm test`, `pnpm typecheck`, `pnpm lab sync-context --all` twice, and `git diff --check` before integration.

## File map

| File | Responsibility |
| --- | --- |
| `tooling/src/ui-evidence.ts` | Exact `UiResultV1` schema, summary normalization, safe immutable publication, deterministic loading. |
| `tooling/src/ui-session.ts` | Session IDs, state/control schemas, safe contained paths, atomic lease/control writes, stale latching. |
| `tooling/src/ui-runtime.ts` | Unique source overlay/profile/home materialization and exact target launcher plan. |
| `tooling/src/ui-supervisor.ts` | Readiness parsing, bounded log, child lifecycle, process-tree cleanup, atomic state transitions. |
| `tooling/src/ui-supervisor-bin.ts` | Minimal detached-process entry point for one serialized supervisor request. |
| `tooling/src/ui.ts` | Public start/status/finish/abort service, identity checks, control/wait protocol, evidence finalization. |
| `tooling/src/status.ts` | Read-only finalized UI claim beside existing verify claims. |
| `tooling/src/cli.ts` | Command parsing, human/JSON rendering, exit mapping. |
| `context/testing-policy.md` | Canonical UI-session verification and evidence boundary. |
| `context/dsh-plugin-development-skill.md` | Agent-facing UI workflow recommendation; generated skill remains a projection. |
| `docs/using-the-lab.md` | Command examples and external-agent ownership. |
| `README.md` | Compact command inventory. |

---

### Task 1: Controller RED — immutable UI evidence and plugin status

**Role:** Controller only. Do not dispatch this task to a production implementer.

**Files:**
- Create: `tooling/src/ui-evidence.spec.ts`
- Modify: `tooling/src/status.spec.ts`

**Interfaces under test:**
- Produces the binding contract consumed by Task 2.
- Imports these not-yet-existing exports from `./ui-evidence.js`:

```ts
export type UiTargetIdentity =
  | { name: 'next'; dsh: string }
  | { name: 'master'; commit: string }

export interface UiResultV1 {
  schemaVersion: 1
  sessionId: string
  operation: 'ui'
  verdict: 'pass' | 'fail'
  plugin: { packageName: string; sourcePath: string; digest: `sha256:${string}` }
  target: UiTargetIdentity
  lab: { contextDigest: `sha256:${string}` }
  summary: string
  cleanup: 'pass'
  startedAt: string
  finishedAt: string
}

export function normalizeUiSummary(value: string): string
export function publishUiResult(opts: { uiRunsRoot: string; result: UiResultV1 }): string
export function loadUiResults(opts: { uiRunsRoot: string; pluginKey: string }): UiResultV1[]
```

- [ ] **Step 1: Add a valid result fixture and exact-schema tests**

```ts
const result = (overrides: Partial<UiResultV1> = {}): UiResultV1 => ({
  schemaVersion: 1,
  sessionId: 'ui-20260824T120000000Z-a1b2c3d4',
  operation: 'ui',
  verdict: 'pass',
  plugin: {
    packageName: '@scope/plugin',
    sourcePath: 'A:/plugins/plugin',
    digest: `sha256:${'1'.repeat(64)}`,
  },
  target: { name: 'next', dsh: '0.1.1-rc.2' },
  lab: { contextDigest: `sha256:${'2'.repeat(64)}` },
  summary: 'Conversation renders and input remains usable.',
  cleanup: 'pass',
  startedAt: '2026-08-24T12:00:00.000Z',
  finishedAt: '2026-08-24T12:01:00.000Z',
  ...overrides,
})
```

Assert publication produces exactly `<root>/<pluginEvidenceKey(plugin)>/<sessionId>/result.json`, preserves the exact allowed keys, sorts loaded results newest-first, and rejects unknown top-level or nested keys, invalid hashes, mismatched target fields, invalid timestamps, `cleanup: 'fail'`, and replacement of an existing final file.

- [ ] **Step 2: Add summary and forbidden-data tests**

Assert `normalizeUiSummary` trims outer whitespace, rejects empty text, rejects C0/C1 control characters, counts Unicode code points, accepts exactly 500, rejects 501, and never silently truncates. Assert `publishUiResult` rejects objects containing `url`, `pid`, `environment`, `screenshots`, `dom`, `trace`, `video`, `browserScript`, or `credentials` through exact-key validation.

- [ ] **Step 3: Add path-safety and atomicity tests**

Use temporary directories and existing platform-aware symlink guards. Assert a symlinked plugin directory, result directory, final file, or temporary file cannot escape `uiRunsRoot`; a failed rename leaves no finalized file; concurrent or repeated publication cannot replace immutable evidence.

- [ ] **Step 4: Extend status tests with finalized UI evidence**

Add fixtures for `uiRunsRoot`. Assert `derivePluginStatus` returns:

```ts
{ state: 'pass', sessionId: 'ui-...' }
{ state: 'fail', sessionId: 'ui-...' }
{ state: 'stale', sessionId: 'ui-...', reasons: ['LAB_CONTEXT_CHANGED', 'PLUGIN_CONTENT_CHANGED', 'TARGET_PIN_CHANGED'] }
```

Assert exact target-pin matching for both targets, newest relevant UI result selection, corrupt UI evidence path reporting, `not-applicable` only for a proven `client: false`, and `not-run` for `true` or `unknown`. Snapshot the entire root before and after status to prove it is read-only.

- [ ] **Step 5: Run RED and commit only tests**

Run:

```text
pnpm vitest run tooling/src/ui-evidence.spec.ts tooling/src/status.spec.ts
```

Expected: FAIL because `ui-evidence.ts` and the `uiRunsRoot` behavior do not exist.

Commit:

```text
git add tooling/src/ui-evidence.spec.ts tooling/src/status.spec.ts
git commit -m "test: define UI evidence and status contract"
```

### Task 2: Luna GREEN — immutable UI evidence and plugin status

**Files:**
- Create: `tooling/src/ui-evidence.ts`
- Modify: `tooling/src/context.ts`
- Modify: `tooling/src/status.ts`
- Test: `tooling/src/ui-evidence.spec.ts`
- Test: `tooling/src/status.spec.ts`

**Interfaces:**
- Consumes the exact exports and assertions committed in Task 1.
- Produces `UiTargetIdentity`, `UiResultV1`, `normalizeUiSummary`, `publishUiResult`, and `loadUiResults` for Task 8.
- Adds `ROOT_PATHS.uiRuns = '.lab/ui-runs'`.
- Extends `derivePluginStatus(opts)` with optional `uiRunsRoot?: string` without changing existing callers.

- [ ] **Step 1: Implement exact validation and summary normalization**

Use exact-key validation at every object level. Validate the session pattern `^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$`, `sha256:` plus 64 lowercase hex characters, target discriminants, chronological timestamps, and 1..500 Unicode code points. Do not reuse verify's sanitizer because UI summaries reject invalid input instead of rewriting or truncating it.

- [ ] **Step 2: Implement safe immutable publication and loading**

Mirror the proven safety properties in `evidence.ts`: validate containment, reject symlink/junction components, create an exclusive publication lock, write an exclusive temporary regular file with mode `0600`, atomically rename, remove only the temporary file on failure, and reject an existing final result. Load only regular `result.json` files and return newest `finishedAt` first with deterministic `sessionId` tie-breaking.

- [ ] **Step 3: Integrate the newest UI result into status**

Load UI results separately from verify runs. Derive reasons with the existing uppercase reason vocabulary. Return a `sessionId` for finalized UI claims while preserving `runId` for verify claims; update `StatusClaim` to allow both optional identifiers. Inspection only determines applicability when no finalized UI result exists.

- [ ] **Step 4: Run tests and commit production only**

Run:

```text
pnpm vitest run tooling/src/ui-evidence.spec.ts tooling/src/status.spec.ts
pnpm typecheck
```

Expected: PASS.

Commit only `ui-evidence.ts`, `context.ts`, and `status.ts` with message `feat: add immutable UI evidence`.

- [ ] **Step 5: Independent task review**

Review Task 1's committed contract against Task 2's production diff. Require both spec compliance and code-quality approval before Task 3.

### Task 3: Controller RED — safe session leases and runtime plans

**Role:** Controller only. Do not dispatch this task to a production implementer.

**Files:**
- Create: `tooling/src/ui-session.spec.ts`
- Create: `tooling/src/ui-runtime.spec.ts`

**Interfaces under test:**
- Imports from `./ui-session.js`:

```ts
export type UiSessionPhase = 'starting' | 'ready' | 'crashed' | 'stopping' | 'finished' | 'aborted'
export type UiStaleReason = 'plugin-changed' | 'context-changed' | 'target-changed'
export interface UiSessionStateV1 {
  schemaVersion: 1
  sessionId: string
  state: UiSessionPhase
  plugin: { packageName: string; sourcePath: string; digest: `sha256:${string}` }
  target: UiTargetIdentity
  contextDigest: `sha256:${string}`
  staleReasons?: UiStaleReason[]
  supervisorPid?: number
  childPid?: number
  url?: string
  error?: string
  cleanup?: 'pass' | 'fail'
  startedAt: string
  updatedAt: string
}
export type UiControlV1 =
  | { schemaVersion: 1; action: 'finish'; requestedAt: string }
  | { schemaVersion: 1; action: 'abort'; requestedAt: string }

export function createUiSessionId(now?: Date, randomHex?: () => string): string
export function createUiSession(opts: { runtimeRoot: string; state: UiSessionStateV1 }): string
export function readUiSession(opts: { runtimeRoot: string; sessionId: string }): UiSessionStateV1
export function writeUiSession(opts: { runtimeRoot: string; state: UiSessionStateV1 }): void
export function writeUiControl(opts: { runtimeRoot: string; sessionId: string; control: UiControlV1 }): void
export function latchUiStaleReasons(state: UiSessionStateV1, reasons: UiStaleReason[], now: string): UiSessionStateV1
```

- Imports from `./ui-runtime.js`:

```ts
export interface UiRuntimePlan {
  sessionDir: string
  runtimeHome: string
  profileName: string
  profileDir: string
  overlayPath: string
  launcher: { cmd: string; args: string[] }
  argv: string[]
  cwd: string
}

export interface UiRuntimePlugin {
  packageName: string
  sourcePath: string
  runtimeName: string
}

export interface UiRuntimeDependencies {
  loadCompatibility(path: string): Compatibility
  resolveLauncher(root: string, target: 'next' | 'master', compatibility: Compatibility): Promise<{ cmd: string; args: string[] }>
  installNextProfile(profileDir: string, env: NodeJS.ProcessEnv): void
}

export async function prepareUiRuntime(opts: {
  root: string
  plugin: UiRuntimePlugin
  target: 'next' | 'master'
  sessionId: string
}, deps?: UiRuntimeDependencies): Promise<UiRuntimePlan>

export function buildUiRuntimeEnvironment(plan: UiRuntimePlan, inherited?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
```

- [ ] **Step 1: Test IDs and exact lease schemas**

Assert a fixed time and random suffix produce `ui-20260824T120000000Z-a1b2c3d4`. Reject traversal, separators, Unicode confusables, reserved device names, wrong suffixes, unknown fields, invalid phase-specific URL/PID fields, non-positive PIDs, non-loopback URLs, and timestamps that move backward. Require URL only for `ready`; allow an error only for `crashed`.

- [ ] **Step 2: Test contained atomic state/control writes**

Assert `createUiSession` exclusively creates one directory, `writeUiSession` and `writeUiControl` replace regular files atomically, readers reject corrupt JSON and identify the exact path, and symlinked/junction session components cannot redirect reads or writes. Assert unknown ID reads create nothing.

- [ ] **Step 3: Test stale latching and terminal compaction**

Assert reasons are deduplicated and sorted and cannot be removed by a later empty comparison. Assert `stopping` with completed finish cleanup has `cleanup: 'pass'` and no URL/PIDs, while `finished`/`aborted` rejects URL, PIDs, error, and control remnants.

- [ ] **Step 4: Test runtime planning and materialization**

For `next`, inject a launcher and installer and assert:

```ts
plan.profileName === 'example-next-ui-ui-20260824T120000000Z-a1b2c3d4'
plan.profileDir === join(sessionDir, 'home', 'profiles', plan.profileName)
plan.argv === [
  ...plan.launcher.args,
  '--profile', plan.profileName,
  '--patch', plan.overlayPath,
  '--host', '127.0.0.1',
  '--port', '0',
  '--no-open',
]
```

Assert the installer receives an in-memory environment with `DSH_HOME === runtimeHome`, while the returned plan and serialized JSON contain no `env` or inherited secret. Assert overlay content points at the plugin's absolute `src/index.ts`, the source tree is byte-identical, profile dependencies use the exact `next.dsh` pin, and two sessions share no writable path. For `master`, assert the exact pinned built upstream launcher is used and the profile references upstream by a correct relative `file:` path without running a profile-local install.

- [ ] **Step 5: Run RED and commit only tests**

Run `pnpm vitest run tooling/src/ui-session.spec.ts tooling/src/ui-runtime.spec.ts` and witness missing-module failures.

Commit only the two test files with message `test: define UI session runtime contract`.

### Task 4: Luna GREEN — safe session leases and runtime plans

**Files:**
- Create: `tooling/src/ui-session.ts`
- Create: `tooling/src/ui-runtime.ts`
- Modify: `tooling/src/run.ts`
- Test: `tooling/src/ui-session.spec.ts`
- Test: `tooling/src/ui-runtime.spec.ts`

**Interfaces:**
- Consumes Task 3's exact imports.
- Produces the safe persistent boundary and `UiRuntimePlan` consumed by Tasks 6 and 8.
- May export existing launcher/profile helpers from `run.ts`, but must preserve every existing `dev` and `verify` behavior and test.

- [ ] **Step 1: Implement the exact session validators and atomic store**

Centralize session ID and containment validation. Use exclusive creation for a new session, no-follow regular-file reads/writes, same-directory temporary files, and atomic rename. Never call recursive removal on an unresolved or unvalidated path.

- [ ] **Step 2: Implement monotonic state transitions and stale latching**

Allow only `starting→ready|crashed|stopping`, `ready→crashed|stopping`, `crashed→stopping`, and `stopping→finished|aborted|crashed`. Terminal states are immutable except idempotent rewrites of identical content.

- [ ] **Step 3: Implement unique runtime preparation**

Reuse `buildProfilePackageJson`, `buildProfileWorkspaceYaml`, `buildDevOverlay`, `DEV_WEB_BUNDLES`, and the existing pinned launcher/build rules. Materialize only under the session directory. Install `next` profile dependencies with `pnpm(['install', '--config.strictDepBuilds=false'], { cwd: profileDir, env, stdio: 'pipe' })`; build and validate `master` through the existing upstream boundary.

- [ ] **Step 4: Run tests and commit production only**

Run:

```text
pnpm vitest run tooling/src/ui-session.spec.ts tooling/src/ui-runtime.spec.ts tooling/src/run.spec.ts
pnpm typecheck
```

Commit only production files with message `feat: prepare isolated UI sessions`.

- [ ] **Step 5: Independent task review**

Require approval of path safety, exact target pinning, no plugin writes, and no regression in dev/verify before Task 5.

### Task 5: Controller RED — supervisor lifecycle

**Role:** Controller only. Do not dispatch this task to a production implementer.

**Files:**
- Create: `tooling/src/ui-supervisor.spec.ts`

**Interfaces under test:**

```ts
export interface UiSupervisorRequestV1 {
  schemaVersion: 1
  root: string
  sessionId: string
  plugin: UiRuntimePlugin
  target: 'next' | 'master'
  startedAt: string
}

export interface UiChildExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface UiChildHandle {
  pid: number
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  exited: Promise<UiChildExit>
}

export interface UiSupervisorDependencies {
  prepareRuntime(opts: { root: string; plugin: UiRuntimePlugin; target: 'next' | 'master'; sessionId: string }): Promise<UiRuntimePlan>
  spawnChild(plan: UiRuntimePlan): UiChildHandle
  stopChildTree(handle: UiChildHandle): Promise<void>
  now(): string
  sleep(ms: number): Promise<void>
  pollIntervalMs: number
  maxLogBytes: number
}

export function parseDshReadyUrl(line: string): string | undefined
export async function runUiSupervisor(request: UiSupervisorRequestV1, deps?: UiSupervisorDependencies): Promise<void>
```

- [ ] **Step 1: Test strict readiness parsing and bounded logs**

Accept only one complete readiness line whose first URL matches `^dsh web: (http://127\.0\.0\.1:[1-9][0-9]{0,4})`, with either end-of-line or the upstream optional ` (LAN: http://...)` display suffix after it. Capture only the loopback URL. Reject wildcard/localhost/HTTPS/userinfo/path/query/port 0/out-of-range ports, malformed suffixes, and lookalike stderr. Feed fragmented stdout chunks and require line-safe reconstruction. Keep only the newest 64 KiB in `supervisor.log`.

- [ ] **Step 2: Test lifecycle transitions with a fake child**

Cover `starting→ready`, exit-before-ready to `crashed`, exit-after-ready to `crashed`, finish control to cleaned `stopping` with `cleanup: 'pass'`, abort control to `stopping→aborted`, and repeated abort. Assert finish and abort stop exactly the owned handle once, await close, remove home/overlay/log/control, compact the lease, and never touch the plugin source.

- [ ] **Step 3: Test cleanup and orphan safety**

Inject a stop failure and assert the final state is `crashed` with a cleanup diagnostic and retained runtime path. Simulate a dead supervisor from the reader side and assert no fallback kill is issued solely from a recorded PID. On Windows, unit-test only the validated argument array `['/PID', String(pid), '/T', '/F']`; on POSIX, unit-test the owned negative process group. No test may kill a real unrelated process.

- [ ] **Step 4: Test concurrency isolation**

Run two fake supervisors concurrently and assert controls, logs, state transitions, child handles, and cleanup remain session-local.

- [ ] **Step 5: Run RED and commit only tests**

Run `pnpm vitest run tooling/src/ui-supervisor.spec.ts` and witness the missing-module failure.

Commit only the test with message `test: define UI supervisor lifecycle`.

### Task 6: Luna GREEN — supervisor lifecycle

**Files:**
- Create: `tooling/src/ui-supervisor.ts`
- Create: `tooling/src/ui-supervisor-bin.ts`
- Test: `tooling/src/ui-supervisor.spec.ts`

**Interfaces:**
- Consumes Task 5's exact interfaces and Task 4's session/runtime APIs. Runtime preparation and package installation happen inside the detached supervisor, not in the short-lived `ui start` CLI process.
- Produces `runUiSupervisor` and an executable bin used by `startUiSession` in Task 8.

- [ ] **Step 1: Implement chunk-safe readiness and bounded logging**

Parse stdout as lines while preserving an incomplete tail. Write bounded diagnostics only to the session log; state stores a sanitized short error. Never copy output into final evidence.

- [ ] **Step 2: Implement child ownership and transitions**

Spawn with `shell: false`, ignored stdin, piped stdout/stderr, and a dedicated process group where supported. Record PIDs only while active. Poll the atomic control file, transition monotonically, stop once, await close, then remove only validated session descendants. Finish ends in cleaned `stopping` so the service can publish evidence; abort ends directly in compact `aborted`.

- [ ] **Step 3: Implement platform cleanup**

The live supervisor may use `taskkill.exe` with validated numeric PID on Windows or signal its owned process group on POSIX. The bin deserializes one request-file path, validates containment, runs one supervisor, reports failures into the lease, and never accepts arbitrary command text.

- [ ] **Step 4: Run tests and commit production only**

Run `pnpm vitest run tooling/src/ui-supervisor.spec.ts tooling/src/ui-session.spec.ts` and `pnpm typecheck`.

Commit only the two production files with message `feat: supervise UI runtime lifecycle`.

- [ ] **Step 5: Independent task review**

Require approval of process ownership, Windows/POSIX cleanup, readiness strictness, bounded logging, and terminal cleanup before Task 7.

### Task 7: Controller RED — public UI service protocol

**Role:** Controller only. Do not dispatch this task to a production implementer.

**Files:**
- Create: `tooling/src/ui.spec.ts`

**Interfaces under test:**

```ts
export interface StartUiOptions { root: string; plugin: PluginRef; target: 'next' | 'master'; startupTimeoutMs?: number }
export interface FinishUiOptions { root: string; sessionId: string; verdict: 'pass' | 'fail'; summary: string; stopTimeoutMs?: number }
export interface AbortUiOptions { root: string; sessionId: string; stopTimeoutMs?: number }

export interface UiSessionViewV1 {
  schemaVersion: 1
  sessionId: string
  state: UiSessionPhase
  stale: boolean
  staleReasons: UiStaleReason[]
  plugin: UiSessionStateV1['plugin']
  target: UiTargetIdentity
  contextDigest: `sha256:${string}`
  url?: string
  error?: string
  cleanup?: 'pass' | 'fail'
  startedAt: string
  updatedAt: string
}

export interface UiServiceDependencies {
  spawnSupervisor(requestPath: string): { pid: number; unref(): void }
  sleep(ms: number): Promise<void>
  now(): string
  processAlive(pid: number): boolean
  publishResult(opts: { uiRunsRoot: string; result: UiResultV1 }): string
}

export async function startUiSession(opts: StartUiOptions, deps?: UiServiceDependencies): Promise<UiSessionViewV1>
export function getUiSessionStatus(
  opts: { root: string; sessionId: string },
  deps?: Pick<UiServiceDependencies, 'now' | 'processAlive'>,
): UiSessionViewV1
export async function finishUiSession(opts: FinishUiOptions, deps?: UiServiceDependencies): Promise<UiResultV1>
export async function abortUiSession(opts: AbortUiOptions, deps?: UiServiceDependencies): Promise<UiSessionViewV1>
```

- [ ] **Step 1: Test start validation and readiness wait**

Assert start resolves current plugin/context/target identities and a safe `runtimeName` before launching, rejects invalid inspection/entry/declared target, creates a unique `starting` lease and environment-free request, spawns `process.execPath` with `ui-supervisor-bin` and one request path using `{ detached: true, shell: false, stdio: 'ignore' }`, calls `unref()`, then waits up to 120 seconds for `ready` or `crashed`. Runtime preparation is not called by the CLI process. Inject a 10 ms timeout and assert cleanup is requested and awaited.

- [ ] **Step 2: Test bounded session status and stale latching**

Assert status computes `plugin-changed`, `context-changed`, and `target-changed`, writes only when it must latch a newly observed reason, never creates unknown sessions, reports a dead supervisor as orphaned/crashed without calling a PID killer, and returns the URL only for a current ready lease.

- [ ] **Step 3: Test finish rules and publication order**

Assert pass is allowed only after readiness; fail is allowed after ready or crash; summary validation happens before control; stale sessions publish nothing; cleaned `stopping` with `cleanup: 'pass'` is awaited before `publishUiResult`; pass/fail evidence has the captured identities and `cleanup: 'pass'`; the service writes compact `finished` only after publication. Assert a publication failure leaves a diagnosable cleaned `stopping` lease and an existing finalized result can never be replaced.

- [ ] **Step 4: Test abort rules**

Assert starting/ready/crashed may abort, aborted is idempotent, finished rejects abort, no abort path calls `publishUiResult`, timeout or cleanup failure remains a visible non-success, and no screenshot-like file is created under runtime or UI runs.

- [ ] **Step 5: Run RED and commit only tests**

Run `pnpm vitest run tooling/src/ui.spec.ts` and witness the missing-module failure.

Commit only the test with message `test: define public UI session service`.

### Task 8: Luna GREEN — public UI service protocol

**Files:**
- Create: `tooling/src/ui.ts`
- Modify: `tooling/src/ui-session.ts`
- Test: `tooling/src/ui.spec.ts`

**Interfaces:**
- Consumes Tasks 2, 4, 6, and 7.
- Produces the four service functions consumed only by the CLI in Task 10.

- [ ] **Step 1: Implement identity capture and comparison**

Use `computePluginDigest`, the canonical context hash, and parsed compatibility pins. Share the context digest helper with status rather than maintaining two algorithms. Compare structured targets and latch deterministic lowercase session reasons.

- [ ] **Step 2: Implement detached start and bounded waits**

Serialize a validated request under the session directory, start the supervisor bin without a shell, unref it, and poll atomic state. On timeout write abort control, await cleanup, and return a tooling error with the session ID and exact runtime path.

- [ ] **Step 3: Implement finish and abort**

Validate before mutating, write one atomic control request, wait for cleaned `stopping`, publish only after cleanup, then write compact `finished`. Abort waits for compact `aborted` and never publishes. Preserve immutable evidence semantics and never infer a verdict from logs or browser state.

- [ ] **Step 4: Run tests and commit production only**

Run:

```text
pnpm vitest run tooling/src/ui.spec.ts tooling/src/ui-supervisor.spec.ts tooling/src/ui-session.spec.ts tooling/src/ui-evidence.spec.ts tooling/src/status.spec.ts
pnpm typecheck
```

Commit production files with message `feat: add UI session service`.

- [ ] **Step 5: Independent task review**

Require approval of ordering, stale behavior, timeout cleanup, immutable failure handling, and absence of workflow/browser ownership before Task 9.

### Task 9: Controller RED — CLI, docs, and portable skill

**Role:** Controller only. Do not dispatch this task to a production implementer.

**Files:**
- Modify: `tooling/src/cli.spec.ts`
- Modify: `tooling/src/skill.spec.ts`

**Interfaces under test:**
- CLI dispatches only to the four Task 8 service functions.
- Documentation source is canonical `context/*`; `.agents/skills/dsh-plugin-development/SKILL.md` is generated, never hand-edited.

- [ ] **Step 1: Add command grammar tests**

Cover the four valid forms, name versus `--path`, required target/verdict/summary/session ID, duplicate flags, unknown flags, invalid target/verdict, and absence of `verify --ui`. Mock service calls and assert exact option objects.

- [ ] **Step 2: Add output and exit-code tests**

For every subcommand, assert JSON mode produces exactly one parseable stdout document and progress/errors remain off stdout. Assert exit `0`, `2`, and `1` according to the spec, including finish-fail exiting `2` after successful evidence publication.

- [ ] **Step 3: Add help/docs/skill contract tests**

Assert CLI help, README, author guide, canonical testing policy, canonical skill source, and generated skill describe `ui start/status/finish/abort`, external browser/vision ownership, temporary isolated runtime, minimal verdict, and no retained screenshots. Assert none claims that SDD, agent-browser, or a particular harness is mandatory.

- [ ] **Step 4: Run RED and commit only tests**

Run `pnpm vitest run tooling/src/cli.spec.ts tooling/src/skill.spec.ts` and witness failures for missing command/docs text.

Commit only tests with message `test: define UI CLI and guidance contract`.

### Task 10: Luna GREEN — CLI, docs, and portable skill

**Files:**
- Modify: `tooling/src/cli.ts`
- Modify: `context/testing-policy.md`
- Modify: `context/dsh-plugin-development-skill.md`
- Modify: `docs/using-the-lab.md`
- Modify: `README.md`
- Generate: `.agents/skills/dsh-plugin-development/SKILL.md`
- Test: `tooling/src/cli.spec.ts`
- Test: `tooling/src/skill.spec.ts`

**Interfaces:**
- Consumes Task 8's four service functions and exact result/view types.
- Produces the user-facing protocol and canonical agent guidance.

- [ ] **Step 1: Parse the nested command family strictly**

Add a dedicated parser that consumes every token exactly once. Preserve existing selector parsing behavior for `name` and `--path`. Do not let `--summary` values be mistaken for selectors or allow unknown flags through.

- [ ] **Step 2: Render stable human and JSON output**

Suppress internal progress in JSON mode. Human `start` prints session ID and URL; `status` prints phase and stale remediation; `finish` prints verdict and evidence identity; `abort` prints terminal state. Map protocol outcomes to exact exit codes without treating a recorded fail as a tooling error.

- [ ] **Step 3: Update canonical guidance and regenerate**

Document that an external agent chooses browser/vision tooling and keeps screenshots transient. Recommend but do not enforce SDD or agent-browser. Run `pnpm lab sync-context --all`; never edit the generated skill directly.

- [ ] **Step 4: Run targeted and full verification**

Run:

```text
pnpm vitest run tooling/src/cli.spec.ts tooling/src/skill.spec.ts
pnpm test
pnpm typecheck
pnpm lab sync-context --all
pnpm lab sync-context --all
git diff --check
```

The second sync must report every projection current.

Commit production/docs/generated projection with message `feat: expose UI session protocol`.

- [ ] **Step 5: Independent task review**

Require approval of grammar, JSON purity, exit semantics, canonical-source ownership, and non-enforcement language.

### Task 11: Whole-branch acceptance and integration

**Role:** Controller coordinates; no production implementation unless a reviewed finding requires one fix wave.

**Files:**
- Read: all changed files
- Runtime only: `.lab/runtime/ui-sessions/*`
- Evidence only: `.lab/ui-runs/*`

**Interfaces:**
- Consumes the complete Stage 3 branch.
- Produces acceptance evidence and a reviewed integration candidate.

- [ ] **Step 1: Build the final review package**

Use the branch merge base `d9473a9fbbdb84bbd8b52da94cd2f88178a15813`, include every commit/diff plus the SDD ledger, and run the broad research review on `gpt-5.6-sol`. Require explicit spec-compliance and code-quality verdicts. If findings exist, use one Luna fix wave and one scoped independent re-review.

- [ ] **Step 2: Run deterministic acceptance in the temporary worktree**

Run the full test/typecheck/sync/diff-check sequence from Task 10. Also run `pnpm lab doctor` and verify no tracked or untracked `SKILL.md` exists outside `.agents/skills/dsh-plugin-development/SKILL.md`.

- [ ] **Step 3: Run a real pinned DSH UI session**

Materialize a valid temporary fixture plugin under forge-owned runtime or use a valid existing client-face plugin without modifying its repository. Start `next`, fetch the returned loopback URL, inspect it with an external vision-capable browser agent, finish with a short pass/fail summary, and confirm the final `result.json` has only `UiResultV1` keys. Do not retain screenshots.

- [ ] **Step 4: Prove cleanup and staleness**

Confirm the finished session has no profile, overlay, log, control, PID, URL, browser artifact, or environment residue. Start another session, change a copied fixture input, observe and latch staleness, prove finish refuses publication, then abort and prove cleanup.

- [ ] **Step 5: Integrate and re-run from the main checkout**

Fast-forward only after the user-owned dirty main checkout has been re-inspected and preserved. Re-run full deterministic acceptance from main. Remove the temporary worktree only after main acceptance passes; do not delete user files or the recovery stash.
