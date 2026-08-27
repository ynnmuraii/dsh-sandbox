import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { statusExitCode, UI_SESSION_ID_PATTERN } from '../cli.js'
import { NAME_RE } from '../create.js'
import {
  handleCreatePlugin,
  handleDevStart,
  handleDevStatus,
  handleDevStop,
  handleDoctor,
  handleGetEvidence,
  handleInspect,
  handleListPlugins,
  handleStatus,
  handleSyncContext,
  handleUiAbort,
  handleUiFinish,
  handleUiStart,
  handleUiStatus,
  handleVerify,
  ToolError,
} from './handlers.js'
import type { VerifyPluginDependencies } from '../verify.js'
import type { UiServiceDependencies } from '../ui.js'
import { DEV_SESSION_ID_PATTERN } from '../dev-session-state.js'
import type { DevServiceDependencies } from '../dev-session.js'

type DshLabMeta = Record<string, unknown>

// Structured success result: content JSON + structuredContent + `_meta.dshLab`.
// The SDK's CallToolResult._meta is a loose object, so adding a `dshLab` key is
// protocol-compatible (serverInfo and other keys coexist).
function success<T>(structured: T, meta: DshLabMeta): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
    structuredContent: structured as unknown as Record<string, unknown>,
    _meta: { dshLab: meta },
  }
}

// Structured tool error: content `CODE: message`, isError true, `_meta.dshLab`.
function toolError(code: string, message: string, exitCode: number): CallToolResult {
  return {
    content: [{ type: 'text' as const, text: `${code}: ${message}` }],
    isError: true,
    _meta: { dshLab: { code, exitCode } },
  }
}

// Exit-code class mirrors the CLI --json exit contract: 0 = pass, 2 = expected
// non-pass outcome, 1 = misuse/corruption/tooling failure. Only the UI stale/
// cleanup-incomplete outcomes are exit-2; everything else is exit-1.
function toolErrorExitCode(error: unknown): number {
  if (
    error instanceof ToolError &&
    (error.code === 'UI_STALE' || error.code === 'UI_CLEANUP_INCOMPLETE' || error.code === 'DEV_CLEANUP_INCOMPLETE')
  ) {
    return 2
  }
  return 1
}

// Doctor metadata: mirrors cli.ts `report()` (1 if any error, else 0) and
// exposes hasError for the caller. Pure and exported for direct unit tests.
export function doctorMeta(diagnostics: readonly { level: string; message: string }[]): { hasError: boolean; exitCode: number } {
  const hasError = diagnostics.some(d => d.level === 'error')
  return { hasError, exitCode: hasError ? 1 : 0 }
}

export interface McpServerOptions {
  verifyDeps?: Partial<VerifyPluginDependencies>
  uiDeps?: Partial<UiServiceDependencies>
  devDeps?: Partial<DevServiceDependencies>
  allowAuthoring?: boolean
}

export function buildServer(root: string, options?: McpServerOptions): McpServer {
  const server = new McpServer({ name: 'dsh-lab', version: '0.0.0' })

  server.registerTool(
    'dsh_lab.list_plugins',
    {
      description:
        "List plugins registered in the lab catalog. Returns [{ name, path, tracking: 'local'|'submodule', maturity }]. Use `name` as the `plugin` argument for other tools; use `path` for standalone plugin directories outside the catalog.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      try {
        const result = handleListPlugins(root)
        return success(result, { exitCode: 0 })
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return toolError(code, message, toolErrorExitCode(e))
      }
    },
  )

  server.registerTool(
    'dsh_lab.inspect',
    {
      description:
        "Inspect a plugin's source contracts without executing plugin code. Returns { plugin, faces: { host: boolean, client: boolean | 'unknown' — 'unknown' means no dsh.client browser-face declaration found }, diagnostics: [{ code, severity, message, location?, remediation? }], ok }. ok=false when any error-severity diagnostic exists. Live advisory check — not persisted evidence; see dsh_lab.status for recorded verification state. Failures return isError results with text 'CODE: message'.",
      inputSchema: z
        .object({
          plugin: z.string().min(1).describe('Catalog plugin name (enumerate via dsh_lab.list_plugins)').optional(),
          path: z
            .string()
            .min(1)
            .describe('Absolute path to a standalone plugin directory — exactly one of plugin or path is required')
            .optional(),
          target: z.enum(['next', 'master']).optional().describe('Target to validate against; omit to validate all declared targets'),
        })
        .strict()
        .refine(
          data => (data.plugin !== undefined) !== (data.path !== undefined),
          { message: 'exactly one of plugin or path is required' },
        ),
    },
    async args => {
      try {
        const result = handleInspect(root, args as { plugin?: string; path?: string; target?: 'next' | 'master' })
        return success(result, { exitCode: result.ok ? 0 : 1, ok: result.ok })
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return toolError(code, message, toolErrorExitCode(e))
      }
    },
  )

  server.registerTool(
    'dsh_lab.status',
    {
      description:
        "Get RECORDED verification status for a plugin (from persisted evidence — not a live check; use dsh_lab.inspect for live contract checks). Returns { plugin { packageName, sourcePath, digest }, structure, bundle, targets: { next, master }, ui } where each claim is { state: 'pass' | 'fail' | 'stale' | 'not-run' | 'not-applicable', ... }. not-run = no recorded evidence; stale = evidence exists but source digest, context digest, or target pins changed since.",
      inputSchema: z
        .object({
          plugin: z.string().min(1).describe('Catalog plugin name (enumerate via dsh_lab.list_plugins)').optional(),
          path: z
            .string()
            .min(1)
            .describe('Absolute path to a standalone plugin directory — exactly one of plugin or path is required')
            .optional(),
        })
        .strict()
        .refine(
          data => (data.plugin !== undefined) !== (data.path !== undefined),
          { message: 'exactly one of plugin or path is required' },
        ),
    },
    async args => {
      try {
        const result = handleStatus(root, args as { plugin?: string; path?: string })
        return success(result, { exitCode: statusExitCode(result) })
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return toolError(code, message, toolErrorExitCode(e))
      }
    },
  )

  server.registerTool(
    'dsh_lab.doctor',
    {
      description:
        "Validate the forge itself: toolchain pins (node/pnpm), catalog, target pins, upstream submodule, context snapshots, runtime hygiene. Returns DiagnosticResult[] — AN EMPTY ARRAY MEANS HEALTHY. Entries: { level: 'error' | 'warn', message }; warn items (e.g. stale runtime artifacts) do not block.",
      inputSchema: z.object({}).strict(),
    },
    async () => {
      try {
        const result = await handleDoctor(root)
        return success(result, doctorMeta(result))
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return toolError('DOCTOR_FAILED', message, 1)
      }
    },
  )

  server.registerTool(
    'dsh_lab.verify',
    {
      description:
        "Verify a plugin end-to-end: inspect → snapshot → build+pack in a temp workspace → install via dsh plugin add → compose against the pinned target. LONG-RUNNING (minutes; spawns pnpm/dsh with your user rights — the call stays open until done; no isolation). Returns VerifyRunResultV1 { runId, result: 'pass'|'fail'|'blocked', targets: {next, master}, steps: [{ id, status, durationMs, summary?, code?, detail? }], cleanup, environment, startedAt, finishedAt }. Per-target/step failures are NOT tool errors — result:'fail' carries step codes (e.g. pnpm.build.fail, dsh.plugin-add.fail) for branching. If the client drops mid-run, the finalized result is still persisted: re-query via dsh_lab.status / dsh_lab.get_evidence. Prerequisite failures (missing/dirty upstream for master, undeclared target) return isError with code VERIFY_PREREQ. target 'all' runs both declared targets sequentially.",
      inputSchema: z
        .object({
          plugin: z.string().min(1).describe('Catalog plugin name (enumerate via dsh_lab.list_plugins)').optional(),
          path: z
            .string()
            .min(1)
            .describe('Absolute path to a standalone plugin directory — exactly one of plugin or path is required')
            .optional(),
          target: z.enum(['next', 'master', 'all']).optional().describe("Target to verify (default inferred from plugin metadata; 'all' runs both declared targets)"),
        })
        .strict()
        .refine(
          data => (data.plugin !== undefined) !== (data.path !== undefined),
          { message: 'exactly one of plugin or path is required' },
        ),
    },
    async args => {
      try {
        const typed = args as { plugin?: string; path?: string; target?: 'next' | 'master' | 'all' }
        const result = await handleVerify(root, typed, options?.verifyDeps)
        return success(result, { exitCode: result.result === 'pass' ? 0 : 1, result: result.result, runId: result.runId })
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return toolError(code, message, toolErrorExitCode(e))
      }
    },
  )

  server.registerTool(
    'dsh_lab.get_evidence',
    {
      description:
        'Load persisted verification evidence for a plugin, newest-first. Returns { verify: VerifyRunResultV1[], ui: UiResultV1[] } — empty arrays mean nothing recorded yet. kind selects which lists to fill; limit caps each (default 10, max 50).',
      inputSchema: z
        .object({
          plugin: z.string().min(1).describe('Catalog plugin name (enumerate via dsh_lab.list_plugins)').optional(),
          path: z
            .string()
            .min(1)
            .describe('Absolute path to a standalone plugin directory — exactly one of plugin or path is required')
            .optional(),
          kind: z.enum(['verify', 'ui', 'all']).optional().default('all').describe('Which evidence lists to fill'),
          limit: z.number().int().min(1).max(50).optional().default(10).describe('Maximum entries per list (newest-first)'),
        })
        .strict()
        .refine(
          data => (data.plugin !== undefined) !== (data.path !== undefined),
          { message: 'exactly one of plugin or path is required' },
        ),
    },
    async args => {
      try {
        const typed = args as { plugin?: string; path?: string; kind?: 'verify' | 'ui' | 'all'; limit?: number }
        const result = handleGetEvidence(root, typed)
        return success(result, { exitCode: 0 })
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return toolError(code, message, toolErrorExitCode(e))
      }
    },
  )
  server.registerTool(
    'dsh_lab.ui_start',
    {
      description:
        "Start an isolated UI session for a plugin against a pinned target. Creates a detached supervisor that boots the DSH harness with an overlay for the plugin. BOUNDED LONG-RUNNING: blocks up to startupTimeoutMs (default 120000, range 1000..600000, poll 25ms) waiting for state to leave 'starting'; typically <5s, returns as soon as state is 'ready' or 'crashed'. Returns UiSessionViewV1 { schemaVersion:1, sessionId:'ui-YYYYMMDDTHHMMSSZ-xxxxxxxx', state:'starting'|'ready'|'crashed'|'stopping'|'finished'|'aborted', stale:boolean, staleReasons:('plugin-changed'|'context-changed'|'target-changed')[] — latch and never un-latch, plugin:{packageName,sourcePath,digest:'sha256:…'}, target:{name:'next',dsh:string}|{name:'master',commit:string}, contextDigest:'sha256:…', url?:string (present when ready), error?:string, cleanup?:'pass'|'fail', orphan?:true (supervisor pid gone — manual cleanup may be needed at .lab/runtime/ui-sessions/<id>), startedAt, updatedAt }. Use sessionId as explicit handle for ui_status/finish/abort (2026-07-28 explicit-handle pattern).",
      inputSchema: z
        .object({
          plugin: z.string().min(1).describe('Catalog plugin name (enumerate via dsh_lab.list_plugins)').optional(),
          path: z.string().min(1).describe('Absolute path to a standalone plugin directory — exactly one of plugin or path is required').optional(),
          target: z.enum(['next', 'master']).describe('Target pin to boot against; mirrors lab ui start --target (required)'),
          startupTimeoutMs: z.number().int().min(1000).max(600000).optional().default(120000).describe('Max ms to wait for ready (poll 25ms); default 120000'),
        })
        .strict()
        .refine(
          data => (data.plugin !== undefined) !== (data.path !== undefined),
          { message: 'exactly one of plugin or path is required' },
        ),
    },
    async args => {
      try {
        const typed = args as { plugin?: string; path?: string; target: 'next' | 'master'; startupTimeoutMs?: number }
        const result = await handleUiStart(root, typed, options?.uiDeps)
        return success(result, { exitCode: result.state === 'ready' && !result.stale ? 0 : 2 })
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return toolError(code, message, toolErrorExitCode(e))
      }
    },
  )

  server.registerTool(
    'dsh_lab.ui_status',
    {
      description:
        "Get live status of a UI session by sessionId. Synchronous read of .lab/runtime/ui-sessions/<sessionId>/state.json plus liveness + stale checks. Returns UiSessionViewV1 { sessionId, state:'starting'|'ready'|'crashed'|'stopping'|'finished'|'aborted', stale, staleReasons:('plugin-changed'|'context-changed'|'target-changed')[] — staleReasons latch and never un-latch, plugin, target, contextDigest, url?, error?, cleanup?, orphan?:true, startedAt, updatedAt }. stale:true means plugin digest, context digest, or target pin changed since session start (use to decide re-start). orphan:true means supervisor pid gone (process.kill(pid,0) failed) — view is still returned (not an error) but manual cleanup of the session dir may be needed. sessionId pattern ^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$.",
      inputSchema: z
        .object({
          sessionId: z
            .string()
            .min(1)
            .regex(UI_SESSION_ID_PATTERN, 'invalid or unsafe session id')
            .describe('UI session handle minted by dsh_lab.ui_start (pattern ui-YYYYMMDDTHHMMSSZ-xxxxxxxx)'),
        })
        .strict(),
    },
    async args => {
      try {
        const typed = args as { sessionId: string }
        const result = handleUiStatus(root, typed, options?.uiDeps as Pick<UiServiceDependencies, 'now' | 'processAlive'> | undefined)
        return success(result, { exitCode: result.state === 'ready' && !result.stale ? 0 : 2 })
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return toolError(code, message, toolErrorExitCode(e))
      }
    },
  )

  server.registerTool(
    'dsh_lab.ui_finish',
    {
      description:
        "Finish a UI session with an external verdict. verdict is the external browser/vision agent's judgment; the lab owns only lifecycle + evidence — it writes a finish control, waits for supervisor to consume it and publish UiResultV1 to .lab/ui-runs/... and verify runtime cleanup (typically seconds). Returns UiResultV1 { schemaVersion:1, sessionId, operation:'ui', verdict:'pass'|'fail', summary:string (1..500 Unicode code points, single line, no controls — normalized via normalizeUiSummary), plugin:{packageName,sourcePath,digest}, target, lab:{contextDigest}, environment:{node,pnpm,platform}, startedAt, finishedAt }. summary is the short human-readable reason for the verdict. Errors: UiProtocolOutcomeError with outcome 'stale' (staleReasons latched) → isError UI_STALE with staleReasons in message; outcome 'cleanup-incomplete' → UI_CLEANUP_INCOMPLETE; summary violating single-line/500 → INVALID_SUMMARY; unknown sessionId → UI_NOT_FOUND.",
      inputSchema: z
        .object({
          sessionId: z
            .string()
            .min(1)
            .regex(UI_SESSION_ID_PATTERN, 'invalid or unsafe session id')
            .describe('UI session handle minted by dsh_lab.ui_start (pattern ui-YYYYMMDDTHHMMSSZ-xxxxxxxx)'),
          verdict: z.enum(['pass', 'fail']).describe("External agent's judgment for this session"),
          summary: z.string().min(1).max(500).describe('Single-line human summary 1..500 code points, no control characters'),
        })
        .strict(),
    },
    async args => {
      try {
        const typed = args as { sessionId: string; verdict: 'pass' | 'fail'; summary: string }
        const result = await handleUiFinish(root, typed, options?.uiDeps)
        return success(result, { exitCode: result.verdict === 'pass' ? 0 : 1 })
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return toolError(code, message, toolErrorExitCode(e))
      }
    },
  )

  server.registerTool(
    'dsh_lab.ui_abort',
    {
      description:
        "Abort a UI session (cooperative stop). Writes an abort control, waits for supervisor to reach state 'aborted' (typically seconds) and verifies cleanup. Returns UiSessionViewV1 { sessionId, state:'aborted' (or 'crashed' if already terminal), stale, staleReasons, plugin, target, contextDigest, url?, error?, cleanup, orphan?, startedAt, updatedAt }. orphan:true means supervisor pid gone — view is returned (not an error) with guidance that the session dir at .lab/runtime/ui-sessions/<id> may need manual removal. Unknown sessionId → isError UI_NOT_FOUND. Stale or cleanup-incomplete → UI_STALE / UI_CLEANUP_INCOMPLETE.",
      inputSchema: z
        .object({
          sessionId: z
            .string()
            .min(1)
            .regex(UI_SESSION_ID_PATTERN, 'invalid or unsafe session id')
            .describe('UI session handle minted by dsh_lab.ui_start (pattern ui-YYYYMMDDTHHMMSSZ-xxxxxxxx)'),
        })
        .strict(),
    },
    async args => {
      try {
        const typed = args as { sessionId: string }
        const result = await handleUiAbort(root, typed, options?.uiDeps)
        return success(result, { exitCode: result.state === 'aborted' ? 0 : 2 })
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return toolError(code, message, toolErrorExitCode(e))
      }
    },
  )

  server.registerTool(
    'dsh_lab.dev_start',
    {
      description:
        "Start an isolated dev session for a plugin against a pinned target. Creates a detached supervisor that boots the DSH harness with the plugin's live source path (no bundle gate). BOUNDED LONG-RUNNING: blocks up to startupTimeoutMs (default 120000, range 1000..600000, poll 25ms) waiting for state to leave 'starting'; typically <5s, returns as soon as state is 'ready', 'crashed', or 'stopped'. Returns DevSessionViewV1 { schemaVersion:1, sessionId:'dev-YYYYMMDDTHHMMSSZ-xxxxxxxx', state:'starting'|'ready'|'crashed'|'stopping'|'stopped', restartRequired:boolean, restartReasons:('plugin-manifest'|'plugin-metadata'|'target-pin'|'source-changed')[] — latch and never un-latch, restartHash:'sha256:…', plugin:{packageName,sourcePath,runtimeName}, target:{name:'next',dsh:string}|{name:'master',commit:string}, url?:string (present when ready and no restart reasons), error?:string, cleanup?:'pass'|'fail', orphan?:true, startedAt, updatedAt }. Use sessionId as the explicit handle for dev_status/dev_stop.",
      inputSchema: z
        .object({
          plugin: z.string().min(1).describe('Catalog plugin name (enumerate via dsh_lab.list_plugins)').optional(),
          path: z.string().min(1).describe('Absolute path to a standalone plugin directory — exactly one of plugin or path is required').optional(),
          target: z.enum(['next', 'master']).describe('Target pin to boot against (required)'),
          startupTimeoutMs: z.number().int().min(1000).max(600000).optional().default(120000).describe('Max ms to wait for ready (poll 25ms); default 120000'),
        })
        .strict()
        .refine(
          data => (data.plugin !== undefined) !== (data.path !== undefined),
          { message: 'exactly one of plugin or path is required' },
        ),
    },
    async args => {
      try {
        const typed = args as { plugin?: string; path?: string; target: 'next' | 'master'; startupTimeoutMs?: number }
        const result = await handleDevStart(root, typed, options?.devDeps)
        return success(result, { sessionId: result.sessionId, exitCode: result.state === 'ready' && !result.restartRequired ? 0 : 2 })
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return toolError(code, message, toolErrorExitCode(e))
      }
    },
  )

  server.registerTool(
    'dsh_lab.dev_status',
    {
      description:
        "Get live status of a dev session by sessionId. Synchronous read of .lab/runtime/dev-sessions/<sessionId>/state.json plus liveness, restart-latch, and orphan checks. Returns DevSessionViewV1 { sessionId, state:'starting'|'ready'|'crashed'|'stopping'|'stopped', restartRequired, restartReasons:('plugin-manifest'|'plugin-metadata'|'target-pin'|'source-changed')[] — latch and never un-latch, restartHash, plugin, target, url?, error?, cleanup?, orphan?:true, startedAt, updatedAt }. restartRequired:true means a lived plugin manifest/metadata digest, the source tree digest, or the target pin changed since session start. Editing src/** latches source-changed (stop then start to load new source). orphan:true means the supervisor/child pid is gone — the view is still returned (not an error) but manual cleanup of the session dir at .lab/runtime/dev-sessions/<id> may be needed. sessionId pattern ^dev-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$.",
      inputSchema: z
        .object({
          sessionId: z
            .string()
            .min(1)
            .regex(DEV_SESSION_ID_PATTERN, 'invalid or unsafe session id')
            .describe('Dev session handle minted by dsh_lab.dev_start (pattern dev-YYYYMMDDTHHMMSSZ-xxxxxxxx)'),
        })
        .strict(),
    },
    async args => {
      try {
        const typed = args as { sessionId: string }
        // Only inject the status liveness/clock deps when both keys are
        // actually supplied; a partial devDeps with unrelated keys must not
        // degrade dev_status to a broken (undefined `now`/`processAlive`) deps.
        const statusDeps = options?.devDeps !== undefined && typeof options.devDeps.now === 'function' && typeof options.devDeps.processAlive === 'function'
          ? { now: options.devDeps.now, processAlive: options.devDeps.processAlive }
          : undefined
        const result = handleDevStatus(root, typed, statusDeps)
        return success(result, { sessionId: result.sessionId, restartRequired: result.restartRequired, exitCode: result.state === 'ready' && !result.restartRequired ? 0 : 2 })
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return toolError(code, message, toolErrorExitCode(e))
      }
    },
  )

  server.registerTool(
    'dsh_lab.dev_stop',
    {
      description:
        "Stop a dev session (cooperative stop). Writes a stop control, waits for the supervisor to reach state 'stopped' (typically seconds) and verifies cleanup. Returns DevSessionViewV1 { sessionId, state:'stopped' (or an already-terminal 'crashed' view for a crashed session), restartRequired, restartReasons, restartHash, plugin, target, url?, error?, cleanup, orphan?, startedAt, updatedAt }. Idempotent: a 'stopped' session returns its stored tombstone. Unknown sessionId → isError DEV_NOT_FOUND. Cleanup-incomplete → DEV_CLEANUP_INCOMPLETE (exit 2).",
      inputSchema: z
        .object({
          sessionId: z
            .string()
            .min(1)
            .regex(DEV_SESSION_ID_PATTERN, 'invalid or unsafe session id')
            .describe('Dev session handle minted by dsh_lab.dev_start (pattern dev-YYYYMMDDTHHMMSSZ-xxxxxxxx)'),
          stopTimeoutMs: z.number().int().min(1000).max(600000).optional().default(120000).describe('Max ms to wait for stop cleanup (default 120000)'),
        })
        .strict(),
    },
    async args => {
      try {
        const typed = args as { sessionId: string; stopTimeoutMs?: number }
        const result = await handleDevStop(root, typed, options?.devDeps)
        return success(result, { sessionId: result.sessionId, cleanup: result.cleanup, exitCode: result.state === 'stopped' ? 0 : 2 })
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return toolError(code, message, toolErrorExitCode(e))
      }
    },
  )
  if (options?.allowAuthoring === true) {
    server.registerTool(
      'dsh_lab.create_plugin',
      {
        description:
          "MUTATING authoring operation. Create a new plugin from the canonical template under plugins/<name> (a nested git repo) and register it in catalog.yaml as tracking: local. Does NOT commit or push. Only available when the server is started with --allow-authoring (or DSH_LAB_ALLOW_AUTHORING=1). Returns { sourcePath, catalogName }. Errors: INVALID_NAME for an invalid or duplicate name; CREATE_FAILED for other failures.",
        inputSchema: z
          .object({
            name: z
              .string()
              .min(1)
              .regex(NAME_RE, 'catalog slug: lowercase letters, digits, hyphens; must start with a letter-or-digit')
              .describe('catalog slug (lowercase letters, digits, hyphens, must start with a letter-or-digit)'),
          })
          .strict(),
      },
      async args => {
        try {
          const typed = args as { name: string }
          const result = await handleCreatePlugin(root, typed)
          return success(result, { exitCode: 0 })
        } catch (e) {
          const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
          const message = e instanceof Error ? e.message : String(e)
          return toolError(code, message, toolErrorExitCode(e))
        }
      },
    )
    server.registerTool(
      'dsh_lab.sync_context',
      {
        description:
          "MUTATING authoring operation. Regenerate a plugin's .dsh-lab/shared-context.md snapshot from the canonical context digest. Pass exactly one of { plugin: '<name>' } or { all: true }; both or neither is INVALID_ARGS. Does NOT commit or push. Only available when the server is started with --allow-authoring (or DSH_LAB_ALLOW_AUTHORING=1). Returns SyncedResult[] { kind, name, changed, path }. Errors: INVALID_ARGS, UNKNOWN_PLUGIN, NOT_A_PLUGIN_REPO, SYNC_CONTEXT_FAILED.",
        inputSchema: z
          .object({
            plugin: z
              .string()
              .min(1)
              .describe('Catalog plugin name to sync (mutually exclusive with all:true)')
              .optional(),
            all: z.boolean().describe('Sync every catalog entry (mutually exclusive with plugin)').optional(),
          })
          .strict(),
      },
      async args => {
        try {
          const typed = args as { plugin?: string; all?: boolean }
          const result = await handleSyncContext(root, typed)
          return success(result, { exitCode: 0 })
        } catch (e) {
          const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
          const message = e instanceof Error ? e.message : String(e)
          return toolError(code, message, toolErrorExitCode(e))
        }
      },
    )
  }

  type ResourceDef = { uri: string; file: string; title: string; mimeType: string; description: string }

  const resources: ResourceDef[] = [
    {
      uri: 'dsh://contracts/harness',
      file: join(root, 'context', 'harness-contracts.md'),
      title: 'Harness Contracts',
      mimeType: 'text/markdown',
      description: 'Public plugin contracts and integration paths',
    },
    {
      uri: 'dsh://contracts/cordis',
      file: join(root, 'context', 'cordis-model.md'),
      title: 'Cordis Model',
      mimeType: 'text/markdown',
      description: 'Fiber/effect/inject model',
    },
    {
      uri: 'dsh://contracts/anatomy',
      file: join(root, 'context', 'plugin-anatomy.md'),
      title: 'Plugin Anatomy',
      mimeType: 'text/markdown',
      description: 'Standalone plugin repo layout and package contract',
    },
    {
      uri: 'dsh://testing-policy',
      file: join(root, 'context', 'testing-policy.md'),
      title: 'Testing Policy',
      mimeType: 'text/markdown',
      description: 'Required test levels and HMR-safety rules',
    },
    {
      uri: 'dsh://compatibility',
      file: join(root, 'workbench', 'compatibility.yaml'),
      title: 'Compatibility Pins',
      mimeType: 'text/yaml',
      description: 'Target pins workbench/compatibility.yaml',
    },
    {
      uri: 'dsh://lab-guide',
      file: join(root, 'context', 'lab-author-guide.md'),
      title: 'Lab Author Guide',
      mimeType: 'text/markdown',
      description: 'Canonical author loop / recipes',
    },
    {
      uri: 'dsh://skill',
      file: join(root, '.agents', 'skills', 'dsh-plugin-development', 'SKILL.md'),
      title: 'Portable Skill',
      mimeType: 'text/markdown',
      description: 'Hand-authored portable skill',
    },
  ]

  for (const def of resources) {
    server.registerResource(
      def.title,
      def.uri,
      {
        description: def.description,
        mimeType: def.mimeType,
        cacheHint: { ttlMs: 0, cacheScope: 'private' },
      },
      async uri => {
        const text = readFileSync(def.file, 'utf8')
        return {
          contents: [{ uri: uri.href, text, mimeType: def.mimeType }],
        }
      },
    )
  }

  return server
}
