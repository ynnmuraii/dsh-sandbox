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
  ToolError,
} from './handlers.js'

export function buildServer(root: string): McpServer {
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
