import { spawn } from 'node:child_process'
import {
  constants,
  lstatSync,
  openSync,
  closeSync,
  writeFileSync,
} from 'node:fs'
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
  writeUiSession,
  type UiSessionPhase,
  type UiSessionStateV1,
  type UiStaleReason,
} from './ui-session.js'
import { normalizeUiSummary, publishUiResult, type UiResultV1, type UiTargetIdentity } from './ui-evidence.js'
import { computeContextDigest } from './status.js'

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
}

export interface UiSupervisorSpawnPlan {
  command: string
  args: [string, string]
  options: { detached: true; shell: false; stdio: 'ignore'; windowsHide: true }
}

const DEFAULT_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 25
const SESSION_ID = /^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$/

export function buildUiSupervisorSpawn(requestPath: string): UiSupervisorSpawnPlan {
  if (typeof requestPath !== 'string' || !isAbsolute(requestPath)) throw new Error('requestPath must be an absolute path')
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  const supervisorBin = fileURLToPath(new URL(`./ui-supervisor-bin.${extension}`, import.meta.url))
  return {
    command: process.execPath,
    args: [supervisorBin, requestPath],
    options: { detached: true, shell: false, stdio: 'ignore', windowsHide: true },
  }
}

export async function startUiSession(opts: StartUiOptions, deps: UiServiceDependencies = defaultDependencies()): Promise<UiSessionViewV1> {
  validateRootAndTarget(opts.root, opts.target)
  const timeoutMs = validateTimeout(opts.startupTimeoutMs, 'startupTimeoutMs')
  const identity = captureIdentity(opts.root, opts.plugin, opts.target)
  // The session timestamp is captured at creation time. The injected clock is
  // still used for every service deadline and subsequent lifecycle timestamp;
  // using the wall clock here keeps a test/supervisor that publishes an
  // earlier monotonic update from violating the session store's ordering rule.
  const startedAt = new Date().toISOString()
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
  const requestPath = join(sessionDir, 'request.json')
  writeRequest(requestPath, {
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
  })
  const supervisor = deps.spawnSupervisor(requestPath)
  if (!supervisor || !Number.isInteger(supervisor.pid) || supervisor.pid <= 0 || typeof supervisor.unref !== 'function') {
    throw new Error(`UI supervisor did not return a valid process for session ${sessionId}`)
  }
  supervisor.unref()

  const deadline = Date.parse(startedAt) + timeoutMs
  while (true) {
    const current = readUiSession({ runtimeRoot, sessionId })
    if (current.state === 'ready' || current.state === 'crashed') return viewFromState(current)
    if (Date.parse(deps.now()) >= deadline) break
    await deps.sleep(POLL_INTERVAL_MS)
  }

  const current = readUiSession({ runtimeRoot, sessionId })
  if (current.state === 'starting') {
    if (readUiControl({ runtimeRoot, sessionId }) === undefined) {
      writeUiControl({ runtimeRoot, sessionId, control: { schemaVersion: 1, action: 'abort', requestedAt: safeNow(deps.now(), current.updatedAt) } })
    }
    await waitForTerminal({ runtimeRoot, sessionId, deps, timeoutMs, accept: stateValue => stateValue.state === 'aborted' || (stateValue.state === 'crashed' && stateValue.cleanup === 'fail') })
  }
  const finalState = readUiSession({ runtimeRoot, sessionId })
  throw new Error(`UI session ${sessionId} startup timed out; runtime path: ${sessionDir}; state: ${finalState.state}`)
}

export function getUiSessionStatus(
  opts: { root: string; sessionId: string },
  deps: Pick<UiServiceDependencies, 'now' | 'processAlive'> = defaultStatusDependencies(),
): UiSessionViewV1 {
  validateSessionId(opts.sessionId)
  const runtimeRoot = rootPath(opts.root, ROOT_PATHS.runtime)
  let state = readUiSession({ runtimeRoot, sessionId: opts.sessionId })
  const current = captureCurrentIdentity(opts.root, state)
  const observed = staleReasons(state, current)
  if (observed.length > 0 && !isTerminal(state.state)) {
    const newlyObserved = observed.filter(reason => !(state.staleReasons ?? []).includes(reason))
    if (newlyObserved.length > 0) {
      state = latchUiStaleReasons(state, newlyObserved, safeNow(deps.now(), state.updatedAt))
      writeUiSession({ runtimeRoot, state })
    }
  }
  if (state.state === 'ready' && state.supervisorPid !== undefined && !deps.processAlive(state.supervisorPid)) {
    const { url: _url, ...orphaned } = state
    return viewFromState({
      ...orphaned,
      state: 'crashed',
      error: 'UI supervisor is not running; session is orphaned',
    })
  }
  return viewFromState(state)
}

export async function finishUiSession(opts: FinishUiOptions, deps: UiServiceDependencies = defaultDependencies()): Promise<UiResultV1> {
  validateSessionId(opts.sessionId)
  if (opts.verdict !== 'pass' && opts.verdict !== 'fail') throw new Error('verdict must be pass or fail')
  const summary = normalizeUiSummary(opts.summary)
  const timeoutMs = validateTimeout(opts.stopTimeoutMs, 'stopTimeoutMs')
  const runtimeRoot = rootPath(opts.root, ROOT_PATHS.runtime)
  let state = readUiSession({ runtimeRoot, sessionId: opts.sessionId })
  if (state.state === 'finished' || state.state === 'aborted') throw new Error(`UI session ${opts.sessionId} is ${state.state} and immutable`)
  const identity = captureCurrentIdentity(opts.root, state)
  const reasons = staleReasons(state, identity)
  if (reasons.length > 0 || (state.staleReasons?.length ?? 0) > 0) {
    if (reasons.length > 0 && !isTerminal(state.state)) {
      const newlyObserved = reasons.filter(reason => !(state.staleReasons ?? []).includes(reason))
      if (newlyObserved.length > 0) {
        state = latchUiStaleReasons(state, newlyObserved, safeNow(deps.now(), state.updatedAt))
        writeUiSession({ runtimeRoot, state })
      }
    }
    throw new Error(`UI session ${opts.sessionId} is stale: ${(state.staleReasons ?? reasons).join(', ')}`)
  }
  if (opts.verdict === 'pass' && state.state !== 'ready') throw new Error('pass requires a ready UI session')
  if (opts.verdict === 'fail' && state.state !== 'ready' && state.state !== 'crashed' && state.state !== 'stopping') throw new Error('fail requires a ready or crashed UI session')
  if (state.state === 'crashed' && state.cleanup === 'fail') throw new Error('UI session cleanup failed')

  if (state.state !== 'stopping') {
    writeUiControl({ runtimeRoot, sessionId: opts.sessionId, control: { schemaVersion: 1, action: 'finish', requestedAt: safeNow(deps.now(), state.updatedAt) } })
    state = await waitForState({ runtimeRoot, sessionId: opts.sessionId, deps, timeoutMs, accept: candidate => candidate.state === 'stopping' && candidate.cleanup === 'pass' })
  }
  if (state.state !== 'stopping' || state.cleanup !== 'pass') throw new Error(`UI session ${opts.sessionId} cleanup did not complete`)
  const finishedAt = deps.now()
  validateTimestamp(finishedAt, 'now')
  const result: UiResultV1 = {
    schemaVersion: 1,
    sessionId: state.sessionId,
    operation: 'ui',
    verdict: opts.verdict,
    plugin: identity.plugin,
    target: identity.target,
    lab: { contextDigest: identity.contextDigest },
    summary,
    cleanup: 'pass',
    startedAt: state.startedAt,
    finishedAt,
  }
  deps.publishResult({ uiRunsRoot: rootPath(opts.root, ROOT_PATHS.uiRuns), result })
  const terminal: UiSessionStateV1 = { ...state, state: 'finished', cleanup: 'pass', updatedAt: safeNow(deps.now(), state.updatedAt) }
  writeUiSession({ runtimeRoot, state: terminal })
  return result
}

export async function abortUiSession(opts: AbortUiOptions, deps: UiServiceDependencies = defaultDependencies()): Promise<UiSessionViewV1> {
  validateSessionId(opts.sessionId)
  const timeoutMs = validateTimeout(opts.stopTimeoutMs, 'stopTimeoutMs')
  const runtimeRoot = rootPath(opts.root, ROOT_PATHS.runtime)
  let state = readUiSession({ runtimeRoot, sessionId: opts.sessionId })
  if (state.state === 'finished') throw new Error(`UI session ${opts.sessionId} is finished and immutable`)
  if (state.state === 'aborted') return viewFromState(state)
  if (state.state === 'stopping') throw new Error(`UI session ${opts.sessionId} is already stopping`)
  if (state.state === 'crashed' && state.cleanup === 'fail') throw new Error('UI session cleanup failed')
  if (readUiControl({ runtimeRoot, sessionId: opts.sessionId }) === undefined) {
    writeUiControl({ runtimeRoot, sessionId: opts.sessionId, control: { schemaVersion: 1, action: 'abort', requestedAt: safeNow(deps.now(), state.updatedAt) } })
  }
  state = await waitForState({ runtimeRoot, sessionId: opts.sessionId, deps, timeoutMs, accept: candidate => candidate.state === 'aborted' })
  if (state.state !== 'aborted') throw new Error(`UI session ${opts.sessionId} abort cleanup failed`)
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
  if (JSON.stringify(current.target) !== JSON.stringify(state.target)) reasons.push('target-changed')
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
  accept: (state: UiSessionStateV1) => boolean
}): Promise<UiSessionStateV1> {
  const started = opts.deps.now()
  validateTimestamp(started, 'now')
  const deadline = Date.parse(started) + opts.timeoutMs
  while (true) {
    const state = readUiSession(opts)
    if (opts.accept(state)) return state
    if (state.state === 'crashed' && state.cleanup === 'fail') throw new Error(`UI session ${opts.sessionId} cleanup failed`)
    await opts.deps.sleep(POLL_INTERVAL_MS)
    if (Date.parse(opts.deps.now()) >= deadline) {
      const afterSleep = readUiSession(opts)
      if (opts.accept(afterSleep)) return afterSleep
      throw new Error(`UI session ${opts.sessionId} cleanup timed out`)
    }
  }
}

async function waitForTerminal(opts: {
  runtimeRoot: string
  sessionId: string
  deps: Pick<UiServiceDependencies, 'sleep' | 'now'>
  timeoutMs: number
  accept: (state: UiSessionStateV1) => boolean
}): Promise<UiSessionStateV1> {
  return waitForState(opts)
}

function writeRequest(path: string, value: unknown): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600)
  try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8') } finally { closeSync(descriptor) }
}

function isRegularFile(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() } catch { return false }
}
function noFollowFlag(): number { return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0 }
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
function isTerminal(state: UiSessionPhase): boolean { return state === 'finished' || state === 'aborted' }
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
  }
}
