import { execFile, spawn } from 'node:child_process'
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  writeSync,
  rmSync,
} from 'node:fs'
import { join, relative, resolve, sep, isAbsolute, parse } from 'node:path'
import { ROOT_PATHS, rootPath } from './context.js'
import {
  clearUiControl,
  readUiControl,
  readUiSession,
  writeUiSession,
  type UiControlV1,
  type UiSessionStateV1,
} from './ui-session.js'
import {
  buildUiRuntimeEnvironment,
  prepareUiRuntime,
  type UiRuntimePlan,
  type UiRuntimePlugin,
} from './ui-runtime.js'
import { assertRuntimePluginIdentity } from './runtime-identity.js'
import { claimOwnedUiDirectory } from './ui-owned-directory.js'

export interface UiSupervisorRequestV1 {
  schemaVersion: 1
  root: string
  sessionId: string
  plugin: UiRuntimePlugin
  target: 'next' | 'master'
  startedAt: string
}

export interface UiChildExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface UiChildHandle {
  pid: number
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  exited: Promise<UiChildExit>
}

export interface UiSupervisorDependencies {
  prepareRuntime(opts: { root: string; plugin: UiRuntimePlugin; target: 'next' | 'master'; sessionId: string; signal?: AbortSignal }): Promise<UiRuntimePlan>
  spawnChild(plan: UiRuntimePlan): UiChildHandle
  stopChildTree(handle: UiChildHandle): Promise<void>
  openLog(sessionDir: string, maxBytes: number): UiDiagnosticLog
  now(): string
  sleep(ms: number): Promise<void>
  pollIntervalMs: number
  maxLogBytes: number
}

export interface UiDiagnosticLog {
  write(text: string): void
  close(): void
}

export interface UiProcessTreeDependencies {
  platform: 'windows' | 'posix'
  taskkill(args: string[]): Promise<void>
  signalGroup(group: number, signal: 'SIGTERM' | 'SIGKILL'): void
  waitForExit(exited: Promise<UiChildExit>, timeoutMs: number): Promise<boolean>
  termGraceMs: number
  killGraceMs: number
  treeAlive?: (pid: number) => boolean
}

const SESSION_ID = /^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$/
const ISO = /^\d{4}-\d{2}-\d{2}T/

/** Parse only the complete, upstream readiness line and return its loopback URL. */
export function parseDshReadyUrl(line: string): string | undefined {
  if (typeof line !== 'string') return undefined
  const match = /^dsh web: (http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4}))(?: \(LAN: (http:\/\/[^ ]+)\))?$/.exec(line)
  if (!match) return undefined
  const port = Number(match[2])
  if (!validPort(port)) return undefined
  if (match[3] !== undefined && !validLanUrl(match[3])) return undefined
  return match[1]
}

export function windowsTreeKillArgs(pid: number): string[] {
  assertPid(pid)
  return ['/PID', String(pid), '/T', '/F']
}

export function posixProcessGroup(pid: number): number {
  assertPid(pid)
  return -pid
}

export async function runUiSupervisor(
  request: UiSupervisorRequestV1,
  deps: UiSupervisorDependencies = defaultDependencies(),
): Promise<void> {
  validateRequest(request)
  const root = resolve(request.root)
  const runtimeRoot = rootPath(root, ROOT_PATHS.runtime)
  const sessionDir = join(runtimeRoot, 'ui-sessions', request.sessionId)
  assertContained(runtimeRoot, sessionDir, 'UI session directory')
  assertNoSymlinkComponents(runtimeRoot, 'forge runtime')
  assertNoSymlinkComponents(sessionDir, 'UI session directory')
  const current = readUiSession({ runtimeRoot, sessionId: request.sessionId })
  if (current.state === 'finished' || current.state === 'aborted') return

  let plan: UiRuntimePlan | undefined
  let child: UiChildHandle | undefined
  let exitSettled = false
  let stopIssued = false
  let stdoutTail = ''
  let done = false
  let outputFailure: Promise<never> | undefined
  let diagnosticLog: UiDiagnosticLog | undefined

  try {
    writeState(runtimeRoot, {
      ...current,
      supervisorPid: process.pid,
      updatedAt: nextTimestamp(deps.now(), current.updatedAt),
    }, deps)

    const preparationController = new AbortController()
    let preparationSettled = false
    let preparationError: unknown
    const preparation = deps.prepareRuntime({
      root,
      plugin: request.plugin,
      target: request.target,
      sessionId: request.sessionId,
      signal: preparationController.signal,
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
      const control = readUiControl({ runtimeRoot, sessionId: request.sessionId })
      if (control === undefined) continue
      preparationController.abort()
      await preparation
      await handleControl(control, {
        deps,
        runtimeRoot,
        sessionDir,
        request,
        exitSettled: () => true,
        stopIssued: () => false,
        issueStop: () => undefined,
      })
      return
    }
    if (preparationError !== undefined) throw preparationError
    const prepared = await preparation
    if (prepared === undefined) throw new Error('runtime preparation did not return a plan')
    plan = prepared
    validatePlan(plan, sessionDir)
    diagnosticLog = deps.openLog(sessionDir, deps.maxLogBytes)
    child = deps.spawnChild(plan)
    assertPid(child.pid)

    const started = readUiSession({ runtimeRoot, sessionId: request.sessionId })
    writeState(runtimeRoot, {
      ...started,
      supervisorPid: process.pid,
      childPid: child.pid,
      updatedAt: nextTimestamp(deps.now(), started.updatedAt),
    }, deps)

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
          if (url !== undefined) markReady(runtimeRoot, request.sessionId, url, child!.pid, deps)
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
            deps,
            stopIssued: () => stopIssued,
            issueStop: () => { stopIssued = true },
            exitSettled: () => exitSettled,
          }, error)
          void outputFailure.catch(() => undefined)
        }
        done = true
      }
    }
    child.stdout.on('data', (chunk: unknown) => onOutput('stdout', chunk))
    child.stderr.on('data', (chunk: unknown) => onOutput('stderr', chunk))

    const exitPromise = Promise.resolve(child.exited).then(exit => {
      exitSettled = true
      if (done) return
      const state = readUiSession({ runtimeRoot, sessionId: request.sessionId })
      if (state.state === 'starting' || state.state === 'ready') {
        markCrashed(runtimeRoot, request.sessionId, `DSH child exited before supervisor cleanup (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'none'})`, deps)
      }
    }).catch(error => {
      exitSettled = true
      if (done) return
      const state = readUiSession({ runtimeRoot, sessionId: request.sessionId })
      if (state.state === 'starting' || state.state === 'ready') markCrashed(runtimeRoot, request.sessionId, `DSH child exit could not be observed: ${error instanceof Error ? error.message : String(error)}`, deps)
    })

    while (!done) {
      if (outputFailure !== undefined) await outputFailure
      await deps.sleep(deps.pollIntervalMs)
      if (outputFailure !== undefined) await outputFailure
      if (done) break
      const state = readUiSession({ runtimeRoot, sessionId: request.sessionId })
      if (state.state === 'finished' || state.state === 'aborted') { done = true; break }
      const control = readUiControl({ runtimeRoot, sessionId: request.sessionId })
      if (control === undefined) continue
      done = true
      await handleControl(control, {
        deps,
        runtimeRoot,
        sessionDir,
        request,
        child,
        diagnosticLog: diagnosticLog!,
        exitSettled: () => exitSettled,
        stopIssued: () => stopIssued,
        issueStop: () => { stopIssued = true },
      })
    }
    if (outputFailure !== undefined) await outputFailure
    await exitPromise
  } catch (error) {
    done = true
    const message = error instanceof Error ? error.message : String(error)
    try { diagnosticLog?.close() } catch { /* preserve the primary lifecycle error */ }
    if (child !== undefined && !exitSettled && !stopIssued) {
      stopIssued = true
      try {
        await deps.stopChildTree(child)
        await child.exited
        exitSettled = true
      } catch {
        // Preserve the original setup/publication failure as the primary error.
      }
    }
    try {
      const state = readUiSession({ runtimeRoot, sessionId: request.sessionId })
      if (child === undefined && state.state === 'starting') {
        writeState(runtimeRoot, {
          ...state,
          state: 'crashed',
          supervisorPid: process.pid,
          error: message,
          updatedAt: nextTimestamp(deps.now(), state.updatedAt),
        }, deps)
        await waitForRecoveryControl({ runtimeRoot, sessionDir, request, deps })
        return
      }
      if (state.cleanup !== 'fail' && (state.state === 'starting' || state.state === 'ready' || state.state === 'crashed')) {
        markCrashed(runtimeRoot, request.sessionId, message, deps)
      }
    } catch {
      // The bin reports the failure when the lease cannot be safely updated.
    }
    throw error
  }
}

interface ControlContext {
  deps: UiSupervisorDependencies
  runtimeRoot: string
  sessionDir: string
  request: UiSupervisorRequestV1
  child?: UiChildHandle
  diagnosticLog?: UiDiagnosticLog
  exitSettled: () => boolean
  stopIssued: () => boolean
  issueStop: () => void
}

interface DiagnosticFailureContext {
  runtimeRoot: string
  sessionDir: string
  sessionId: string
  child: UiChildHandle
  diagnosticLog: UiDiagnosticLog
  deps: UiSupervisorDependencies
  stopIssued: () => boolean
  issueStop: () => void
  exitSettled: () => boolean
}

async function failDiagnosticOutput(context: DiagnosticFailureContext, error: unknown): Promise<never> {
  const reason = sanitizeDiagnostic(`diagnostic log failure: ${error instanceof Error ? error.message : String(error)}`)
  let terminationConfirmed = context.exitSettled()
  let cleanupError: unknown
  try {
    if (!terminationConfirmed && !context.stopIssued()) {
      context.issueStop()
      await context.deps.stopChildTree(context.child)
      await context.child.exited
      terminationConfirmed = true
    }
  } catch (stopError) {
    cleanupError = stopError
  }
  try { context.diagnosticLog.close() } catch (closeError) { cleanupError ??= closeError }
  try {
    const state = readUiSession({ runtimeRoot: context.runtimeRoot, sessionId: context.sessionId })
    writeState(context.runtimeRoot, {
      ...compactState(state, terminationConfirmed),
      state: 'crashed',
      error: sanitizeDiagnostic(cleanupError === undefined ? reason : `${reason}; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`),
      cleanup: 'fail',
      updatedAt: nextTimestamp(context.deps.now(), state.updatedAt),
    }, context.deps)
  } catch (reportError) {
    cleanupError ??= reportError
  }
  const suffix = cleanupError === undefined ? '' : `; cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
  throw new Error(`${reason}${suffix}`, { cause: cleanupError ?? error })
}

function compactState(state: UiSessionStateV1, removePids: boolean): UiSessionStateV1 {
  const compact = { ...state }
  delete compact.url
  delete compact.cleanup
  if (removePids) {
    delete compact.supervisorPid
    delete compact.childPid
  }
  return compact
}

async function handleControl(control: UiControlV1, context: ControlContext): Promise<void> {
  const { deps, runtimeRoot, sessionDir, request, child, diagnosticLog } = context
  try {
    const current = readUiSession({ runtimeRoot, sessionId: request.sessionId })
    const stoppingBase = compactForStopping(current, child?.pid ?? current.childPid, process.pid)
    writeState(runtimeRoot, {
      ...stoppingBase,
      state: 'stopping',
      updatedAt: nextTimestamp(deps.now(), current.updatedAt),
    }, deps)
    if (child !== undefined && !context.stopIssued()) {
      context.issueStop()
      await deps.stopChildTree(child)
      await child.exited
    }
    diagnosticLog?.close()
    cleanupSessionDescendants(sessionDir)
    const cleaned = readUiSession({ runtimeRoot, sessionId: request.sessionId })
    const compact = compactState(cleaned, true)
    writeState(runtimeRoot, {
      ...compact,
      state: 'stopping',
      cleanup: 'pass',
      updatedAt: nextTimestamp(deps.now(), cleaned.updatedAt),
    }, deps)
    if (control.action === 'abort') {
      const stopping = readUiSession({ runtimeRoot, sessionId: request.sessionId })
      writeState(runtimeRoot, {
        ...stopping,
        state: 'aborted',
        cleanup: 'pass',
        updatedAt: nextTimestamp(deps.now(), stopping.updatedAt),
      }, deps)
    }
    clearUiControl({ runtimeRoot, sessionId: request.sessionId })
  } catch (error) {
    const message = `cleanup failed: ${error instanceof Error ? error.message : String(error)}`
    try {
      const failed = readUiSession({ runtimeRoot, sessionId: request.sessionId })
      if (failed.state !== 'crashed') {
        const { url: _url, cleanup: _cleanup, ...crashedBase } = failed
        writeState(runtimeRoot, {
          ...crashedBase,
          state: 'crashed',
          error: sanitizeDiagnostic(message),
          cleanup: 'fail',
          updatedAt: nextTimestamp(deps.now(), failed.updatedAt),
        }, deps)
      } else {
        writeState(runtimeRoot, {
          ...failed,
          error: sanitizeDiagnostic(message),
          cleanup: 'fail',
          updatedAt: nextTimestamp(deps.now(), failed.updatedAt),
        }, deps)
      }
    } catch {
      // Preserve the original cleanup error for the detached bin.
    }
    throw new Error(message, { cause: error })
  }
}

function compactForStopping(state: UiSessionStateV1, childPid: number | undefined, supervisorPid: number): UiSessionStateV1 {
  const compact = { ...state }
  delete compact.url
  delete compact.error
  delete compact.cleanup
  compact.supervisorPid = supervisorPid
  if (childPid !== undefined) compact.childPid = childPid
  return compact
}

async function waitForRecoveryControl(opts: {
  runtimeRoot: string
  sessionDir: string
  request: UiSupervisorRequestV1
  deps: UiSupervisorDependencies
}): Promise<void> {
  while (true) {
    const control = readUiControl({ runtimeRoot: opts.runtimeRoot, sessionId: opts.request.sessionId })
    if (control !== undefined) {
      await handleControl(control, {
        deps: opts.deps,
        runtimeRoot: opts.runtimeRoot,
        sessionDir: opts.sessionDir,
        request: opts.request,
        exitSettled: () => true,
        stopIssued: () => false,
        issueStop: () => undefined,
      })
      return
    }
    await opts.deps.sleep(opts.deps.pollIntervalMs)
  }
}

function markReady(runtimeRoot: string, sessionId: string, url: string, childPid: number, deps: UiSupervisorDependencies): void {
  const state = readUiSession({ runtimeRoot, sessionId })
  if (state.state !== 'starting') return
  writeState(runtimeRoot, {
    ...state,
    state: 'ready',
    supervisorPid: process.pid,
    childPid,
    url,
    updatedAt: nextTimestamp(deps.now(), state.updatedAt),
  }, deps)
}

function markCrashed(runtimeRoot: string, sessionId: string, error: string, deps: UiSupervisorDependencies, cleanup?: 'fail'): void {
  const state = readUiSession({ runtimeRoot, sessionId })
  if (state.state !== 'starting' && state.state !== 'ready' && state.state !== 'crashed') return
  const crashedBase = compactState(state, cleanup === undefined)
  writeState(runtimeRoot, {
    ...crashedBase,
    state: 'crashed',
    error: sanitizeDiagnostic(error),
    ...(cleanup === undefined ? {} : { cleanup }),
    updatedAt: nextTimestamp(deps.now(), state.updatedAt),
  }, deps)
}

function writeState(runtimeRoot: string, state: UiSessionStateV1, deps: UiSupervisorDependencies): void {
  const updatedAt = nextTimestamp(state.updatedAt, state.updatedAt)
  if (state.error === undefined) {
    const { error: _error, ...withoutError } = state
    writeUiSession({ runtimeRoot, state: { ...withoutError, updatedAt } })
  } else {
    writeUiSession({ runtimeRoot, state: { ...state, error: sanitizeDiagnostic(state.error), updatedAt } })
  }
}

function nextTimestamp(candidate: string, previous: string): string {
  if (!ISO.test(candidate) || Number.isNaN(Date.parse(candidate))) return previous
  return Date.parse(candidate) < Date.parse(previous) ? previous : candidate
}

function cleanupSessionDescendants(sessionDir: string): void {
  const home = join(sessionDir, 'home')
  const overlay = join(sessionDir, 'overlay')
  const log = join(sessionDir, 'supervisor.log')
  const owned = claimOwnedUiDirectory({ root: resolve(sessionDir, '..', '..'), directory: sessionDir })
  if (existsSync(home)) owned.removeDirectoryLeaf('home')
  if (existsSync(overlay)) owned.removeDirectoryLeaf('overlay')
  removeContained(log, sessionDir, false)
}

function removeContained(path: string, root: string, recursive: boolean): void {
  assertContained(root, path, 'runtime descendant')
  assertNoSymlinkComponents(root, 'runtime root')
  assertNoSymlinkComponents(path, 'runtime descendant')
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`refusing to remove symlink at ${path}`)
  if (recursive && !stat.isDirectory()) throw new Error(`expected directory at ${path}`)
  if (!recursive && !stat.isFile()) throw new Error(`expected regular file at ${path}`)
  rmSync(path, { recursive, force: false })
}

export function openBoundedSupervisorLog(sessionDir: string, maxBytes: number): UiDiagnosticLog {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('maxLogBytes must be a positive integer')
  assertNoSymlinkComponents(sessionDir, 'UI session directory')
  const path = join(sessionDir, 'supervisor.log')
  assertContained(sessionDir, path, 'supervisor log')
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600)
  try {
    const pinned = fstatSync(descriptor)
    if (!pinned.isFile() || pinned.nlink !== 1) throw new Error(`supervisor log is not a unique regular file at ${path}`)
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
  let bytes = Buffer.alloc(0)
  let closed = false
  return {
    write(text: string): void {
      if (closed) throw new Error('supervisor diagnostic log is closed')
      const pinned = fstatSync(descriptor)
      if (!pinned.isFile() || pinned.nlink !== 1) throw new Error(`supervisor log is no longer a unique regular file at ${path}`)
      const next = Buffer.concat([bytes, Buffer.from(text)]).subarray(-maxBytes)
      ftruncateSync(descriptor, 0)
      let written = 0
      while (written < next.length) {
        const progress = writeSync(descriptor, next, written, next.length - written, written)
        if (progress <= 0) throw new Error('supervisor diagnostic log write made no progress')
        written += progress
      }
      bytes = Buffer.from(next)
    },
    close(): void {
      if (closed) return
      closed = true
      closeSync(descriptor)
    },
  }
}

function noFollowFlag(): number { return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0 }

function validatePlan(plan: UiRuntimePlan, sessionDir: string): void {
  if (!plan || typeof plan !== 'object') throw new Error('runtime preparation returned an invalid plan')
  if (resolve(plan.sessionDir) !== resolve(sessionDir)) throw new Error('runtime plan session directory does not match request')
  for (const [key, value] of Object.entries({ runtimeHome: plan.runtimeHome, profileDir: plan.profileDir, overlayPath: plan.overlayPath, cwd: plan.cwd })) {
    if (typeof value !== 'string' || !value) throw new Error(`runtime plan ${key} is invalid`)
    assertContained(sessionDir, value, `runtime plan ${key}`)
  }
  if (!plan.launcher || typeof plan.launcher.cmd !== 'string' || !plan.launcher.cmd || !Array.isArray(plan.launcher.args)) throw new Error('runtime plan launcher is invalid')
  if (!Array.isArray(plan.argv) || plan.argv.some(arg => typeof arg !== 'string')) throw new Error('runtime plan argv is invalid')
}

function defaultDependencies(): UiSupervisorDependencies {
  return {
    prepareRuntime: opts => prepareUiRuntime(opts),
    spawnChild: spawnRuntimeChild,
    stopChildTree: child => stopOwnedChildTree(child),
    openLog: openBoundedSupervisorLog,
    now: () => new Date().toISOString(),
    sleep: ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)),
    pollIntervalMs: 100,
    maxLogBytes: 64 * 1024,
  }
}

function spawnRuntimeChild(plan: UiRuntimePlan): UiChildHandle {
  const processChild = spawn(plan.launcher.cmd, plan.argv, {
    cwd: plan.cwd,
    env: buildUiRuntimeEnvironment(plan),
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const pid = processChild.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || !processChild.stdout || !processChild.stderr) throw new Error('DSH child did not provide an owned process handle')
  const exited = new Promise<UiChildExit>((resolveExit, rejectExit) => {
    processChild.once('error', rejectExit)
    processChild.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  return { pid, stdout: processChild.stdout, stderr: processChild.stderr, exited }
}

export async function stopOwnedChildTree(
  child: UiChildHandle,
  deps: UiProcessTreeDependencies = defaultProcessTreeDependencies(),
): Promise<void> {
  assertPid(child.pid)
  const treeAlive = deps.treeAlive
  if (deps.platform === 'windows') {
    await deps.taskkill(windowsTreeKillArgs(child.pid))
    if (!await deps.waitForExit(child.exited, deps.termGraceMs) || treeAlive?.(child.pid)) throw new Error('owned Windows child tree did not close after taskkill')
    return
  }
  const group = posixProcessGroup(child.pid)
  deps.signalGroup(group, 'SIGTERM')
  if (await deps.waitForExit(child.exited, deps.termGraceMs) && (treeAlive === undefined || !treeAlive(group))) return
  deps.signalGroup(group, 'SIGKILL')
  if (!await deps.waitForExit(child.exited, deps.killGraceMs) || treeAlive?.(group)) throw new Error('owned POSIX process group did not close after SIGKILL')
}

function defaultProcessTreeDependencies(): UiProcessTreeDependencies {
  const platform = process.platform === 'win32' ? 'windows' : 'posix'
  return {
    platform,
    taskkill: args => new Promise<void>((resolvePromise, reject) => {
      execFile('taskkill.exe', args, { windowsHide: true }, error => error ? reject(error) : resolvePromise())
    }),
    signalGroup: (group, signal) => {
      try { process.kill(group, signal) } catch (error) {
        if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH')) throw error
      }
    },
    waitForExit: waitForExitWithin,
    treeAlive: pidOrGroup => {
      try { process.kill(pidOrGroup, 0); return true } catch { return false }
    },
    termGraceMs: 5_000,
    killGraceMs: 5_000,
  }
}

async function waitForExitWithin(exited: Promise<UiChildExit>, timeoutMs: number): Promise<boolean> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) throw new Error('process-tree timeout must be a non-negative integer')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>(resolveTimeout => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs)
  })
  try {
    return await Promise.race([exited.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function validateUiSupervisorRequest(value: unknown): asserts value is UiSupervisorRequestV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('supervisor request must be an object')
  const request = value as Record<string, unknown>
  exactKeys(request, ['schemaVersion', 'root', 'sessionId', 'plugin', 'target', 'startedAt'])
  if (request.schemaVersion !== 1) throw new Error('request.schemaVersion must be 1')
  if (typeof request.root !== 'string' || !request.root.trim() || !isAbsolute(request.root)) throw new Error('request.root must be an absolute path')
  if (typeof request.sessionId !== 'string' || !SESSION_ID.test(request.sessionId)) throw new Error('request.sessionId is invalid')
  if (request.target !== 'next' && request.target !== 'master') throw new Error('request.target is invalid')
  if (typeof request.startedAt !== 'string' || !ISO.test(request.startedAt) || Number.isNaN(Date.parse(request.startedAt))) throw new Error('request.startedAt is invalid')
  const plugin = request.plugin
  if (plugin === null || typeof plugin !== 'object' || Array.isArray(plugin)) throw new Error('request.plugin must be an object')
  exactKeys(plugin as Record<string, unknown>, ['packageName', 'sourcePath', 'runtimeName'])
  const parsedPlugin = plugin as Record<string, unknown>
  for (const key of ['packageName', 'sourcePath', 'runtimeName']) if (typeof parsedPlugin[key] !== 'string' || !(parsedPlugin[key] as string).trim()) throw new Error(`request.plugin.${key} is invalid`)
  if (!isAbsolute(parsedPlugin.sourcePath as string)) throw new Error('request.plugin.sourcePath must be absolute')
  assertRuntimePluginIdentity(parsedPlugin.runtimeName as string)
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): void {
  const allowed = new Set(required)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unexpected request field ${key}`)
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`missing request field ${key}`)
}

function validLanUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const port = Number(url.port)
    return url.protocol === 'http:' && url.hostname.length > 0 && url.port !== '' && validPort(port) && !url.username && !url.password && (url.pathname === '/' || url.pathname === '') && url.search === '' && url.hash === ''
  } catch { return false }
}
function validPort(port: number): boolean { return Number.isInteger(port) && port >= 1 && port <= 65535 }
function assertPid(pid: number): void { if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pid must be a positive integer, got ${String(pid)}`) }
function sanitizeDiagnostic(value: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return (text || 'UI supervisor failure').slice(0, 240)
}
function validateRequest(value: unknown): asserts value is UiSupervisorRequestV1 { validateUiSupervisorRequest(value) }
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
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} contains a symlink at ${current}`) } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
}
