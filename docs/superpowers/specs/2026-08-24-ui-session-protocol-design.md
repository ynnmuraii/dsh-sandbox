# UI Session Protocol Design

**Date:** 2026-08-24

**Status:** Approved for implementation

## Purpose

`dsh-lab` must let an agent verify a plugin's browser-facing behavior without turning the lab into a browser automation framework or a human workflow engine. The lab owns an isolated, temporary DSH runtime and factual evidence. The calling agent or its harness owns the browser, visual reasoning, screenshots used as working material, and the decision to pass or fail the check.

The protocol is deliberately a separate command family. `lab verify` continues to prove source and package boundaries; UI verification is a live source-overlay session whose result can be inspected independently.

## Scope

This stage adds four commands:

```text
pnpm lab ui start <name>|--path P --target next|master [--json]
pnpm lab ui status <session-id> [--json]
pnpm lab ui finish <session-id> --verdict pass|fail --summary "..." [--json]
pnpm lab ui abort <session-id> [--json]
```

It also extends `pnpm lab status <name>|--path P` with one `ui` claim derived from finalized UI evidence.

This stage does not add browser automation, screenshot retention, an approval engine, real API credentials, release checks, or `verify --ui`.

## Ownership boundary

The lab owns:

- a temporary source-overlay DSH process;
- exact plugin, target, and shared-context identities captured at start;
- a small active-session lease under `.lab/runtime`;
- deterministic cleanup of forge-owned runtime descendants;
- one minimal immutable verdict document after `finish`.

The agent or harness owns:

- which browser or vision mechanism to use;
- navigation, interactions, visual assertions, and exploratory notes;
- transient screenshots, DOM snapshots, traces, and recordings;
- the semantic meaning of the final summary;
- planning, approvals, retry policy, and cross-session memory.

The skill may recommend `agent-browser`, a vision-capable agent, SDD, or TDD. The lab never requires any of them.

## Command contract

### `ui start`

`start` resolves the plugin exactly as `inspect`, `dev`, and `verify` do. It rejects an invalid plugin, invalid target, unsafe runtime identity, or a plugin with no usable entry point before launching DSH.

It creates a unique session, captures the current input identity, starts a detached supervisor, and waits for either readiness or a bounded startup failure. On success it returns:

```json
{
  "schemaVersion": 1,
  "sessionId": "ui-20260824T120000000Z-a1b2c3d4",
  "state": "ready",
  "url": "http://127.0.0.1:49152",
  "plugin": {
    "packageName": "@scope/plugin",
    "sourcePath": "A:\\plugins\\plugin",
    "digest": "sha256:..."
  },
  "target": {
    "name": "next",
    "dsh": "0.1.1-rc.2"
  },
  "contextDigest": "sha256:...",
  "startedAt": "2026-08-24T12:00:00.000Z"
}
```

The URL is loopback-only. It is session state, not finalized evidence.

### `ui status`

`status` does not create sessions, evidence, profiles, controls, or processes. It loads the named lease, validates it, refreshes process liveness, and compares the captured identities with current inputs. Its only permitted write is an atomic rewrite of that existing lease to latch a newly observed stale reason. It returns the operational state, the loopback URL when known, and zero or more stale reasons.

Stable operational states are:

- `starting` — the supervisor exists but DSH has not announced readiness;
- `ready` — DSH announced a loopback URL and the process is alive;
- `crashed` — startup or the running DSH child exited unexpectedly;
- `stopping` — a finish or abort control request is being processed, or finish cleanup completed and evidence publication is pending;
- `finished` — cleanup completed and immutable evidence was published;
- `aborted` — cleanup completed without publishing evidence.

`stale` is not a replacement operational state. It is derived as `stale: true` plus stable reason codes:

- `plugin-changed`;
- `context-changed`;
- `target-changed`.

### `ui finish`

`finish` validates the session, verdict, and summary, then re-computes all current identities. If any input is stale it refuses to publish a result and leaves the live session available for explicit abort. The agent must start a new session for changed inputs.

A `pass` verdict requires a session that reached `ready`. A `fail` verdict is accepted from `ready` or `crashed`, provided the captured inputs are still current. This lets an agent record a factual failed UI attempt after observing a plugin crash.

The supervisor must stop the DSH process tree and remove the session's profile, overlay, temporary log, and control files before a result is finalized. Cleanup failure is an operation failure: a `pass` result must never be published while forge-owned runtime remains unaccounted for.

After successful cleanup, the supervisor rewrites `stopping` with `cleanup: 'pass'` and no live process fields. The finishing CLI atomically publishes one immutable `UiResultV1`, changes the lease to `finished`, and removes the ordinary runtime descendants. The compact terminal lease may remain so `ui status <session-id>` can report `finished`; it contains no URL, PID, environment, log, or browser artifact. Abort skips the publication boundary and the supervisor writes `aborted` after cleanup.

### `ui abort`

`abort` requests deterministic process-tree cleanup and publishes no evidence. It may abort `starting`, `ready`, or `crashed` sessions. Repeating abort for an already `aborted` session is idempotent. Aborting a `finished` session is rejected because finalized evidence is immutable.

## Output and exit codes

With `--json`, stdout contains exactly one JSON document and no progress text. Diagnostics and progress go to stderr. Human output remains concise and includes the session ID, state, URL when ready, and remediation when the session is stale or orphaned.

Exit codes are stable:

| Code | Meaning |
| --- | --- |
| `0` | successful start, current ready status, successful pass finalization, or successful abort |
| `2` | valid non-pass state: starting, crashed, stale, recorded fail verdict, or cleanup still incomplete |
| `1` | usage error, unknown/corrupt session, unsafe path, startup tooling failure, or other protocol failure |

`ui finish --verdict fail` publishes the failure evidence and exits `2`.

## Identity and staleness

The session captures the same content model used by verification status:

- plugin package name and canonical source path;
- plugin content digest from the lab's existing plugin snapshot rules;
- shared-context digest from canonical `context/*`;
- exact compatibility pin: `dsh` for `next`, `commit` for `master`.

The snapshot digest excludes VCS internals, dependencies, build output, `.lab`, credentials, and other derived/runtime paths according to the existing snapshot policy. UI start reads plugin files but never writes into the plugin repository.

The lab compares structured target identity, not only the target name. Editing the `next` DSH version or the `master` commit makes a session and its result stale.

## Runtime layout

Every active session is contained by a validated, forge-owned directory:

```text
.lab/runtime/ui-sessions/<session-id>/
  state.json
  request.json
  control.json
  supervisor.log
  overlay/cordis.patch.yml
  home/profiles/<profile-name>/
```

`state.json` is written atomically by the supervisor and contains only the data needed for lifecycle control:

```ts
interface UiSessionStateV1 {
  schemaVersion: 1
  sessionId: string
  state: 'starting' | 'ready' | 'crashed' | 'stopping' | 'finished' | 'aborted'
  plugin: { packageName: string; sourcePath: string; digest: string }
  target: { name: 'next'; dsh: string } | { name: 'master'; commit: string }
  contextDigest: string
  staleReasons?: Array<'plugin-changed' | 'context-changed' | 'target-changed'>
  supervisorPid?: number
  childPid?: number
  url?: string
  error?: string
  cleanup?: 'pass' | 'fail'
  startedAt: string
  updatedAt: string
}
```

The normal `finished` or `aborted` terminal lease is rewritten without `supervisorPid`, `childPid`, `url`, or `error`. Runtime profiles and overlays are session-unique; concurrent sessions never share writable files.

Session IDs match `^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$`. Every path derived from an ID is checked for containment and rejected if a relevant path component is a symlink or other non-directory entry.

## Supervisor and DSH launch

The CLI process must not own the long-running DSH child. `ui start` launches a detached Node supervisor for one session and communicates through atomic files in the session directory.

The supervisor:

1. materializes a unique source overlay and web profile under the session directory;
2. installs the exact target-owned profile dependencies using existing target policy;
3. launches the pinned DSH entry point without a shell;
4. passes the materialized profile, overlay, `--host 127.0.0.1`, `--port 0`, and `--no-open`;
5. directs `DSH_HOME` and any generated state into the session runtime;
6. builds the child environment in memory from the inherited environment plus the session-local `DSH_HOME`; no environment is serialized into `request.json` or state;
7. captures stdout and stderr to a temporary log capped at 64 KiB;
8. recognizes readiness only from an upstream `dsh web: http://127.0.0.1:<port>` line, tolerating its optional LAN display suffix while discarding that suffix;
9. atomically publishes `ready` with only the parsed loopback URL;
10. listens for a finish or abort control request;
11. terminates the owned DSH process tree and removes session runtime descendants;
12. writes `stopping` with `cleanup: 'pass'` for finish, or compact `aborted` for abort.

The upstream contract explicitly supports port `0`, so the lab never probes and releases a port before launch. Wildcard binding is prohibited. Launch arguments are arrays passed without shell interpolation.

On Windows, the live supervisor may terminate its child tree with `taskkill.exe /PID <validated-pid> /T /F`; on POSIX it owns a dedicated process group and terminates that group. A later CLI invocation must not blindly kill a recorded PID after possible PID reuse. If the supervisor is gone and child ownership cannot be demonstrated from the live session identity, the lab reports an orphan with the exact runtime path and does not risk terminating an unrelated process.

Startup has a configurable internal deadline for tests and a fixed user-facing default of 120 seconds. A timeout asks the live supervisor to clean up; it is a tooling failure unless cleanup itself remains incomplete, which is reported explicitly.

## Final evidence

Finalized UI evidence is separate from ordinary verify evidence:

```text
.lab/ui-runs/<plugin-key>/<session-id>/result.json
```

The plugin key uses the same collision-resistant package/source identity strategy as verify evidence. Publication uses the same containment, non-symlink, temporary-file, atomic-rename, and immutable-finalization guarantees.

```ts
interface UiResultV1 {
  schemaVersion: 1
  sessionId: string
  operation: 'ui'
  verdict: 'pass' | 'fail'
  plugin: { packageName: string; sourcePath: string; digest: string }
  target: { name: 'next'; dsh: string } | { name: 'master'; commit: string }
  lab: { contextDigest: string }
  summary: string
  cleanup: 'pass'
  startedAt: string
  finishedAt: string
}
```

`summary` is trimmed, must contain 1 through 500 Unicode code points, rejects control characters other than ordinary spaces, and is stored as plain text. The evidence schema has no extension bag and rejects unknown properties. It cannot contain URLs, PIDs, environment values, screenshots, DOM, traces, videos, browser scripts, or credentials.

## Plugin status integration

`lab status <plugin>` adds:

```ts
ui: {
  state: 'pass' | 'fail' | 'stale' | 'not-run' | 'not-applicable'
  sessionId?: string
  reasons?: Array<'PLUGIN_CONTENT_CHANGED' | 'LAB_CONTEXT_CHANGED' | 'TARGET_PIN_CHANGED'>
}
```

The newest valid finalized UI result for the plugin is selected. A matching result reports its verdict. A mismatched result reports `stale` with deterministic reasons. Missing evidence reports:

- `not-applicable` only when inspection proves the plugin has no client face;
- `not-run` when the client face is present or unknown.

An active session does not count as finalized status evidence. `lab status` remains read-only and never creates a lease, profile, snapshot, or evidence directory.

## Failure and recovery rules

- Invalid or corrupt JSON is an explicit error containing the affected path.
- A child exit before readiness becomes `crashed`; the bounded log tail may be shown in command diagnostics but is never copied into evidence.
- A child exit after readiness also becomes `crashed`.
- A cleanup error preserves enough runtime state to diagnose the orphan and prevents `finished` or `aborted` success.
- An immutable result cannot be replaced, even with identical content.
- A stale session cannot be finalized. Once `status` or `finish` observes an identity mismatch, the stale reasons are latched in the lease; changing files back does not repair that session.
- Unknown session IDs and path traversal attempts are rejected without filesystem mutation.
- Concurrent start calls get different IDs, profiles, overlays, DSH homes, and ports.

## Security and privacy

- Bind only to `127.0.0.1`; never expose DSH's code-executing UI to the network.
- Do not invoke a shell for DSH, package manager, or cleanup arguments.
- Do not persist process environments or print secret values.
- Keep credentials in the caller's ignored runtime environment; evidence excludes them.
- Enforce path containment before every write, rename, removal, or process-control lookup.
- Treat symlinked session, plugin-key, and result directories as unsafe.
- Keep temporary logs bounded and remove them on normal finish or abort.

## Verification strategy

The implementation must be driven by controller-owned tests. Production implementers may not edit test files without controller approval.

Required automated coverage:

- session/result schema validation, summary normalization, unknown-field rejection, and safe IDs;
- atomic immutable evidence publication and symlink/path-containment defenses;
- current and stale result derivation for plugin, context, and exact target pin changes;
- `not-run` versus `not-applicable` client-face behavior;
- unique source overlays, profiles, homes, and launcher argument order;
- loopback host, OS-assigned port, no browser opening, and readiness parsing;
- fake-child lifecycle for start, ready, status, finish-pass, finish-fail, abort, crash, timeout, cleanup failure, and concurrency;
- safe orphan behavior without blind PID termination;
- CLI parsing, stdout JSON purity, stderr diagnostics, and exit codes;
- byte-identical plugin source before and after every lifecycle;
- absence of screenshot/browser artifact fields and files;
- full root test suite and typecheck.

Acceptance against a real pinned DSH target must prove that a session reaches a fetchable loopback URL, an external browser/vision agent can inspect it, the minimal verdict is published, and runtime descendants are cleaned. If the fixture plugin's client face cannot be proven, the acceptance verdict is `not-applicable`; lifecycle correctness is still proven with the real web host plus deterministic fake-client tests. Acceptance screenshots remain transient and are not stored by the lab.

## Documentation

`docs/using-the-lab.md`, `README.md`, CLI help, and the generated portable skill must explain the command family and ownership boundary. Shared guidance is edited in `context/*`; `.agents/skills/dsh-plugin-development/SKILL.md` is regenerated with `pnpm lab sync-context` and passes the drift gate.

## Non-goals

- choosing or installing a browser tool;
- recording a browser transcript;
- retaining screenshots or videos;
- evaluating visual quality inside the lab;
- agent memory, approvals, task orchestration, or SDD enforcement;
- API-key test infrastructure;
- package publication or release automation;
- changing plugin Git state;
- replacing source and bundle verification.
