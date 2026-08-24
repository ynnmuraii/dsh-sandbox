import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'
import { inspectPlugin } from './inspect.js'
import type { PluginRef } from './plugin-ref.js'
import { computePluginDigest } from './plugin-snapshot.js'
import { ROOT_PATHS, rootPath } from './context.js'
import { loadCompatibilityFromFile, type Compatibility } from './schemas.js'
import { assertRuntimePluginIdentity } from './runtime-identity.js'
import {
  createUiSession,
  createUiSessionId,
  latchUiStaleReasons,
  readUiControl,
  readUiSession,
  writeUiControl,
  writeUiSessionRequest,
  writeUiSession,
  type UiSessionPhase,
  type UiSessionStateV1,
  type UiControlV1,
  type UiStaleReason,
} from './ui-session.js'
import { normalizeUiSummary, publishUiResult, type UiResultV1, type UiTargetIdentity } from './ui-evidence.js'
import { computeContextDigest } from './status.js'
import { resolveTsxLoader } from './run.js'
import { claimOwnedUiDirectory, type OwnedUiDirectory } from './ui-owned-directory.js'

export interface StartUiOptions {
  root: string
  plugin: PluginRef
  target: 'next' | 'master'
  startupTimeoutMs?: number
}

export interface FinishUiOptions {
  root: string
  sessionId: string
  verdict: 'pass' | 'fail'
  summary: string
  stopTimeoutMs?: number
}

export interface AbortUiOptions {
  root: string
  sessionId: string
  stopTimeoutMs?: number
}

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
  writeSession(opts: Parameters<typeof writeUiSession>[0]): void
  beforeRequestWrite?(sessionDirectory: string): void
}

export type UiProtocolOutcome = 'stale' | 'cleanup-incomplete'
export class UiProtocolOutcomeError extends Error {
  readonly outcome: UiProtocolOutcome
  readonly exitCode = 2 as const

  constructor(message: string, outcome: UiProtocolOutcome) {
    super(message)
    this.name = 'UiProtocolOutcomeError'
    this.outcome = outcome
  }
}

export interface UiSupervisorSpawnPlan {
  command: string
  args: string[]
  options: { detached: true; shell: false; stdio: 'ignore'; windowsHide: true }
}

const DEFAULT_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 25
const SESSION_ID = /^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$/

export function buildUiSupervisorSpawn(requestPath: string): UiSupervisorSpawnPlan {
  if (typeof requestPath !== 'string' || !isAbsolute(requestPath)) throw new Error('requestPath must be an absolute path')
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  const supervisorBin = fileURLToPath(new URL(`./ui-supervisor-bin.${extension}`, import.meta.url))
  const supervisorArgs = extension === 'ts'
    ? ['--import', resolveTsxLoader(), supervisorBin, requestPath]
    : [supervisorBin, requestPath]
  return {
    command: process.execPath,
    args: supervisorArgs,
    options: { detached: true, shell: false, stdio: 'ignore', windowsHide: true },
  }
}

export async function startUiSession(opts: StartUiOptions, deps: UiServiceDependencies = defaultDependencies()): Promise<UiSessionViewV1> {
  validateRootAndTarget(opts.root, opts.target)
  const timeoutMs = validateTimeout(opts.startupTimeoutMs, 'startupTimeoutMs')
  const identity = captureIdentity(opts.root, opts.plugin, opts.target)
  const startedAt = deps.now()
  validateTimestamp(startedAt, 'now')
  const sessionId = createUiSessionId(new Date(startedAt))
  const runtimeRoot = rootPath(opts.root, ROOT_PATHS.runtime)
  const state: UiSessionStateV1 = {
    schemaVersion: 1,
    sessionId,
    state: 'starting',
    plugin: identity.plugin,
    target: identity.target,
    contextDigest: identity.contextDigest,
    startedAt,
    updatedAt: startedAt,
  }
  const sessionDir = createUiSession({ runtimeRoot, state })
  const ownedSession = claimOwnedUiDirectory({ root: runtimeRoot, directory: sessionDir })
  ownedSession.assertCurrent()
  ownedSession.assertCurrent()
  deps.beforeRequestWrite?.(sessionDir)
  ownedSession.assertCurrent()
  const requestPath = writeUiSessionRequest({ runtimeRoot, sessionId, request: {
      schemaVersion: 1,
      root: resolve(opts.root),
      sessionId,
      plugin: {
        packageName: identity.plugin.packageName,
        sourcePath: identity.plugin.sourcePath,
        runtimeName: identity.runtimeName,
      },
      target: opts.target,
      startedAt,
    } })
  ownedSession.assertCurrent()
  let supervisor: { pid: number; unref(): void }
  try {
    ownedSession.assertCurrent()
    supervisor = deps.spawnSupervisor(requestPath)
    if (!supervisor || !Number.isInteger(supervisor.pid) || supervisor.pid <= 0 || typeof supervisor.unref !== 'function') {
      throw new Error('UI supervisor did not return a valid process')
    }
    supervisor.unref()
    const afterSpawn = readOwnedSession(runtimeRoot, sessionId, ownedSession)
    if (afterSpawn.state === 'starting') {
      writeOwnedSession(ownedSession, {
        runtimeRoot,
        state: { ...afterSpawn, supervisorPid: supervisor.pid, updatedAt: afterSpawn.updatedAt },
      })
    }
  } catch (error) {
    const message = sanitizeServiceError(error)
    try {
      ownedSession.assertCurrent()
      writeOwnedSession(ownedSession, {
        runtimeRoot,
        state: {
          ...state,
          state: 'crashed',
          error: message,
          cleanup: 'fail',
          updatedAt: safeNow(deps.now(), state.updatedAt),
        },
      })
    } catch { /* never mutate a replacement session during recovery */ }
    throw error
  }

  const deadline = Date.parse(startedAt) + timeoutMs
  while (true) {
    const current = readOwnedSession(runtimeRoot, sessionId, ownedSession)
    if (current.state === 'ready' || current.state === 'crashed') return viewFromState(current)
    if (Date.parse(deps.now()) >= deadline) break
    await deps.sleep(POLL_INTERVAL_MS)
  }

  const current = readOwnedSession(runtimeRoot, sessionId, ownedSession)
  if (current.state === 'ready' || current.state === 'crashed') return viewFromState(current)
  if (current.state === 'starting') {
    if (readOwnedControl(runtimeRoot, sessionId, ownedSession) === undefined) {
      writeOwnedControl(ownedSession, { runtimeRoot, sessionId, control: { schemaVersion: 1, action: 'abort', requestedAt: safeNow(deps.now(), current.updatedAt) } })
    }
    await waitForTerminal({ runtimeRoot, sessionId, deps, timeoutMs, ownedSession, accept: stateValue => stateValue.state === 'aborted' || (stateValue.state === 'crashed' && stateValue.cleanup === 'fail') })
  }
  const finalState = readOwnedSession(runtimeRoot, sessionId, ownedSession)
  throw new Error(`UI session ${sessionId} startup timed out; runtime path: ${sessionDir}; state: ${finalState.state}`)
}

export function getUiSessionStatus(
  opts: { root: string; sessionId: string },
  deps: Pick<UiServiceDependencies, 'now' | 'processAlive'> = defaultStatusDependencies(),
): UiSessionViewV1 {
  validateSessionId(opts.sessionId)
  const runtimeRoot = rootPath(opts.root, ROOT_PATHS.runtime)
  const ownedSession = claimOwnedUiDirectory({ root: runtimeRoot, directory: join(runtimeRoot, 'ui-sessions', opts.sessionId) })
  ownedSession.assertCurrent()
  let state = readOwnedSession(runtimeRoot, opts.sessionId, ownedSession)
  const current = captureCurrentIdentity(opts.root, state)
  const observed = staleReasons(state, current)
  if (observed.length > 0 && !isTerminal(state.state)) {
    const newlyObserved = observed.filter(reason => !(state.staleReasons ?? []).includes(reason))
    if (newlyObserved.length > 0) {
      state = latchUiStaleReasons(state, newlyObserved, safeNow(deps.now(), state.updatedAt))
      writeOwnedSession(ownedSession, { runtimeRoot, state })
    }
  }
  const orphanPath = join(runtimeRoot, 'ui-sessions', opts.sessionId)
  if (state.state === 'starting' && state.supervisorPid === undefined) {
    const { url: _url, childPid: _childPid, ...orphaned } = state
    return viewFromState({
      ...orphaned,
      state: 'crashed',
      error: `UI supervisor owner is missing; session is orphaned at ${orphanPath}`,
    })
  }
  if ((state.state === 'starting' || state.state === 'ready') && state.supervisorPid !== undefined) {
    const supervisorAlive = deps.processAlive(state.supervisorPid)
    const childAlive = state.childPid === undefined ? true : supervisorAlive && deps.processAlive(state.childPid)
    if (supervisorAlive && childAlive) return viewFromState(state)
    const { url: _url, supervisorPid: _supervisorPid, childPid: _childPid, ...orphaned } = state
    return viewFromState({
      ...orphaned,
      state: 'crashed',
      error: `${supervisorAlive ? 'UI child is not running' : 'UI supervisor is not running'}; session is orphaned at ${orphanPath}`,
    })
  }
  if (state.state === 'crashed' && state.supervisorPid !== undefined && !deps.processAlive(state.supervisorPid)) {
    return viewFromState({
      ...state,
      error: `${state.error ?? 'UI session crashed'}; recovery supervisor is not running; session is orphaned at ${orphanPath}`,
    })
  }
  if (isTerminal(state.state)) {
    const derived = staleReasons(state, current)
    if (derived.length > 0) return viewFromState({ ...state, staleReasons: [...new Set([...(state.staleReasons ?? []), ...derived])].sort((a, b) => a.localeCompare(b)) })
  }
  return viewFromState(state)
}

export async function finishUiSession(opts: FinishUiOptions, deps: UiServiceDependencies = defaultDependencies()): Promise<UiResultV1> {
  validateSessionId(opts.sessionId)
  if (opts.verdict !== 'pass' && opts.verdict !== 'fail') throw new Error('verdict must be pass or fail')
  const summary = normalizeUiSummary(opts.summary)
  const timeoutMs = validateTimeout(opts.stopTimeoutMs, 'stopTimeoutMs')
  const runtimeRoot = rootPath(opts.root, ROOT_PATHS.runtime)
  const ownedSession = claimOwnedUiDirectory({ root: runtimeRoot, directory: join(runtimeRoot, 'ui-sessions', opts.sessionId) })
  ownedSession.assertCurrent()
  let state = readOwnedSession(runtimeRoot, opts.sessionId, ownedSession)
  if (state.state === 'finished' || state.state === 'aborted') throw new Error(`UI session ${opts.sessionId} is ${state.state} and immutable`)
  const identity = captureCurrentIdentity(opts.root, state)
  const reasons = staleReasons(state, identity)
  if (reasons.length > 0 || (state.staleReasons?.length ?? 0) > 0) {
    if (reasons.length > 0 && !isTerminal(state.state)) {
      const newlyObserved = reasons.filter(reason => !(state.staleReasons ?? []).includes(reason))
      if (newlyObserved.length > 0) {
        state = latchUiStaleReasons(state, newlyObserved, safeNow(deps.now(), state.updatedAt))
        writeOwnedSession(ownedSession, { runtimeRoot, state })
      }
    }
    throw new UiProtocolOutcomeError(`UI session ${opts.sessionId} is stale: ${(state.staleReasons ?? reasons).join(', ')}`, 'stale')
  }
  if (opts.verdict === 'pass' && state.state !== 'ready') throw new Error('pass requires a ready UI session')
  if (opts.verdict === 'fail' && state.state !== 'ready' && state.state !== 'crashed') throw new Error('fail requires a ready or crashed UI session')
  if (state.state === 'stopping') throw new Error(`UI session ${opts.sessionId} is already stopping; finish ownership belongs to another caller`)
  if (state.state === 'crashed' && state.cleanup === 'fail') throw new UiProtocolOutcomeError('UI session cleanup failed', 'cleanup-incomplete')

  writeOwnedControl(ownedSession, { runtimeRoot, sessionId: opts.sessionId, control: { schemaVersion: 1, action: 'finish', requestedAt: safeNow(deps.now(), state.updatedAt) } })
  state = await waitForState({ runtimeRoot, sessionId: opts.sessionId, deps, timeoutMs, ownedSession, accept: candidate => candidate.state === 'stopping' && candidate.cleanup === 'pass' && readOwnedControl(runtimeRoot, opts.sessionId, ownedSession) === undefined })
  if (state.state !== 'stopping' || state.cleanup !== 'pass') throw new Error(`UI session ${opts.sessionId} cleanup did not complete`)
  const finishedAt = deps.now()
  validateTimestamp(finishedAt, 'now')
  const publicationIdentity = captureCurrentIdentity(opts.root, state)
  const lateReasons = staleReasons(state, publicationIdentity)
  if (lateReasons.length > 0 || (state.staleReasons?.length ?? 0) > 0) {
    const newlyObserved = lateReasons.filter(reason => !(state.staleReasons ?? []).includes(reason))
    if (newlyObserved.length > 0) {
      state = latchUiStaleReasons(state, newlyObserved, safeNow(deps.now(), state.updatedAt))
      writeOwnedSession(ownedSession, { runtimeRoot, state })
    }
    throw new UiProtocolOutcomeError(`UI session ${opts.sessionId} became stale during cleanup: ${(state.staleReasons ?? lateReasons).join(', ')}`, 'stale')
  }
  const result: UiResultV1 = {
    schemaVersion: 1,
    sessionId: state.sessionId,
    operation: 'ui',
    verdict: opts.verdict,
    plugin: publicationIdentity.plugin,
    target: publicationIdentity.target,
    lab: { contextDigest: publicationIdentity.contextDigest },
    summary,
    cleanup: 'pass',
    startedAt: state.startedAt,
    finishedAt,
  }
  ownedSession.assertCurrent()
  deps.publishResult({ uiRunsRoot: rootPath(opts.root, ROOT_PATHS.uiRuns), result })
  ownedSession.assertCurrent()
  const terminal: UiSessionStateV1 = { ...state, state: 'finished', cleanup: 'pass', updatedAt: safeNow(deps.now(), state.updatedAt) }
  try { writeOwnedSession(ownedSession, { runtimeRoot, state: terminal }, deps.writeSession) } catch (error) {
    if (isOwnershipError(error)) throw error
    // Evidence publication is the immutable commit point. Keep the compact
    // stopping lease recoverable when terminal bookkeeping fails afterward.
  }
  return result
}

export async function abortUiSession(opts: AbortUiOptions, deps: UiServiceDependencies = defaultDependencies()): Promise<UiSessionViewV1> {
  validateSessionId(opts.sessionId)
  const timeoutMs = validateTimeout(opts.stopTimeoutMs, 'stopTimeoutMs')
  const runtimeRoot = rootPath(opts.root, ROOT_PATHS.runtime)
  const ownedSession = claimOwnedUiDirectory({ root: runtimeRoot, directory: join(runtimeRoot, 'ui-sessions', opts.sessionId) })
  ownedSession.assertCurrent()
  let state = readOwnedSession(runtimeRoot, opts.sessionId, ownedSession)
  if (state.state === 'finished') throw new Error(`UI session ${opts.sessionId} is finished and immutable`)
  if (state.state === 'aborted') return viewFromState(state)
  if (state.state === 'stopping') throw new Error(`UI session ${opts.sessionId} is already stopping`)
  if (state.state === 'crashed' && state.cleanup === 'fail') throw new UiProtocolOutcomeError('UI session cleanup failed', 'cleanup-incomplete')
  if (readOwnedControl(runtimeRoot, opts.sessionId, ownedSession) === undefined) {
    writeOwnedControl(ownedSession, { runtimeRoot, sessionId: opts.sessionId, control: { schemaVersion: 1, action: 'abort', requestedAt: safeNow(deps.now(), state.updatedAt) } })
  }
  state = await waitForState({ runtimeRoot, sessionId: opts.sessionId, deps, timeoutMs, ownedSession, accept: candidate => candidate.state === 'aborted' })
  if (state.state !== 'aborted') throw new UiProtocolOutcomeError(`UI session ${opts.sessionId} abort cleanup failed`, 'cleanup-incomplete')
  return viewFromState(state)
}

interface CapturedIdentity {
  plugin: UiSessionStateV1['plugin']
  target: UiTargetIdentity
  contextDigest: `sha256:${string}`
  runtimeName: string
}

function captureIdentity(root: string, plugin: PluginRef, target: 'next' | 'master'): CapturedIdentity {
  if (!plugin || typeof plugin.sourcePath !== 'string') throw new Error('plugin is required')
  const inspection = inspectPlugin({ root, plugin, target })
  if (!inspection.ok) throw new Error(`plugin inspection failed: ${inspection.diagnostics.filter(diagnostic => diagnostic.severity === 'error').map(diagnostic => diagnostic.code).join(', ')}`)
  if (!plugin.metadata?.targets?.includes(target)) throw new Error(`plugin does not declare target '${target}'`)
  const sourcePath = resolve(plugin.sourcePath)
  const entry = join(sourcePath, 'src', 'index.ts')
  if (!isRegularFile(entry)) throw new Error(`plugin source entry not found: ${entry}`)
  const runtimeName = plugin.metadata?.name
  if (typeof runtimeName !== 'string') throw new Error('plugin metadata must declare a runtime name')
  assertRuntimePluginIdentity(runtimeName)
  const compatibility = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))
  const targetIdentity = targetIdentityFromCompatibility(compatibility, target)
  return {
    plugin: { packageName: plugin.packageName, sourcePath, digest: computePluginDigest(sourcePath).digest },
    target: targetIdentity,
    contextDigest: computeContextDigest(root),
    runtimeName,
  }
}

function captureCurrentIdentity(root: string, state: UiSessionStateV1): CapturedIdentity {
  const target = currentTargetIdentity(root, state.target.name)
  return {
    plugin: { ...state.plugin, sourcePath: resolve(state.plugin.sourcePath), digest: computePluginDigest(state.plugin.sourcePath).digest },
    target,
    contextDigest: computeContextDigest(root),
    runtimeName: state.plugin.packageName,
  }
}

function currentTargetIdentity(root: string, target: 'next' | 'master'): UiTargetIdentity {
  return targetIdentityFromCompatibility(loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility)), target)
}

function targetIdentityFromCompatibility(compatibility: Compatibility, target: 'next' | 'master'): UiTargetIdentity {
  const pin = compatibility.targets[target]
  if (target === 'next') {
    if (!pin?.dsh) throw new Error('next target requires a pinned dsh version')
    return { name: 'next', dsh: pin.dsh }
  }
  if (!pin?.commit) throw new Error('master target requires a pinned commit')
  return { name: 'master', commit: pin.commit }
}

function staleReasons(state: UiSessionStateV1, current: CapturedIdentity): UiStaleReason[] {
  const reasons: UiStaleReason[] = []
  if (current.plugin.digest !== state.plugin.digest || current.plugin.packageName !== state.plugin.packageName || current.plugin.sourcePath !== state.plugin.sourcePath) reasons.push('plugin-changed')
  if (current.contextDigest !== state.contextDigest) reasons.push('context-changed')
  if (!sameTarget(current.target, state.target)) reasons.push('target-changed')
  return reasons.sort((left, right) => left.localeCompare(right))
}

function viewFromState(state: UiSessionStateV1): UiSessionViewV1 {
  const staleReasons = [...(state.staleReasons ?? [])].sort((left, right) => left.localeCompare(right))
  const view: UiSessionViewV1 = {
    schemaVersion: 1,
    sessionId: state.sessionId,
    state: state.state,
    stale: staleReasons.length > 0,
    staleReasons,
    plugin: state.plugin,
    target: state.target,
    contextDigest: state.contextDigest,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
  }
  if (staleReasons.length === 0 && state.state === 'ready' && state.url !== undefined) view.url = state.url
  if (state.error !== undefined) view.error = state.error
  if (state.cleanup !== undefined) view.cleanup = state.cleanup
  return view
}

async function waitForState(opts: {
  runtimeRoot: string
  sessionId: string
  deps: Pick<UiServiceDependencies, 'sleep' | 'now'>
  timeoutMs: number
  ownedSession: OwnedUiDirectory
  accept: (state: UiSessionStateV1) => boolean
}): Promise<UiSessionStateV1> {
  const started = opts.deps.now()
  validateTimestamp(started, 'now')
  const deadline = Date.parse(started) + opts.timeoutMs
  while (true) {
    const state = readOwnedSession(opts.runtimeRoot, opts.sessionId, opts.ownedSession)
    if (opts.accept(state)) return state
    if (state.state === 'crashed' && state.cleanup === 'fail') throw new UiProtocolOutcomeError(`UI session ${opts.sessionId} cleanup failed`, 'cleanup-incomplete')
    opts.ownedSession.assertCurrent()
    await opts.deps.sleep(POLL_INTERVAL_MS)
    opts.ownedSession.assertCurrent()
    if (Date.parse(opts.deps.now()) >= deadline) {
      const afterSleep = readOwnedSession(opts.runtimeRoot, opts.sessionId, opts.ownedSession)
      if (opts.accept(afterSleep)) return afterSleep
      throw new UiProtocolOutcomeError(`UI session ${opts.sessionId} cleanup timed out`, 'cleanup-incomplete')
    }
  }
}

async function waitForTerminal(opts: {
  runtimeRoot: string
  sessionId: string
  deps: Pick<UiServiceDependencies, 'sleep' | 'now'>
  timeoutMs: number
  ownedSession: OwnedUiDirectory
  accept: (state: UiSessionStateV1) => boolean
}): Promise<UiSessionStateV1> {
  return waitForState(opts)
}

function isRegularFile(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() } catch { return false }
}
function validateRootAndTarget(root: string, target: 'next' | 'master'): void {
  if (typeof root !== 'string' || !root.trim()) throw new Error('root must be a non-empty path')
  if (target !== 'next' && target !== 'master') throw new Error('invalid target')
}
function validateTimeout(value: number | undefined, field: string): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeout) || timeout < 0) throw new Error(`${field} must be a non-negative integer`)
  return timeout
}
function validateSessionId(value: string): void { if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error(`invalid or unsafe sessionId ${JSON.stringify(value)}`) }
function validateTimestamp(value: string, field: string): void { if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`) }
function safeNow(candidate: string, previous: string): string { validateTimestamp(candidate, 'now'); return Date.parse(candidate) < Date.parse(previous) ? previous : candidate }
function sanitizeServiceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || 'UI supervisor spawn failed'
}
function isOwnershipError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /identity|ownership|replacement|swap|symlink|junction/i.test(message)
}
function isTerminal(state: UiSessionPhase): boolean { return state === 'finished' || state === 'aborted' }
function sameTarget(left: UiTargetIdentity, right: UiTargetIdentity): boolean {
  if (left.name !== right.name) return false
  return left.name === 'next'
    ? left.dsh === (right.name === 'next' ? right.dsh : undefined)
    : left.commit === (right.name === 'master' ? right.commit : undefined)
}
function defaultStatusDependencies(): Pick<UiServiceDependencies, 'now' | 'processAlive'> { return { now: () => new Date().toISOString(), processAlive: pid => { try { process.kill(pid, 0); return true } catch { return false } } } }
function defaultDependencies(): UiServiceDependencies {
  return {
    spawnSupervisor: requestPath => {
      const plan = buildUiSupervisorSpawn(requestPath)
      const child = spawn(plan.command, plan.args, plan.options)
      if (!child.pid) throw new Error('failed to start UI supervisor')
      return { pid: child.pid, unref: () => child.unref() }
    },
    sleep: ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)),
    now: () => new Date().toISOString(),
    processAlive: defaultStatusDependencies().processAlive,
    publishResult: opts => publishUiResult(opts),
    writeSession: opts => writeUiSession(opts),
  }
}

function readOwnedSession(runtimeRoot: string, sessionId: string, ownedSession: OwnedUiDirectory): UiSessionStateV1 {
  ownedSession.assertCurrent()
  try { return readUiSession({ runtimeRoot, sessionId }) } finally { ownedSession.assertCurrent() }
}

function readOwnedControl(runtimeRoot: string, sessionId: string, ownedSession: OwnedUiDirectory): UiControlV1 | undefined {
  ownedSession.assertCurrent()
  try { return readUiControl({ runtimeRoot, sessionId }) } finally { ownedSession.assertCurrent() }
}

function writeOwnedControl(ownedSession: OwnedUiDirectory, opts: Parameters<typeof writeUiControl>[0]): void {
  ownedSession.assertCurrent()
  try { writeUiControl(opts) } finally { ownedSession.assertCurrent() }
}

function writeOwnedSession(
  ownedSession: OwnedUiDirectory,
  opts: Parameters<typeof writeUiSession>[0],
  writeSession: (opts: Parameters<typeof writeUiSession>[0]) => void = writeUiSession,
): void {
  ownedSession.assertCurrent()
  try { writeSession(opts) } finally { ownedSession.assertCurrent() }
}
