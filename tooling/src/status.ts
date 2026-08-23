import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { loadRunResults, pluginEvidenceKey, type VerifyRunResultV1 } from './evidence.js'
import { inspectPlugin } from './inspect.js'
import type { PluginRef } from './plugin-ref.js'
import { computePluginDigest } from './plugin-snapshot.js'
import { ROOT_PATHS, rootPath } from './context.js'
import { loadCompatibilityFromFile, type Compatibility, type TargetPin } from './schemas.js'

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

const TARGETS = ['next', 'master'] as const
type Target = (typeof TARGETS)[number]

/**
 * Derive a factual status view from current source files and finalized runs.
 * This function deliberately has no workflow or runtime writes: the only
 * filesystem operations are reads performed by digesting, inspection, and
 * evidence loading.
 */
export function derivePluginStatus(opts: {
  root: string
  plugin: PluginRef
  runsRoot?: string
}): PluginStatus {
  const digest = computePluginDigest(opts.plugin.sourcePath).digest
  const compatibility = loadCompatibilityFromFile(rootPath(opts.root, ROOT_PATHS.compatibility))
  const contextDigest = currentContextDigest(opts.root)
  const runs = loadRunResults({
    runsRoot: opts.runsRoot ?? rootPath(opts.root, '.lab/runs'),
    pluginKey: pluginEvidenceKey(opts.plugin),
  })

  const structureRun = newestRun(runs, run => run.steps.some(step => step.id === 'inspect'))
  const bundleRun = newestRun(runs, run => run.steps.some(step => step.id === 'pack-smoke'))
  const structure = structureRun === undefined
    ? { state: 'not-run' as const }
    : claimFromStatus(
      structureRun,
      structureRun.steps.find(step => step.id === 'inspect')!.status,
      digest,
      contextDigest,
    )
  const bundle = bundleRun === undefined
    ? { state: 'not-run' as const }
    : claimFromStatus(
      bundleRun,
      bundleRun.steps.find(step => step.id === 'pack-smoke')!.status,
      digest,
      contextDigest,
    )

  const targets: Record<string, StatusClaim> = {}
  for (const target of TARGETS) {
    const run = newestRun(runs, candidate => candidate.targets[target] !== undefined)
    const evidence = run?.targets[target]
    targets[target] = run === undefined || evidence === undefined
      ? { state: 'not-run' }
      : claimFromStatus(
        run,
        evidence.result,
        digest,
        contextDigest,
        compatibility.targets[target],
        target,
      )
  }

  let ui: StatusClaim
  try {
    const inspection = inspectPlugin({ root: opts.root, plugin: opts.plugin })
    ui = inspection.faces.client === false ? { state: 'not-applicable' } : { state: 'not-run' }
  } catch {
    // UI applicability is intentionally conservative. A failed inspection
    // cannot prove that no client face exists, so it remains not-run.
    ui = { state: 'not-run' }
  }

  return {
    schemaVersion: 1,
    plugin: { packageName: opts.plugin.packageName, sourcePath: opts.plugin.sourcePath, digest },
    structure,
    bundle,
    targets,
    ui,
  }
}

function newestRun(
  runs: VerifyRunResultV1[],
  predicate: (run: VerifyRunResultV1) => boolean,
): VerifyRunResultV1 | undefined {
  return runs.find(predicate)
}

function claimFromStatus(
  run: VerifyRunResultV1,
  result: VerifyRunResultV1['steps'][number]['status'],
  currentDigest: `sha256:${string}`,
  contextDigest: `sha256:${string}`,
  targetPin?: TargetPin,
  target?: Target,
): StatusClaim {
  const reasons = new Set<string>()
  if (run.plugin.digest !== currentDigest) reasons.add('PLUGIN_CONTENT_CHANGED')
  if (run.lab.contextDigest !== contextDigest) reasons.add('LAB_CONTEXT_CHANGED')
  if (target !== undefined && targetPin !== undefined && !matchesTargetPin(run, target, targetPin)) {
    reasons.add('TARGET_PIN_CHANGED')
  }

  const claim: StatusClaim = {
    state: claimState(result),
    runId: run.runId,
  }
  if (reasons.size > 0) {
    return { ...claim, state: 'stale', reasons: [...reasons].sort() }
  }
  return claim
}

function claimState(result: VerifyRunResultV1['steps'][number]['status']): ClaimState {
  if (result === 'pass') return 'pass'
  if (result === 'not-applicable') return 'not-applicable'
  if (result === 'skipped') return 'not-run'
  return 'fail'
}

function matchesTargetPin(run: VerifyRunResultV1, target: Target, pin: TargetPin): boolean {
  const evidence = run.targets[target]
  if (evidence === undefined) return false
  if (target === 'next') return evidence.dsh === pin.dsh
  return evidence.commit === pin.commit
}

function currentContextDigest(root: string): `sha256:${string}` {
  const contextRoot = rootPath(root, ROOT_PATHS.contextDir)
  const hash = createHash('sha256')
  const files: string[] = []
  const collect = (directory: string): void => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) collect(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  collect(contextRoot)
  for (const path of files.sort()) {
    hash.update(relative(contextRoot, path).replaceAll('\\', '/'))
    hash.update(readFileSync(path))
  }
  return `sha256:${hash.digest('hex')}`
}
