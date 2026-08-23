import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Compatibility } from './schemas.js'
import { loadCompatibilityFromFile } from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'
import { inspectPlugin } from './inspect.js'
import { createPluginSnapshot, type CreatePluginSnapshotOptions, type PluginSnapshot } from './plugin-snapshot.js'
import { verifyPackageInWorkspace } from './package-verify.js'
import { publishRunResult, type RunOutcome, type RunStepResult, type VerifyRunResultV1 } from './evidence.js'
import type { PluginRef } from './plugin-ref.js'
import { verifyPackedTarget } from './run.js'

export interface VerifyPluginOptions {
  root: string
  plugin: PluginRef
  target: 'next' | 'master' | 'all'
  runsRoot?: string
  masterBin?: string
  /** Injectable boundaries used by tests and alternate forge hosts. */
  dependencies?: Partial<VerifyPluginDependencies>
}

export interface VerifyTargetOptions {
  root: string
  pluginName: string
  target: 'next' | 'master'
  tarball: string
  compat: Compatibility
  masterBin?: string
}

export interface VerifyPluginDependencies {
  inspectPlugin(opts: { root: string; plugin: PluginRef; target?: 'next' | 'master' }): InspectionResultLike
  createSnapshot(opts: CreatePluginSnapshotOptions): PluginSnapshot
  verifyPackage(opts: { workspacePath: string; allowBuilds: Record<string, boolean> }): PackageVerifyResultLike
  verifyTarget(opts: VerifyTargetOptions): Promise<void> | void
  loadCompatibility(root: string): Compatibility
  publishResult(opts: { runsRoot: string; result: VerifyRunResultV1 }): string
  createRunId(): string
  now(): Date
  contextDigest(root: string): string
  environment(): VerifyRunResultV1['environment']
}

interface InspectionResultLike {
  schemaVersion: number
  plugin: { packageName: string; sourcePath: string }
  faces: { host: boolean; client: boolean | 'unknown' | string }
  diagnostics: Array<{ code: string; severity: string; message: string }>
  ok: boolean
}

interface PackageVerifyResultLike {
  tarball: string
  steps: Array<{ id: string; status: string; durationMs: number; summary?: string }>
}

const TARGETS = ['next', 'master'] as const
type Target = (typeof TARGETS)[number]

type VerifyResultWithNext = VerifyRunResultV1 & {
  targets: VerifyRunResultV1['targets'] & {
    next: { dsh?: string; commit?: string; result: RunStepResult['status'] }
  }
}

export function verifyPlugin(opts: VerifyPluginOptions & { target: 'master' }): Promise<VerifyRunResultV1>
export function verifyPlugin(opts: VerifyPluginOptions): Promise<VerifyResultWithNext>
export async function verifyPlugin(opts: VerifyPluginOptions): Promise<VerifyRunResultV1> {
  const deps = defaults(opts.dependencies)
  const runId = deps.createRunId()
  const startedAt = deps.now().toISOString()
  const selectedTargets = resolveTargets(opts.target, opts.plugin)

  const inspectionErrors: string[] = []
  for (const target of selectedTargets) {
    try {
      const inspection = deps.inspectPlugin({
        root: opts.root,
        plugin: opts.plugin,
        target,
      })
      if (!inspection.ok) {
        const errors = inspection.diagnostics
          .filter(diagnostic => diagnostic.severity === 'error')
          .map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`)
          .join('; ')
        inspectionErrors.push(`${target}${errors ? `: ${errors}` : ''}`)
      }
    } catch (error) {
      inspectionErrors.push(`${target}: ${errorMessage(error)}`)
    }
  }
  if (inspectionErrors.length > 0) {
    throw new Error(`inspection failed: ${inspectionErrors.join('; ')}`)
  }

  const runtimeRoot = rootPath(opts.root, ROOT_PATHS.runtime)
  const snapshot = deps.createSnapshot({
    sourcePath: opts.plugin.sourcePath,
    runtimeRoot,
  })

  const steps: RunStepResult[] = [{ id: 'inspect', status: 'pass', durationMs: 0 }]
  let packageResult: PackageVerifyResultLike | undefined
  const targets: Record<string, { dsh?: string; commit?: string; result: RunStepResult['status'] }> = {}
  let compatibility: Compatibility | undefined
  let outcome: RunOutcome = 'pass'

  try {
    try {
      compatibility = deps.loadCompatibility(opts.root)
      for (const target of selectedTargets) targets[target] = targetEvidence(target, compatibility, 'skipped')
    } catch (error) {
      outcome = 'blocked'
      for (const target of selectedTargets) targets[target] = targetEvidence(target, emptyCompatibility(), 'blocked')
      steps.push({ id: 'compatibility', status: 'blocked', durationMs: 0, summary: errorMessage(error) })
    }

    if (outcome === 'pass' && compatibility !== undefined) {
      const packagePolicy = compatibility.targets[selectedTargets[0] ?? 'next']?.allowBuilds ?? {}
      try {
        packageResult = await deps.verifyPackage({
          workspacePath: snapshot.workspacePath,
          allowBuilds: packagePolicy,
        })
        steps.push(...packageResult.steps as RunStepResult[])
      } catch (error) {
        outcome = 'fail'
        steps.push(...failureSteps(error))
      }
    }

    if (outcome === 'pass' && packageResult !== undefined && compatibility !== undefined) {
      for (const target of selectedTargets) {
        const targetStarted = deps.now().getTime()
        try {
          await deps.verifyTarget({
            root: opts.root,
            pluginName: pluginName(opts.plugin),
            target,
            tarball: packageResult.tarball,
            compat: compatibility,
            ...(opts.masterBin === undefined ? {} : { masterBin: opts.masterBin }),
          })
          targets[target] = targetEvidence(target, compatibility, 'pass')
          steps.push({ id: `target:${target}`, status: 'pass', durationMs: elapsed(deps, targetStarted) })
        } catch (error) {
          outcome = 'fail'
          const summary = errorMessage(error)
          targets[target] = targetEvidence(target, compatibility, 'fail', summary)
          steps.push({
            id: `target:${target}`,
            status: 'fail',
            durationMs: elapsed(deps, targetStarted),
            summary,
          })
        }
      }
    }
  } finally {
    let cleanupFailure: unknown
    const cleanupStarted = deps.now().getTime()
    try {
      snapshot.cleanup()
    } catch (error) {
      cleanupFailure = error
      outcome = 'fail'
      steps.push({
        id: 'cleanup',
        status: 'fail',
        durationMs: elapsed(deps, cleanupStarted),
        summary: errorMessage(error),
      })
    }

    const finishedAt = deps.now().toISOString()
    const result: VerifyRunResultV1 = {
      schemaVersion: 1,
      runId,
      operation: 'verify',
      result: outcome,
      plugin: {
        packageName: opts.plugin.packageName,
        sourcePath: opts.plugin.sourcePath,
        digest: snapshot.digest,
      },
      targets: targets as VerifyRunResultV1['targets'],
      lab: { contextDigest: deps.contextDigest(opts.root) },
      environment: deps.environment(),
      steps,
      cleanup: cleanupFailure === undefined ? 'pass' : 'fail',
      startedAt,
      finishedAt,
    }

    // Publication is deliberately after cleanup: finalized evidence records
    // the actual cleanup outcome and can never claim a successful run while a
    // temporary workspace remains.
    deps.publishResult({
      runsRoot: opts.runsRoot ?? join(opts.root, '.lab', 'runs'),
      result,
    })
    return result
  }
}

function defaults(overrides: Partial<VerifyPluginDependencies> | undefined): VerifyPluginDependencies {
  return {
    inspectPlugin,
    createSnapshot: createPluginSnapshot,
    verifyPackage: verifyPackageInWorkspace,
    verifyTarget: verifyPackedTarget,
    loadCompatibility: root => loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility)),
    publishResult: publishRunResult,
    createRunId: () => `verify-${Date.now()}-${randomUUID().slice(0, 8)}`,
    now: () => new Date(),
    contextDigest: defaultContextDigest,
    environment: defaultEnvironment,
    ...overrides,
  }
}

function resolveTargets(requested: VerifyPluginOptions['target'], plugin: PluginRef): Target[] {
  const declared = plugin.metadata?.targets?.filter((value): value is Target =>
    value === 'next' || value === 'master',
  ) ?? []
  if (requested === 'all') {
    const selected = TARGETS.filter(target => declared.length === 0 || declared.includes(target))
    if (selected.length === 0) throw new Error(`plugin '${pluginName(plugin)}' declares no supported compatibility targets`)
    return selected
  }
  if (declared.length > 0 && !declared.includes(requested)) {
    throw new Error(
      `plugin '${pluginName(plugin)}' does not declare target '${requested}' ` +
      `(declared: ${declared.join(', ')})`,
    )
  }
  return [requested]
}

function targetEvidence(
  target: Target,
  compat: Compatibility,
  result: 'pass' | 'fail' | 'blocked' | 'skipped',
  _summary?: string,
): VerifyRunResultV1['targets'][string] {
  const pin = compat.targets[target]
  return target === 'next'
    ? { ...(pin?.dsh === undefined ? {} : { dsh: pin.dsh }), result }
    : { ...(pin?.commit === undefined ? {} : { commit: pin.commit }), result }
}

function emptyCompatibility(): Compatibility {
  return { targets: { next: {}, master: {} } }
}

function failureSteps(error: unknown): RunStepResult[] {
  const candidate = error as { steps?: unknown }
  if (Array.isArray(candidate.steps)) return candidate.steps as RunStepResult[]
  return [
    { id: 'install', status: 'fail', durationMs: 0, summary: errorMessage(error) },
    { id: 'typecheck', status: 'skipped', durationMs: 0 },
    { id: 'test', status: 'skipped', durationMs: 0 },
    { id: 'build', status: 'skipped', durationMs: 0 },
    { id: 'pack', status: 'skipped', durationMs: 0 },
    { id: 'pack-smoke', status: 'skipped', durationMs: 0 },
  ]
}

function pluginName(plugin: PluginRef): string {
  if (plugin.metadata?.name) return plugin.metadata.name
  if (plugin.catalogName) return plugin.catalogName
  const parts = plugin.packageName.split('/')
  return parts.at(-1) ?? plugin.packageName
}

function elapsed(deps: VerifyPluginDependencies, started: number): number {
  return Math.max(0, deps.now().getTime() - started)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultEnvironment(): VerifyRunResultV1['environment'] {
  const userAgent = process.env.npm_config_user_agent ?? ''
  const pnpm = /pnpm\/(\S+)/.exec(userAgent)?.[1] ?? 'unknown'
  return { node: process.version, pnpm, platform: process.platform }
}

function defaultContextDigest(root: string): string {
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
