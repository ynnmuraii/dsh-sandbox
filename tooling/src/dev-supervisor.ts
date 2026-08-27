import { spawn } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { ROOT_PATHS, rootPath } from './context.js'
import type { DevRestartBaseline } from './dev-restart-baseline.js'
import {
  clearDevControl,
  readDevControl,
  readDevSession,
  writeDevSession,
  DEV_SESSION_ID_PATTERN,
  type DevControlV1,
  type DevSessionStateV1,
} from './dev-session-state.js'
import { assertRuntimePluginIdentity } from './runtime-identity.js'
import {
  loadCompatibilityFromFile,
  type Compatibility,
} from './schemas.js'
import {
  prepareDevRuntime,
  profileName,
  resolveUiLauncher,
  resolveProfileDshLauncher,
  type DevRuntimePlan,
  type DevRuntimePlugin,
} from './run.js'
import { claimOwnedUiDirectory, type OwnedUiDirectory, type OwnedUiMutationRetry } from './ui-owned-directory.js'
import {
  openBoundedSupervisorLog,
  parseDshReadyUrl,
  stopOwnedChildTree,
  type UiChildExit,
  type UiChildHandle,
  type UiDiagnosticLog,
} from './ui-supervisor.js'

export { parseDshReadyUrl, openBoundedSupervisorLog, stopOwnedChildTree, posixProcessGroup, windowsTreeKillArgs } from './ui-supervisor.js'

export interface DevSupervisorRequestV1 {
  schemaVersion: 1
  root: string
  sessionId: string
  plugin: DevRuntimePlugin
  target: 'next' | 'master'
  startedAt: string
  restartBaseline: DevRestartBaseline
}

export interface RuntimeLauncher {
  cmd: string
  args: string[]
}

export interface DevSupervisorRuntimePlan extends DevRuntimePlan {
  launcher: RuntimeLauncher
}

export interface DevSupervisorDependencies {
  prepareRuntime(opts: { root: string; plugin: DevRuntimePlugin; target: 'next' | 'master'; sessionId: string; signal?: AbortSignal; ownedSession?: OwnedUiDirectory }): Promise<DevSupervisorRuntimePlan>
  spawnChild(plan: DevSupervisorRuntimePlan): UiChildHandle
  resolveLauncher(root: string, target: 'next' | 'master', compat: Compatibility, signal?: AbortSignal): Promise<RuntimeLauncher>
  stopChildTree(handle: UiChildHandle): Promise<void>
  openLog(sessionDir: string, maxBytes: number): UiDiagnosticLog
  now(): string
  sleep(ms: number): Promise<void>
  pollIntervalMs: number
  maxLogBytes: number
}

const ISO = /^\d{4}-\d{2}-\d{2}T/
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/

function nextTimestamp(candidate: string, previous: string): string {
  if (!ISO.test(candidate) || Number.isNaN(Date.parse(candidate))) return previous
  return Date.parse(candidate) < Date.parse(previous) ? previous : candidate
}

function sanitizeDiagnostic(value: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return (text || 'dev supervisor failure').slice(0, 240)
}

function mutationRetryPolicy(deps: DevSupervisorDependencies): OwnedUiMutationRetry {
  return {
    attempts: 10,
    delayMs: attempt => Math.min(100 * 2 ** attempt, 1000),
    sleep: ms => deps.sleep(ms),
  }
}

function compactState(state: DevSessionStateV1, removePids: boolean): DevSessionStateV1 {
  const compact = { ...state }
  delete compact.url
  delete compact.error
  delete compact.cleanup
  if (removePids) {
    delete compact.supervisorPid
    delete compact.childPid
  }
  return compact
}

function compactForStopping(state: DevSessionStateV1, childPid: number | undefined): DevSessionStateV1 {
  const compact = { ...state }
  delete compact.url
  delete compact.error
  delete compact.cleanup
  delete compact.supervisorPid
  delete compact.childPid
  if (childPid !== undefined) compact.childPid = childPid
  return compact
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

function clearOwnedControl(runtimeRoot: string, sessionId: string, ownedSession: OwnedUiDirectory): void {
  ownedSession.assertCurrent()
  try {
    clearDevControl({ runtimeRoot, sessionId, ownedSession })
  } finally {
    ownedSession.assertCurrent()
  }
}

function writeState(runtimeRoot: string, state: DevSessionStateV1, ownedSession: OwnedUiDirectory): void {
  const updatedAt = nextTimestamp(state.updatedAt, state.updatedAt)
  ownedSession.assertCurrent()
  try {
    writeDevSession({ runtimeRoot, state: { ...state, updatedAt }, ownedSession })
  } finally {
    ownedSession.assertCurrent()
  }
}

async function cleanupSessionDescendants(sessionDir: string, owned: OwnedUiDirectory, deps: DevSupervisorDependencies): Promise<void> {
  const home = join(sessionDir, 'home')
  const overlay = join(sessionDir, 'overlay')
  const policy = mutationRetryPolicy(deps)
  owned.assertCurrent()
  if (existsSync(home)) await owned.removeDirectoryLeafRetrying('home', policy)
  owned.assertCurrent()
  if (existsSync(overlay)) await owned.removeDirectoryLeafRetrying('overlay', policy)
  owned.assertCurrent()
  await owned.removeFileLeafRetrying('supervisor.log', policy)
  owned.assertCurrent()
}

function markDevReady(runtimeRoot: string, sessionId: string, url: string, childPid: number, deps: DevSupervisorDependencies, ownedSession: OwnedUiDirectory): void {
  const state = readOwnedSession(runtimeRoot, sessionId, ownedSession)
  if (state.state !== 'starting') return
  writeState(runtimeRoot, {
    ...state,
    state: 'ready',
    supervisorPid: process.pid,
    childPid,
    url,
    updatedAt: nextTimestamp(deps.now(), state.updatedAt),
  }, ownedSession)
}

function markDevCrashed(runtimeRoot: string, sessionId: string, error: string, deps: DevSupervisorDependencies, ownedSession: OwnedUiDirectory, cleanup?: 'fail', preserveSupervisor = false): void {
  const state = readOwnedSession(runtimeRoot, sessionId, ownedSession)
  if (state.state !== 'starting' && state.state !== 'ready' && state.state !== 'crashed') return
  const crashedBase = compactState(state, cleanup === undefined)
  if (preserveSupervisor) {
    crashedBase.supervisorPid = process.pid
    if (cleanup === undefined) delete crashedBase.childPid
  }
  writeState(runtimeRoot, {
    ...crashedBase,
    state: 'crashed',
    error: sanitizeDiagnostic(error),
    ...(cleanup === undefined ? {} : { cleanup }),
    updatedAt: nextTimestamp(deps.now(), state.updatedAt),
  }, ownedSession)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

interface DevControlContext {
  deps: DevSupervisorDependencies
  runtimeRoot: string
  sessionDir: string
  request: DevSupervisorRequestV1
  ownedSession: OwnedUiDirectory
  child?: UiChildHandle
  diagnosticLog?: UiDiagnosticLog
  treeCleanupConfirmed: () => boolean
  markTreeCleanupConfirmed: () => void
  cleanupChildTree: () => Promise<void>
}

async function handleDevStop(control: DevControlV1, context: DevControlContext): Promise<void> {
  const { deps, runtimeRoot, sessionDir, request, ownedSession, child, diagnosticLog } = context
  try {
    const current = readOwnedSession(runtimeRoot, request.sessionId, ownedSession)
    writeState(runtimeRoot, {
      ...compactForStopping(current, child?.pid ?? current.childPid),
      state: 'stopping',
      updatedAt: nextTimestamp(deps.now(), current.updatedAt),
    }, ownedSession)
    diagnosticLog?.close()
    if (child !== undefined && !context.treeCleanupConfirmed()) {
      await context.cleanupChildTree()
      context.markTreeCleanupConfirmed()
    }
    if (child !== undefined && !context.treeCleanupConfirmed()) throw new Error('owned child tree cleanup was not confirmed')
    await cleanupSessionDescendants(sessionDir, ownedSession, deps)
    const cleaned = readOwnedSession(runtimeRoot, request.sessionId, ownedSession)
    writeState(runtimeRoot, {
      ...compactState(cleaned, true),
      state: 'stopping',
      cleanup: 'pass',
      updatedAt: nextTimestamp(deps.now(), cleaned.updatedAt),
    }, ownedSession)
    const stopping = readOwnedSession(runtimeRoot, request.sessionId, ownedSession)
    writeState(runtimeRoot, {
      ...stopping,
      state: 'stopped',
      updatedAt: nextTimestamp(deps.now(), stopping.updatedAt),
    }, ownedSession)
    clearOwnedControl(runtimeRoot, request.sessionId, ownedSession)
  } catch (error) {
    const message = `cleanup failed: ${error instanceof Error ? error.message : String(error)}`
    try {
      const failed = readOwnedSession(runtimeRoot, request.sessionId, ownedSession)
      if (failed.state !== 'crashed') {
        const { url: _url, cleanup: _cleanup, ...crashedBase } = failed
        writeState(runtimeRoot, {
          ...crashedBase,
          state: 'crashed',
          error: sanitizeDiagnostic(message),
          cleanup: 'fail',
          updatedAt: nextTimestamp(deps.now(), failed.updatedAt),
        }, ownedSession)
      } else {
        writeState(runtimeRoot, {
          ...failed,
          error: sanitizeDiagnostic(message),
          cleanup: 'fail',
          updatedAt: nextTimestamp(deps.now(), failed.updatedAt),
        }, ownedSession)
      }
    } catch {
      // Preserve the original cleanup error for the detached bin.
    }
    throw new Error(message, { cause: error })
  }
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pid must be a positive integer, got ${String(pid)}`)
}

function assertContained(root: string, candidate: string, label: string): void {
  const outside = relative(resolve(root), resolve(candidate))
  if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) throw new Error(`${label} escapes containing root`)
}

function assertNoSymlinkComponents(path: string, label: string): void {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} contains a symlink at ${current}`)
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
}

export async function runDevSupervisor(request: DevSupervisorRequestV1, deps: DevSupervisorDependencies = defaultDevSupervisorDependencies()): Promise<void> {
  validateDevSupervisorRequest(request)
  const root = resolve(request.root)
  const runtimeRoot = rootPath(root, ROOT_PATHS.runtime)
  const sessionDir = join(runtimeRoot, 'dev-sessions', request.sessionId)
  assertContained(runtimeRoot, sessionDir, 'dev session directory')
  assertNoSymlinkComponents(runtimeRoot, 'forge runtime')
  assertNoSymlinkComponents(sessionDir, 'dev session directory')
  const ownedSession = claimOwnedUiDirectory({ root: runtimeRoot, directory: sessionDir })
  ownedSession.assertCurrent()
  const current = readDevSession({ runtimeRoot, sessionId: request.sessionId })
  if (current.state === 'stopped') return

  let plan: DevSupervisorRuntimePlan | undefined
  let child: UiChildHandle | undefined
  let treeCleanupConfirmed = false
  let treeCleanupPromise: Promise<void> | undefined
  const cleanupOwnedChildTree = (): Promise<void> => {
    if (child === undefined || treeCleanupConfirmed) return Promise.resolve()
    if (treeCleanupPromise === undefined) {
      const cleanupPromise = (async () => {
        await deps.stopChildTree(child!)
        await child!.exited
        treeCleanupConfirmed = true
      })()
      void cleanupPromise.catch(() => undefined)
      treeCleanupPromise = cleanupPromise
    }
    return treeCleanupPromise
  }
  let stdoutTail = ''
  let done = false
  let outputFailure: Promise<never> | undefined
  let diagnosticLog: UiDiagnosticLog | undefined

  try {
    const preparationController = new AbortController()
    let preparationSettled = false
    let preparationError: unknown
    const preparation = deps.prepareRuntime({
      root,
      plugin: request.plugin,
      target: request.target,
      sessionId: request.sessionId,
      signal: preparationController.signal,
      ownedSession,
    }).then(value => {
      preparationSettled = true
      return value
    }, error => {
      preparationSettled = true
      preparationError = error
      return undefined
    })
    await Promise.resolve()
    while (!preparationSettled) {
      await deps.sleep(deps.pollIntervalMs)
      const control = readOwnedControl(runtimeRoot, request.sessionId, ownedSession)
      if (control === undefined) continue
      preparationController.abort()
      await preparation
      if (preparationError !== undefined && !isAbortError(preparationError)) {
        const message = `dev runtime preparation cancellation failed: ${preparationError instanceof Error ? preparationError.message : String(preparationError)}`
        markDevCrashed(runtimeRoot, request.sessionId, message, deps, ownedSession, 'fail')
        throw new Error(message, { cause: preparationError })
      }
      await handleDevStop(control, {
        deps,
        runtimeRoot,
        sessionDir,
        request,
        ownedSession,
        treeCleanupConfirmed: () => treeCleanupConfirmed,
        markTreeCleanupConfirmed: () => { treeCleanupConfirmed = true },
        cleanupChildTree: cleanupOwnedChildTree,
      })
      return
    }
    if (preparationError !== undefined) throw preparationError
    const prepared = await preparation
    if (prepared === undefined) throw new Error('runtime preparation did not return a plan')
    plan = prepared
    const settledControl = readOwnedControl(runtimeRoot, request.sessionId, ownedSession)
    if (settledControl !== undefined) {
      await handleDevStop(settledControl, {
        deps,
        runtimeRoot,
        sessionDir,
        request,
        ownedSession,
        treeCleanupConfirmed: () => treeCleanupConfirmed,
        markTreeCleanupConfirmed: () => { treeCleanupConfirmed = true },
        cleanupChildTree: cleanupOwnedChildTree,
      })
      return
    }
    ownedSession.assertCurrent()
    diagnosticLog = deps.openLog(sessionDir, deps.maxLogBytes)
    ownedSession.assertCurrent()
    child = deps.spawnChild(plan)
    assertPid(child.pid)

    const started = readOwnedSession(runtimeRoot, request.sessionId, ownedSession)
    writeState(runtimeRoot, {
      ...started,
      supervisorPid: process.pid,
      childPid: child.pid,
      updatedAt: nextTimestamp(deps.now(), started.updatedAt),
    }, ownedSession)

    const onOutput = (source: 'stdout' | 'stderr', chunk: unknown): void => {
      try {
        if (done) return
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        diagnosticLog!.write(text)
        if (source !== 'stdout') return
        stdoutTail += text
        let newline = stdoutTail.indexOf('\n')
        while (newline >= 0) {
          const line = stdoutTail.slice(0, newline).replace(/\r$/, '')
          stdoutTail = stdoutTail.slice(newline + 1)
          const url = parseDshReadyUrl(line)
          if (url !== undefined) markDevReady(runtimeRoot, request.sessionId, url, child!.pid, deps, ownedSession)
          newline = stdoutTail.indexOf('\n')
        }
      } catch (error) {
        if (outputFailure === undefined) {
          outputFailure = failDiagnosticOutput({
            runtimeRoot,
            sessionDir,
            sessionId: request.sessionId,
            child: child!,
            diagnosticLog: diagnosticLog!,
            ownedSession,
            deps,
            treeCleanupConfirmed: () => treeCleanupConfirmed,
            markTreeCleanupConfirmed: () => { treeCleanupConfirmed = true },
            cleanupChildTree: cleanupOwnedChildTree,
          }, error)
          void outputFailure.catch(() => undefined)
        }
        done = true
      }
    }
    child.stdout.on('data', (chunk: unknown) => onOutput('stdout', chunk))
    child.stderr.on('data', (chunk: unknown) => onOutput('stderr', chunk))

    const exitPromise = Promise.resolve(child.exited).then(async exit => {
      await cleanupOwnedChildTree()
      try { diagnosticLog?.close() } catch { /* preserve the crash lifecycle */ }
      done = true
      const state = readOwnedSession(runtimeRoot, request.sessionId, ownedSession)
      if (state.state === 'starting' || state.state === 'ready') {
        markDevCrashed(runtimeRoot, request.sessionId, `DSH child exited before supervisor cleanup (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'none'})`, deps, ownedSession, undefined, true)
      }
    }).catch(error => {
      done = true
      throw error
    })
    void exitPromise.catch(() => undefined)

    while (!done) {
      if (outputFailure !== undefined) await outputFailure
      await deps.sleep(deps.pollIntervalMs)
      if (outputFailure !== undefined) await outputFailure
      if (done) break
      const state = readOwnedSession(runtimeRoot, request.sessionId, ownedSession)
      if (state.state === 'stopped') { done = true; break }
      const control = readOwnedControl(runtimeRoot, request.sessionId, ownedSession)
      if (control === undefined) continue
      done = true
      await handleDevStop(control, {
        deps,
        runtimeRoot,
        sessionDir,
        request,
        ownedSession,
        child,
        diagnosticLog: diagnosticLog!,
        treeCleanupConfirmed: () => treeCleanupConfirmed,
        markTreeCleanupConfirmed: () => { treeCleanupConfirmed = true },
        cleanupChildTree: cleanupOwnedChildTree,
      })
    }
    if (outputFailure !== undefined) await outputFailure
    await exitPromise
  } catch (error) {
    done = true
    const message = error instanceof Error ? error.message : String(error)
    let recoveryMessage = message
    let cleanupError: unknown
    try { diagnosticLog?.close() } catch { /* preserve the primary lifecycle error */ }
    if (child !== undefined && !treeCleanupConfirmed) {
      try {
        await cleanupOwnedChildTree()
      } catch (failure) {
        cleanupError = failure
        recoveryMessage = `${message}; child tree cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`
      }
    }
    try {
      const state = readOwnedSession(runtimeRoot, request.sessionId, ownedSession)
      if (cleanupError !== undefined) {
        markDevCrashed(runtimeRoot, request.sessionId, recoveryMessage, deps, ownedSession, 'fail', true)
      } else if (child === undefined && state.state === 'starting') {
        writeState(runtimeRoot, {
          ...state,
          state: 'crashed',
          error: recoveryMessage,
          updatedAt: nextTimestamp(deps.now(), state.updatedAt),
        }, ownedSession)
      } else if (state.cleanup !== 'fail' && (state.state === 'starting' || state.state === 'ready' || state.state === 'crashed')) {
        markDevCrashed(runtimeRoot, request.sessionId, recoveryMessage, deps, ownedSession)
      }
    } catch {
      // The bin reports the failure when the lease cannot be safely updated.
    }
    if (cleanupError !== undefined) throw new AggregateError([error, cleanupError], recoveryMessage)
    throw error
  }
}

interface DevDiagnosticFailureContext {
  runtimeRoot: string
  sessionDir: string
  sessionId: string
  child: UiChildHandle
  diagnosticLog: UiDiagnosticLog
  ownedSession: OwnedUiDirectory
  deps: DevSupervisorDependencies
  treeCleanupConfirmed: () => boolean
  markTreeCleanupConfirmed: () => void
  cleanupChildTree: () => Promise<void>
}

async function failDiagnosticOutput(context: DevDiagnosticFailureContext, error: unknown): Promise<never> {
  const reason = sanitizeDiagnostic(`diagnostic log failure: ${error instanceof Error ? error.message : String(error)}`)
  let terminationConfirmed = context.treeCleanupConfirmed()
  let cleanupError: unknown
  try { context.diagnosticLog.close() } catch (closeError) { cleanupError = closeError }
  try {
    if (!terminationConfirmed) {
      await context.cleanupChildTree()
      terminationConfirmed = true
      context.markTreeCleanupConfirmed()
    }
  } catch (stopError) {
    cleanupError ??= stopError
  }
  try {
    const state = readOwnedSession(context.runtimeRoot, context.sessionId, context.ownedSession)
    writeState(context.runtimeRoot, {
      ...compactState(state, terminationConfirmed),
      state: 'crashed',
      error: sanitizeDiagnostic(cleanupError === undefined ? reason : `${reason}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`),
      cleanup: 'fail',
      updatedAt: nextTimestamp(context.deps.now(), state.updatedAt),
    }, context.ownedSession)
  } catch (reportError) {
    cleanupError ??= reportError
  }
  const suffix = cleanupError === undefined ? '' : `; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
  throw new Error(`${reason}${suffix}`, { cause: cleanupError ?? error })
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): void {
  const allowed = new Set(required)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unexpected request field ${key}`)
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`missing request field ${key}`)
}

export function validateDevSupervisorRequest(value: unknown): asserts value is DevSupervisorRequestV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('supervisor request must be an object')
  const request = value as Record<string, unknown>
  exactKeys(request, ['schemaVersion', 'root', 'sessionId', 'plugin', 'target', 'startedAt', 'restartBaseline'])
  if (request.schemaVersion !== 1) throw new Error('request.schemaVersion must be 1')
  if (typeof request.root !== 'string' || !request.root.trim() || !isAbsolute(request.root)) throw new Error('request.root must be an absolute path')
  if (typeof request.sessionId !== 'string' || !DEV_SESSION_ID_PATTERN.test(request.sessionId)) throw new Error('request.sessionId is invalid')
  if (request.target !== 'next' && request.target !== 'master') throw new Error('request.target is invalid')
  if (typeof request.startedAt !== 'string' || !ISO.test(request.startedAt) || Number.isNaN(Date.parse(request.startedAt))) throw new Error('request.startedAt is invalid')
  const plugin = request.plugin
  if (plugin === null || typeof plugin !== 'object' || Array.isArray(plugin)) throw new Error('request.plugin must be an object')
  exactKeys(plugin as Record<string, unknown>, ['packageName', 'sourcePath', 'runtimeName'])
  const parsedPlugin = plugin as Record<string, unknown>
  for (const key of ['packageName', 'sourcePath', 'runtimeName']) if (typeof parsedPlugin[key] !== 'string' || !(parsedPlugin[key] as string).trim()) throw new Error(`request.plugin.${key} is invalid`)
  if (!isAbsolute(parsedPlugin.sourcePath as string)) throw new Error('request.plugin.sourcePath must be absolute')
  assertRuntimePluginIdentity(parsedPlugin.runtimeName as string)
  const baseline = request.restartBaseline
  if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) throw new Error('request.restartBaseline must be an object')
  exactKeys(baseline as Record<string, unknown>, ['pluginManifest', 'pluginMetadata', 'targetPin'])
  for (const key of ['pluginManifest', 'pluginMetadata', 'targetPin'] as const) {
    const digest = (baseline as Record<string, unknown>)[key]
    if (typeof digest !== 'string' || !SHA256_PATTERN.test(digest)) throw new Error(`request.restartBaseline.${key} must be a sha256 digest`)
  }
}

function spawnDevRuntimeChild(plan: DevSupervisorRuntimePlan): UiChildHandle {
  // Boot the resolved launcher against the materialized profile with the source
  // overlay applied, pinned to the loopback interface and an ephemeral port so a
  // stray foreground DSH can never steal the user's terminal.
  const profileNameValue = basename(plan.profileDir)
  const args = [
    ...plan.launcher.args,
    '--profile', profileNameValue,
    '--patch', plan.overlayPath,
    '--host', '127.0.0.1',
    '--port', '0',
    '--no-open',
  ]
  const processChild = spawn(plan.launcher.cmd, args, {
    cwd: plan.cwd,
    env: plan.env,
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const pid = processChild.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || !processChild.stdout || !processChild.stderr) throw new Error('DSH child did not provide an owned process handle')
  let leaderExited = false
  const exited = new Promise<UiChildExit>((resolveExit, rejectExit) => {
    processChild.once('exit', () => { leaderExited = true })
    processChild.once('error', error => {
      leaderExited = true
      rejectExit(error)
    })
    processChild.once('close', (code, signal) => {
      leaderExited = true
      resolveExit({ code, signal })
    })
  })
  return { pid, stdout: processChild.stdout, stderr: processChild.stderr, exited, leaderExited: () => leaderExited }
}

export function defaultDevSupervisorDependencies(): DevSupervisorDependencies {
  const deps: DevSupervisorDependencies = {
    prepareRuntime: async opts => {
      const runtimeHome = rootPath(resolve(opts.root), ROOT_PATHS.runtime)
      const compat = loadCompatibilityFromFile(rootPath(resolve(opts.root), ROOT_PATHS.compatibility))
      const base = await prepareDevRuntime({
        root: opts.root,
        plugin: opts.plugin,
        target: opts.target,
        runtimeHome,
        profileName: profileName(opts.plugin.runtimeName, opts.target, 'dev'),
        overlayDir: join(runtimeHome, 'overlays', opts.plugin.runtimeName),
        installProfile: opts.target !== 'master',
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      })
      // pnpm is install-time only: for `next` boot the installed profile dsh bin
      // directly (no `pnpm exec` wrapper, which pnpm 11.7 rejects when the tsx
      // loader is in NODE_OPTIONS); `master` keeps the direct built-upstream bin.
      const launcher = opts.target === 'next'
        ? resolveProfileDshLauncher(base.profileDir)
        : await deps.resolveLauncher(opts.root, opts.target, compat, opts.signal)
      return { ...base, launcher }
    },
    resolveLauncher: (root, target, compat, signal) => resolveUiLauncher(root, target, compat, signal),
    spawnChild: spawnDevRuntimeChild,
    stopChildTree: child => stopOwnedChildTree(child),
    openLog: openBoundedSupervisorLog,
    now: () => new Date().toISOString(),
    sleep: ms => sleepMs(ms),
    pollIntervalMs: 100,
    maxLogBytes: 64 * 1024,
  }
  return deps
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
