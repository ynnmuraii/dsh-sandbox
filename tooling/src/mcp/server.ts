import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  handleDoctor,
  handleGetEvidence,
  handleInspect,
  handleListPlugins,
  handleStatus,
  handleUiAbort,
  handleUiFinish,
  handleUiStart,
  handleUiStatus,
  handleVerify,
  ToolError,
} from './handlers.js'
import type { VerifyPluginDependencies } from '../verify.js'
import type { UiServiceDependencies } from '../ui.js'

export function buildServer(root: string, verifyDeps?: Partial<VerifyPluginDependencies>, uiDeps?: Partial<UiServiceDependencies>): McpServer {
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
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        }
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text' as const, text: `${code}: ${message}` }],
          isError: true,
        }
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
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        }
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text' as const, text: `${code}: ${message}` }],
          isError: true,
        }
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
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        }
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text' as const, text: `${code}: ${message}` }],
          isError: true,
        }
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
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text' as const, text: `DOCTOR_FAILED: ${message}` }],
          isError: true,
        }
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
        const result = await handleVerify(root, typed, verifyDeps)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        }
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text' as const, text: `${code}: ${message}` }],
          isError: true,
        }
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
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        }
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text' as const, text: `${code}: ${message}` }],
          isError: true,
        }
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
        const result = await handleUiStart(root, typed, uiDeps)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        }
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text' as const, text: `${code}: ${message}` }],
          isError: true,
        }
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
          sessionId: z.string().min(1).describe('UI session handle minted by dsh_lab.ui_start (pattern ui-YYYYMMDDTHHMMSSZ-xxxxxxxx)'),
        })
        .strict(),
    },
    async args => {
      try {
        const typed = args as { sessionId: string }
        const result = handleUiStatus(root, typed, uiDeps as Pick<UiServiceDependencies, 'now' | 'processAlive'> | undefined)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        }
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text' as const, text: `${code}: ${message}` }],
          isError: true,
        }
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
          sessionId: z.string().min(1).describe('UI session handle minted by dsh_lab.ui_start (pattern ui-YYYYMMDDTHHMMSSZ-xxxxxxxx)'),
          verdict: z.enum(['pass', 'fail']).describe("External agent's judgment for this session"),
          summary: z.string().min(1).max(500).describe('Single-line human summary 1..500 code points, no control characters'),
        })
        .strict(),
    },
    async args => {
      try {
        const typed = args as { sessionId: string; verdict: 'pass' | 'fail'; summary: string }
        const result = await handleUiFinish(root, typed, uiDeps)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        }
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text' as const, text: `${code}: ${message}` }],
          isError: true,
        }
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
          sessionId: z.string().min(1).describe('UI session handle minted by dsh_lab.ui_start (pattern ui-YYYYMMDDTHHMMSSZ-xxxxxxxx)'),
        })
        .strict(),
    },
    async args => {
      try {
        const typed = args as { sessionId: string }
        const result = await handleUiAbort(root, typed, uiDeps)
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        }
      } catch (e) {
        const code = e instanceof ToolError ? e.code : 'INTERNAL_ERROR'
        const message = e instanceof Error ? e.message : String(e)
        return {
          content: [{ type: 'text' as const, text: `${code}: ${message}` }],
          isError: true,
        }
      }
    },
  )

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
