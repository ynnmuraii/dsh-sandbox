import { join } from 'node:path'
import { parsePluginSelector, resolvePluginRef } from '../plugin-ref.js'
import { inspectPlugin, type InspectionResult } from '../inspect.js'
import { derivePluginStatus, type PluginStatus } from '../status.js'
import { doctor, type DiagnosticResult } from '../doctor.js'
import { pluginEvidenceKey, loadRunResults, type VerifyRunResultV1 } from '../evidence.js'
import { loadUiResults, type UiResultV1 } from '../ui-evidence.js'
import { loadCatalogFromFile } from '../schemas.js'
import { ROOT_PATHS, rootPath } from '../context.js'
import { verifyPlugin, type VerifyPluginDependencies } from '../verify.js'
import { inferVerifyTarget, validateMetadataTargets } from '../cli.js'

export class ToolError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

function mapSelectorError(error: unknown): ToolError {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (
    lower.includes('not found') ||
    lower.includes('no such file') ||
    lower.includes('enoent') ||
    lower.includes('package.json for plugin') ||
    lower.includes('must declare a package name')
  ) {
    return new ToolError(message, 'UNKNOWN_PLUGIN')
  }
  if (lower.includes('target')) {
    return new ToolError(message, 'INVALID_TARGET')
  }
  return new ToolError(message, 'INVALID_SELECTOR')
}

function resolvePlugin(root: string, plugin?: string, path?: string) {
  const raw = plugin !== undefined ? [plugin] : ['--path', path!]
  let selector
  try {
    const parsed = parsePluginSelector(raw)
    if (parsed.rest.length !== 0) {
      throw new Error(`unexpected arguments: ${parsed.rest.join(' ')}`)
    }
    selector = parsed.selector
  } catch (e) {
    throw mapSelectorError(e)
  }
  try {
    return resolvePluginRef({ root, selector })
  } catch (e) {
    const toolErr = mapSelectorError(e)
    if (toolErr.code === 'UNKNOWN_PLUGIN' && plugin !== undefined) {
      try {
        const catalog = loadCatalogFromFile(rootPath(root, ROOT_PATHS.catalog))
        const names = Object.keys(catalog.plugins).sort()
        if (names.length > 0) {
          toolErr.message = `${toolErr.message}; available: ${names.join(', ')}`
        }
      } catch {
        // leave message unchanged if catalog unreadable
      }
    }
    throw toolErr
  }
}

export interface CatalogPlugin {
  name: string
  path: string
  tracking: 'local' | 'submodule'
  maturity?: 'experiment' | 'stable'
}

export function handleListPlugins(root: string): CatalogPlugin[] {
  try {
    const catalog = loadCatalogFromFile(rootPath(root, ROOT_PATHS.catalog))
    return Object.entries(catalog.plugins)
      .map(([name, entry]) => ({
        name,
        path: entry.path,
        tracking: entry.tracking,
        ...(entry.maturity === undefined ? {} : { maturity: entry.maturity }),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const lower = msg.toLowerCase()
    if (lower.includes('no such file') || lower.includes('enoent') || lower.includes('not found')) {
      return []
    }
    throw new ToolError(msg, 'CATALOG_ERROR')
  }
}

export function handleInspect(
  root: string,
  args: { plugin?: string; path?: string; target?: 'next' | 'master' },
): InspectionResult {
  const ref = resolvePlugin(root, args.plugin, args.path)
  const opts: { root: string; plugin: typeof ref; target?: 'next' | 'master' } = { root, plugin: ref }
  if (args.target !== undefined) opts.target = args.target
  return inspectPlugin(opts)
}

export function handleStatus(
  root: string,
  args: { plugin?: string; path?: string },
): PluginStatus {
  const ref = resolvePlugin(root, args.plugin, args.path)
  return derivePluginStatus({ root, plugin: ref })
}

export async function handleDoctor(root: string): Promise<DiagnosticResult[]> {
  return doctor({ root })
}

export interface GetEvidenceResult {
  verify: VerifyRunResultV1[]
  ui: UiResultV1[]
}

export async function handleVerify(
  root: string,
  args: { plugin?: string; path?: string; target?: 'next' | 'master' | 'all' },
  deps?: Partial<VerifyPluginDependencies>,
): Promise<VerifyRunResultV1> {
  const ref = resolvePlugin(root, args.plugin, args.path)
  try {
    validateMetadataTargets(ref)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new ToolError(msg, 'INVALID_TARGET')
  }
  let target: 'next' | 'master' | 'all'
  if (args.target !== undefined) {
    target = args.target
  } else {
    try {
      target = inferVerifyTarget(ref)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new ToolError(msg, 'INVALID_TARGET')
    }
  }
  try {
    const result = await verifyPlugin({ root, plugin: ref, target, ...(deps ? { dependencies: deps } : {}) } as any)
    return result
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const lower = msg.toLowerCase()
    if (lower.includes('does not declare target') || lower.includes('unknown target') || lower.includes('requires --target') || lower.includes('declares no supported')) {
      throw new ToolError(msg, 'INVALID_TARGET')
    }
    throw new ToolError(msg, 'VERIFY_PREREQ')
  }
}

export function handleGetEvidence(
  root: string,
  args: { plugin?: string; path?: string; kind?: 'verify' | 'ui' | 'all'; limit?: number },
): GetEvidenceResult {
  const kind = args.kind ?? 'all'
  const limit = args.limit ?? 10
  const ref = resolvePlugin(root, args.plugin, args.path)
  const pluginKey = pluginEvidenceKey(ref)
  const runsRoot = join(root, '.lab', 'runs')
  const uiRunsRoot = join(root, '.lab', 'ui-runs')

  let verify: VerifyRunResultV1[] = []
  let ui: UiResultV1[] = []

  if (kind === 'verify' || kind === 'all') {
    try {
      verify = loadRunResults({ runsRoot, pluginKey })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new ToolError(msg, 'EVIDENCE_ERROR')
    }
    verify = verify.slice(0, limit)
  }
  if (kind === 'ui' || kind === 'all') {
    try {
      ui = loadUiResults({ uiRunsRoot, pluginKey })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new ToolError(msg, 'EVIDENCE_ERROR')
    }
    ui = ui.slice(0, limit)
  }

  return { verify, ui }
}
