import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'
import type { PluginRef } from './plugin-ref.js'
import {
  aggregateRestartHash,
  computeDevRestartBaseline,
  restartReasonsForBaseline,
  type DevRestartBaseline,
  type DevRestartReason,
} from './dev-restart-baseline.js'
import {
  createDevSessionId,
  createOwnedDevSession,
  latchDevRestartReasons,
  readDevControl,
  readDevSession,
  validateDevSessionId,
  viewFromDevState,
  writeDevControl,
  writeDevSession,
  writeDevSessionRequest,
  type DevControlV1,
  type DevSessionPhase,
  type DevSessionStateV1,
  type DevSessionViewV1,
} from './dev-session-state.js'
import { assertRuntimePluginIdentity } from './runtime-identity.js'
import { loadCompatibilityFromFile, type Compatibility } from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'
import { resolveTsxLoader } from './run.js'
import { claimOwnedUiDirectory, type OwnedUiDirectory } from './ui-owned-directory.js'

export interface StartDevOptions {
  root: string
  plugin: PluginRef
  target: 'next' | 'master'
  startupTimeoutMs?: number
}

export interface StopDevOptions {
  root: string
  sessionId: string
  stopTimeoutMs?: number
}

export interface DevServiceDependencies {
  spawnSupervisor(requestPath: string): { pid: number; unref(): void }
  sleep(ms: number): Promise<void>
  now(): string
  processAlive(pid: number): boolean
  writeSession(opts: Parameters<typeof writeDevSession>[0]): void
  afterSessionCreate?(sessionDirectory: string): void
  beforeRequestWrite?(sessionDirectory: string): void
}

export type DevProtocolOutcome = 'cleanup-incomplete'
export class DevProtocolOutcomeError extends Error {
  readonly outcome: DevProtocolOutcome
  readonly exitCode = 2 as const

  constructor(message: string, outcome: DevProtocolOutcome) {
    super(message)
    this.name = 'DevProtocolOutcomeError'
    this.outcome = outcome
  }
}

const DEFAULT_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 25

export function buildDevSupervisorSpawn(requestPath: string): { command: string; args: string[]; options: { detached: true; shell: false; stdio: 'ignore'; windowsHide: true } } {
  if (typeof requestPath !== 'string' || !isAbsolute(requestPath)) throw new Error('requestPath must be an absolute path')
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  const bin = fileURLToPath(new URL(`./dev-supervisor-bin.${extension}`, import.meta.url))
  const args = extension === 'ts'
    ? ['--import', resolveTsxLoader(), bin, requestPath]
    : [bin, requestPath]
  return {
    command: process.execPath,
    args,
    options: { detached: true, shell: false, stdio: 'ignore', windowsHide: true },
  }
}

export async function startDevSession(opts: StartDevOptions, deps: DevServiceDependencies = defaultDevServiceDependencies()): Promise<DevSessionViewV1> {
  validateRootAndTarget(opts.root, opts.target)
  const timeoutMs = validateTimeout(opts.startupTimeoutMs, 'startupTimeoutMs')
  const identity = captureDevIdentity(opts.root, opts.plugin, opts.target)
  const startedAt = deps.now()
  validateTimestamp(startedAt, 'now')
  const sessionId = createDevSessionId(new Date(startedAt))
  const runtimeRoot = rootPath(opts.root, ROOT_PATHS.runtime)
  const state: DevSessionStateV1 = {
    schemaVersion: 1,
    sessionId,
    state: 'starting',
    plugin: identity.plugin,
    target: identity.target,
    restartBaseline: identity.restartBaseline,
    restartHash: identity.restartHash,
    restartRequired: false,
    startedAt,
    updatedAt: startedAt,
  }
  const { sessionDir, ownedSession } = createOwnedDevSession({ runtimeRoot, state })
  ownedSession.assertCurrent()
  deps.afterSessionCreate?.(sessionDir)
  ownedSession.assertCurrent()
  deps.beforeRequestWrite?.(sessionDir)
  ownedSession.assertCurrent()
  const requestPath = writeDevSessionRequest({
    runtimeRoot,
    sessionId,
    ownedSession,
    request: {
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
      restartBaseline: identity.restartBaseline,
    },
  })
  ownedSession.assertCurrent()
  let supervisor: { pid: number; unref(): void }
  try {
    ownedSession.assertCurrent()
    supervisor = deps.spawnSupervisor(requestPath)
    if (!supervisor || !Number.isInteger(supervisor.pid) || supervisor.pid <= 0 || typeof supervisor.unref !== 'function') {
      throw new Error('dev supervisor did not return a valid process')
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
    if (current.state === 'ready' || current.state === 'crashed' || current.state === 'stopped') return viewFromDevState(current)
    if (Date.parse(deps.now()) >= deadline) break
    await deps.sleep(POLL_INTERVAL_MS)
  }

  const current = readOwnedSession(runtimeRoot, sessionId, ownedSession)
  if (current.state === 'ready' || current.state === 'crashed' || current.state === 'stopped') return viewFromDevState(current)
  if (current.state === 'starting' || current.state === 'stopping') {
    if (current.state === 'starting' && readOwnedControl(runtimeRoot, sessionId, ownedSession) === undefined) {
      writeOwnedControl(ownedSession, { runtimeRoot, sessionId, control: { schemaVersion: 1, action: 'stop', requestedAt: safeNow(deps.now(), current.updatedAt) } })
    }
    const terminal = await waitForTerminal({ runtimeRoot, sessionId, deps, timeoutMs, ownedSession, accept: stateValue => stateValue.state === 'stopped' || (stateValue.state === 'crashed' && stateValue.cleanup === 'fail') })
    return viewFromDevState(terminal)
  }
  const finalState = readOwnedSession(runtimeRoot, sessionId, ownedSession)
  throw new Error(`dev session ${sessionId} startup timed out; runtime path: ${sessionDir}; state: ${finalState.state}`)
}

export function getDevSessionStatus(
  opts: { root: string; sessionId: string },
  deps: Pick<DevServiceDependencies, 'now' | 'processAlive'> = defaultDevStatusDependencies(),
): DevSessionViewV1 {
  validateDevSessionId(opts.sessionId)
  const runtimeRoot = rootPath(opts.root, ROOT_PATHS.runtime)
  const ownedSession = claimOwnedUiDirectory({ root: runtimeRoot, directory: join(runtimeRoot, 'dev-sessions', opts.sessionId) })
  ownedSession.assertCurrent()
  let state = readOwnedSession(runtimeRoot, opts.sessionId, ownedSession)
  if (state.state !== 'stopped' && state.state !== 'crashed') {
    const targetPin = currentDevTargetPin(opts.root, state)
    let newReasons: DevRestartReason[] = []
    try {
      const currentBaseline = computeDevRestartBaseline({ pluginSourcePath: state.plugin.sourcePath, targetPin })
      newReasons = restartReasonsForBaseline(currentBaseline, state.restartBaseline)
    } catch (error) {
      // Only a vanished lived plugin manifest is a restart signal; a metadata
      // file that disappeared is already folded into EMPTY_DIGEST. Compatibility
      // loss is surfaced by currentDevTargetPin above, so this cannot mask a
      // config error as a plugin change.
      if (!isMissingPathError(error)) throw error
      newReasons = ['plugin-manifest']
    }
    if (newReasons.length > 0) {
      const newlyObserved = newReasons.filter(reason => !(state.restartReasons ?? []).includes(reason))
      if (newlyObserved.length > 0) {
        state = latchDevRestartReasons(state, newlyObserved, safeNow(deps.now(), state.updatedAt))
        writeOwnedSession(ownedSession, { runtimeRoot, state })
      }
    }
  }
  const orphan = orphanViewForState(opts.root, state, deps)
  if (orphan !== undefined) return orphan
  return viewFromDevState(state)
}

export async function stopDevSession(opts: StopDevOptions, deps: DevServiceDependencies = defaultDevServiceDependencies()): Promise<DevSessionViewV1> {
  validateDevSessionId(opts.sessionId)
  const timeoutMs = validateTimeout(opts.stopTimeoutMs, 'stopTimeoutMs')
  const runtimeRoot = rootPath(opts.root, ROOT_PATHS.runtime)
  const ownedSession = claimOwnedUiDirectory({ root: runtimeRoot, directory: join(runtimeRoot, 'dev-sessions', opts.sessionId) })
  ownedSession.assertCurrent()
  let state = readOwnedSession(runtimeRoot, opts.sessionId, ownedSession)
  if (state.state === 'stopped') return viewFromDevState(state)
  if (state.state === 'stopping') throw new Error(`dev session ${opts.sessionId} is already stopping`)
  if (state.state === 'crashed' && state.cleanup === 'fail') throw new DevProtocolOutcomeError('dev session cleanup failed', 'cleanup-incomplete')
  const orphan = orphanViewForState(opts.root, state, deps)
  if (orphan !== undefined) return orphan
  if (readOwnedControl(runtimeRoot, opts.sessionId, ownedSession) === undefined) {
    writeOwnedControl(ownedSession, { runtimeRoot, sessionId: opts.sessionId, control: { schemaVersion: 1, action: 'stop', requestedAt: safeNow(deps.now(), state.updatedAt) } })
  }
  state = await waitForState({ runtimeRoot, sessionId: opts.sessionId, deps, timeoutMs, ownedSession, accept: candidate => candidate.state === 'stopped' })
  if (state.state !== 'stopped') throw new DevProtocolOutcomeError(`dev session ${opts.sessionId} stop cleanup failed`, 'cleanup-incomplete')
  return viewFromDevState(state)
}

export function defaultDevServiceDependencies(): DevServiceDependencies {
  return {
    spawnSupervisor: requestPath => {
      const plan = buildDevSupervisorSpawn(requestPath)
      const child = spawn(plan.command, plan.args, plan.options)
      if (!child.pid) throw new Error('failed to start dev supervisor')
      return { pid: child.pid, unref: () => child.unref() }
    },
    sleep: ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)),
    now: () => new Date().toISOString(),
    processAlive: defaultDevStatusDependencies().processAlive,
    writeSession: opts => writeDevSession(opts),
  }
}

export function defaultDevStatusDependencies(): Pick<DevServiceDependencies, 'now' | 'processAlive'> {
  return {
    now: () => new Date().toISOString(),
    processAlive: pid => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw error
      }
    },
  }
}

interface CapturedDevIdentity {
  plugin: DevSessionStateV1['plugin']
  target: DevSessionStateV1['target']
  restartBaseline: DevRestartBaseline
  restartHash: `sha256:${string}`
  runtimeName: string
}

function captureDevIdentity(root: string, plugin: PluginRef, target: 'next' | 'master'): CapturedDevIdentity {
  if (!plugin || typeof plugin.sourcePath !== 'string') throw new Error('plugin is required')
  if (!plugin.metadata?.targets?.includes(target)) throw new Error(`plugin does not declare target '${target}'`)
  const sourcePath = resolve(plugin.sourcePath)
  const entry = join(sourcePath, 'src', 'index.ts')
  if (!isRegularFile(entry)) throw new Error(`plugin source entry not found: ${entry}`)
  const runtimeName = plugin.metadata?.name
  if (typeof runtimeName !== 'string') throw new Error('plugin metadata must declare a runtime name')
  assertRuntimePluginIdentity(runtimeName)
  const compatibility = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))
  const targetIdentity = targetIdentityFromCompatibility(compatibility, target)
  const targetPin = targetIdentity.name === 'next' ? targetIdentity.dsh : targetIdentity.commit
  const restartBaseline = computeDevRestartBaseline({ pluginSourcePath: sourcePath, targetPin })
  return {
    plugin: { packageName: plugin.packageName, sourcePath, runtimeName },
    target: targetIdentity,
    restartBaseline,
    restartHash: aggregateRestartHash(restartBaseline),
    runtimeName,
  }
}

function currentDevTargetPin(root: string, state: DevSessionStateV1): string {
  const compatibility = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))
  return state.target.name === 'next'
    ? compatibility.targets.next.dsh ?? ''
    : compatibility.targets.master.commit ?? ''
}

function targetIdentityFromCompatibility(compatibility: Compatibility, target: 'next' | 'master'): DevSessionStateV1['target'] {
  const pin = compatibility.targets[target]
  if (target === 'next') {
    if (!pin?.dsh) throw new Error('next target requires a pinned dsh version')
    return { name: 'next', dsh: pin.dsh }
  }
  if (!pin?.commit) throw new Error('master target requires a pinned commit')
  return { name: 'master', commit: pin.commit }
}

function orphanViewForState(root: string, state: DevSessionStateV1, deps: Pick<DevServiceDependencies, 'processAlive'>): DevSessionViewV1 | undefined {
  const orphanPath = join(rootPath(root, ROOT_PATHS.runtime), 'dev-sessions', state.sessionId)
  if (state.state === 'starting' && state.supervisorPid === undefined) {
    const { url: _url, childPid: _childPid, ...orphaned } = state
    const view = viewFromDevState({
      ...orphaned,
      state: 'crashed',
      error: `dev supervisor owner is missing; session is orphaned at ${orphanPath}`,
    })
    view.orphan = true
    return view
  }
  if ((state.state === 'starting' || state.state === 'ready') && state.supervisorPid !== undefined) {
    const supervisorAlive = deps.processAlive(state.supervisorPid)
    const childAlive = state.childPid === undefined ? true : supervisorAlive && deps.processAlive(state.childPid)
    if (supervisorAlive && childAlive) return undefined
    const { url: _url, supervisorPid: _supervisorPid, childPid: _childPid, ...orphaned } = state
    const view = viewFromDevState({
      ...orphaned,
      state: 'crashed',
      error: `${supervisorAlive ? 'dev child is not running' : 'dev supervisor is not running'}; session is orphaned at ${orphanPath}`,
    })
    view.orphan = true
    return view
  }
  if (state.state === 'crashed' && state.supervisorPid !== undefined && !deps.processAlive(state.supervisorPid)) {
    const view = viewFromDevState({
      ...state,
      error: `${state.error ?? 'dev session crashed'}; recovery supervisor is not running; session is orphaned at ${orphanPath}`,
    })
    view.orphan = true
    return view
  }
  if (state.state === 'crashed' && state.supervisorPid === undefined) {
    const view = viewFromDevState({
      ...state,
      error: `${state.error ?? 'dev session crashed'}; recovery owner is missing; session is orphaned at ${orphanPath}`,
    })
    view.orphan = true
    return view
  }
  return undefined
}

async function waitForState(opts: {
  runtimeRoot: string
  sessionId: string
  deps: Pick<DevServiceDependencies, 'sleep' | 'now'>
  timeoutMs: number
  ownedSession: OwnedUiDirectory
  accept: (state: DevSessionStateV1) => boolean
}): Promise<DevSessionStateV1> {
  const started = opts.deps.now()
  validateTimestamp(started, 'now')
  const deadline = Date.parse(started) + opts.timeoutMs
  while (true) {
    const state = readOwnedSession(opts.runtimeRoot, opts.sessionId, opts.ownedSession)
    if (opts.accept(state)) return state
    if (state.state === 'crashed' && state.cleanup === 'fail') throw new DevProtocolOutcomeError(`dev session ${opts.sessionId} cleanup failed`, 'cleanup-incomplete')
    opts.ownedSession.assertCurrent()
    await opts.deps.sleep(POLL_INTERVAL_MS)
    opts.ownedSession.assertCurrent()
    if (Date.parse(opts.deps.now()) >= deadline) {
      const afterSleep = readOwnedSession(opts.runtimeRoot, opts.sessionId, opts.ownedSession)
      if (opts.accept(afterSleep)) return afterSleep
      throw new DevProtocolOutcomeError(`dev session ${opts.sessionId} cleanup timed out`, 'cleanup-incomplete')
    }
  }
}

async function waitForTerminal(opts: {
  runtimeRoot: string
  sessionId: string
  deps: Pick<DevServiceDependencies, 'sleep' | 'now'>
  timeoutMs: number
  ownedSession: OwnedUiDirectory
  accept: (state: DevSessionStateV1) => boolean
}): Promise<DevSessionStateV1> {
  return waitForState(opts)
}

function isRegularFile(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
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

function validateTimestamp(value: string, field: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`)
}

function safeNow(candidate: string, previous: string): string {
  validateTimestamp(candidate, 'now')
  return Date.parse(candidate) < Date.parse(previous) ? previous : candidate
}

function sanitizeServiceError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || 'dev supervisor spawn failed'
}

function readOwnedSession(runtimeRoot: string, sessionId: string, ownedSession: OwnedUiDirectory): DevSessionStateV1 {
  ownedSession.assertCurrent()
  try {
    return readDevSession({ runtimeRoot, sessionId })
  } finally {
    ownedSession.assertCurrent()
  }
}

function readOwnedControl(runtimeRoot: string, sessionId: string, ownedSession: OwnedUiDirectory): DevControlV1 | undefined {
  ownedSession.assertCurrent()
  try {
    return readDevControl({ runtimeRoot, sessionId })
  } finally {
    ownedSession.assertCurrent()
  }
}

function writeOwnedControl(ownedSession: OwnedUiDirectory, opts: Parameters<typeof writeDevControl>[0]): void {
  ownedSession.assertCurrent()
  try {
    writeDevControl({ ...opts, ownedSession })
  } finally {
    ownedSession.assertCurrent()
  }
}

function writeOwnedSession(
  ownedSession: OwnedUiDirectory,
  opts: Parameters<typeof writeDevSession>[0],
  writeSession: (opts: Parameters<typeof writeDevSession>[0]) => void = writeDevSession,
): void {
  ownedSession.assertCurrent()
  try {
    writeSession({ ...opts, ownedSession })
  } finally {
    ownedSession.assertCurrent()
  }
}
