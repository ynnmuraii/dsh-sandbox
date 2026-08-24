import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  linkSync,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { UiTargetIdentity } from './ui-evidence.js'
import { claimOwnedUiDirectory, type OwnedUiDirectory } from './ui-owned-directory.js'

export type UiSessionPhase = 'starting' | 'ready' | 'crashed' | 'stopping' | 'finished' | 'aborted'
export type UiStaleReason = 'plugin-changed' | 'context-changed' | 'target-changed'

export interface UiSessionStateV1 {
  schemaVersion: 1
  sessionId: string
  state: UiSessionPhase
  plugin: { packageName: string; sourcePath: string; digest: `sha256:${string}` }
  target: UiTargetIdentity
  contextDigest: `sha256:${string}`
  staleReasons?: UiStaleReason[]
  supervisorPid?: number
  childPid?: number
  url?: string
  error?: string
  cleanup?: 'pass' | 'fail'
  startedAt: string
  updatedAt: string
}

export type UiControlV1 =
  | { schemaVersion: 1; action: 'finish'; requestedAt: string }
  | { schemaVersion: 1; action: 'abort'; requestedAt: string }

const SESSION_ID_PATTERN = /^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$/
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const COMMIT_PATTERN = /^[a-f0-9]{40}$/
const STALE_REASONS: readonly UiStaleReason[] = ['context-changed', 'plugin-changed', 'target-changed']
const PHASES: readonly UiSessionPhase[] = ['starting', 'ready', 'crashed', 'stopping', 'finished', 'aborted']
const PATH_COMPONENTS = new Set(['.', '..'])

export function createUiSessionId(now = new Date(), randomHex = () => randomBytesHex()): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('now must be a valid Date')
  const suffix = randomHex()
  if (!/^[a-f0-9]{8}$/.test(suffix)) throw new Error('randomHex must return eight lowercase hexadecimal characters')
  const iso = now.toISOString()
  // Date#toISOString is always 24 characters. Keep the format explicit so a
  // future change cannot accidentally make IDs path-ambiguous.
  const date = iso.slice(0, 10).replace(/-/g, '')
  const time = iso.slice(11, 23).replace(/[:.]/g, '')
  const id = `ui-${date}T${time}Z-${suffix}`
  assertSessionId(id)
  return id
}

export function createUiSession(opts: { runtimeRoot: string; state: UiSessionStateV1 }): string {
  return createOwnedUiSession(opts).sessionDir
}

export function createOwnedUiSession(opts: { runtimeRoot: string; state: UiSessionStateV1; afterOwnerCapture?: (sessionDir: string) => void }): { sessionDir: string; ownedSession: OwnedUiDirectory } {
  validateState(opts.state)
  assertSessionId(opts.state.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.state.sessionId)
  assertSafePath(paths.runtimeRoot, paths.sessionDir, 'UI session directory')
  mkdirChecked(paths.runtimeRoot, 'runtime root')
  mkdirChecked(paths.sessionsRoot, 'UI sessions directory')
  try {
    mkdirSync(paths.sessionDir)
  } catch (error) {
    if (isExistsError(error)) {
      assertDirectoryEntry(paths.sessionDir, 'UI session directory')
      throw new Error(`UI session ${opts.state.sessionId} already exists at ${paths.sessionDir}`)
    }
    throw error
  }
  assertDirectoryEntry(paths.sessionDir, 'UI session directory')
  const ownedSession = claimOwnedUiDirectory({ root: paths.runtimeRoot, directory: paths.sessionDir })
  ownedSession.assertCurrent()
  opts.afterOwnerCapture?.(paths.sessionDir)
  ownedSession.assertCurrent()
  writeAtomic(paths.statePath, JSON.stringify(opts.state, null, 2) + '\n', false, directoryIdentity(paths.sessionDir), ownedSession)
  ownedSession.assertCurrent()
  return { sessionDir: paths.sessionDir, ownedSession }
}

export function writeUiSessionRequest(opts: { runtimeRoot: string; sessionId: string; request: unknown; beforeRequestOpen?: (requestPath: string) => void; ownedSession?: OwnedUiDirectory }): string {
  assertSessionId(opts.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.sessionId)
  opts.ownedSession?.assertCurrent()
  assertSafePath(paths.runtimeRoot, paths.sessionDir, 'UI session directory')
  assertDirectoryEntry(paths.sessionDir, `UI session ${opts.sessionId}`)
  const requestPath = join(paths.sessionDir, 'request.json')
  const sessionIdentity = directoryIdentity(paths.sessionDir)
  const serialized = JSON.stringify(opts.request, null, 2)
  if (serialized === undefined) throw new Error('UI session request must be JSON-serializable')
  opts.beforeRequestOpen?.(requestPath)
  opts.ownedSession?.assertCurrent()
  assertDirectoryIdentity(paths.sessionDir, sessionIdentity)
  writeExclusiveRegular(requestPath, serialized + '\n')
  opts.ownedSession?.assertCurrent()
  assertDirectoryIdentity(paths.sessionDir, sessionIdentity)
  return requestPath
}

export function readUiSession(opts: { runtimeRoot: string; sessionId: string }): UiSessionStateV1 {
  assertSessionId(opts.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.sessionId)
  assertSafePath(paths.runtimeRoot, paths.sessionDir, 'UI session directory')
  assertDirectoryEntry(paths.sessionDir, `UI session ${opts.sessionId}`)
  const parsed = readJsonRegular(paths.statePath, 'UI session state')
  try {
    validateState(parsed)
  } catch (error) {
    throw corruption(paths.statePath, error)
  }
  if (parsed.sessionId !== opts.sessionId) throw corruption(paths.statePath, 'sessionId does not match its directory')
  return parsed
}

export function writeUiSession(opts: {
  runtimeRoot: string
  state: UiSessionStateV1
  ownedSession?: OwnedUiDirectory
  beforeStateReplace?: (statePath: string) => void
  beforeStateTemporaryWrite?: (temporaryPath: string) => void
  beforeStateRename?: (statePath: string) => void
  afterStateLockCreate?: (lockPath: string) => void
  beforeStateLockRemove?: (lockPath: string) => void
  afterStateLockRemove?: (lockPath: string) => void
}): void {
  assertSessionId(opts.state.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.state.sessionId)
  opts.ownedSession?.assertCurrent()
  assertSafePath(paths.runtimeRoot, paths.sessionDir, 'UI session directory')
  assertDirectoryEntry(paths.sessionDir, `UI session ${opts.state.sessionId}`)
  const sessionIdentity = directoryIdentity(paths.sessionDir)
  let current = readUiSession({ runtimeRoot: opts.runtimeRoot, sessionId: opts.state.sessionId })
  validateStateCandidate(current, opts.state, opts.state.sessionId)
  opts.beforeStateReplace?.(paths.statePath)
  opts.ownedSession?.assertCurrent()
  assertDirectoryIdentity(paths.sessionDir, sessionIdentity)
  const lockPath = join(paths.sessionDir, '.state.lock')
  const lockIdentity = acquireSessionMutationLock(paths.sessionDir, sessionIdentity, lockPath, opts.afterStateLockCreate, opts.ownedSession)
  try {
    assertDirectoryIdentity(paths.sessionDir, sessionIdentity)
    current = readUiSession({ runtimeRoot: opts.runtimeRoot, sessionId: opts.state.sessionId })
    const state = validateStateCandidate(current, opts.state, opts.state.sessionId)
    if (state === undefined) return
    assertDirectoryIdentity(paths.sessionDir, sessionIdentity)
    writeAtomic(paths.statePath, JSON.stringify(state, null, 2) + '\n', true, sessionIdentity, opts.ownedSession, opts.beforeStateTemporaryWrite, opts.beforeStateRename)
    assertDirectoryIdentity(paths.sessionDir, sessionIdentity)
  } finally {
    releaseSessionMutationLock(paths.sessionDir, sessionIdentity, lockPath, lockIdentity, opts.beforeStateLockRemove, opts.afterStateLockRemove, opts.ownedSession)
  }
}

export function writeUiControl(opts: {
  runtimeRoot: string
  sessionId: string
  control: UiControlV1
  beforeControlLink?: (controlPath: string) => void
  ownedSession?: OwnedUiDirectory
  removeTemporaryControl?: (temporaryPath: string) => void
}): void {
  validateControl(opts.control)
  assertSessionId(opts.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.sessionId)
  opts.ownedSession?.assertCurrent()
  assertSafePath(paths.runtimeRoot, paths.sessionDir, 'UI session directory')
  assertDirectoryEntry(paths.sessionDir, `UI session ${opts.sessionId}`)
  const sessionIdentity = directoryIdentity(paths.sessionDir)
  const existing = existingEntry(paths.controlPath)
  if (existing !== undefined) {
    // Validate an existing pending file before reporting the replacement
    // conflict, so corrupt or redirected files are never silently treated as
    // a valid control request.
    readUiControl(opts)
    throw new Error(`UI session ${opts.sessionId} already has a pending control at ${paths.controlPath}`)
  }
  const temporaryPath = `${paths.controlPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  opts.ownedSession?.assertCurrent()
  writeExclusiveRegular(temporaryPath, JSON.stringify(opts.control, null, 2) + '\n')
  opts.ownedSession?.assertCurrent()
  try {
    assertSafePath(paths.runtimeRoot, paths.sessionDir, 'UI session directory')
    assertDirectoryEntry(paths.sessionDir, `UI session ${opts.sessionId}`)
    opts.beforeControlLink?.(paths.controlPath)
    opts.ownedSession?.assertCurrent()
    assertDirectoryIdentity(paths.sessionDir, sessionIdentity)
    try {
      linkSync(temporaryPath, paths.controlPath)
    } catch (error) {
      if (isExistsError(error)) throw new Error(`pending UI control already exists at ${paths.controlPath}`)
      throw error
    }
    opts.ownedSession?.assertCurrent()
  } finally {
    try {
      opts.ownedSession?.assertCurrent()
      if (opts.removeTemporaryControl) opts.removeTemporaryControl(temporaryPath)
      else unlinkSync(temporaryPath)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
  }
}

export function readUiControl(opts: { runtimeRoot: string; sessionId: string }): UiControlV1 | undefined {
  assertSessionId(opts.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.sessionId)
  assertSafePath(paths.runtimeRoot, paths.sessionDir, 'UI session directory')
  assertDirectoryEntry(paths.sessionDir, `UI session ${opts.sessionId}`)
  if (existingEntry(paths.controlPath) === undefined) return undefined
  const parsed = readJsonRegular(paths.controlPath, 'UI control')
  try { validateControl(parsed) } catch (error) { throw corruption(paths.controlPath, error) }
  return parsed
}

export function clearUiControl(opts: {
  runtimeRoot: string
  sessionId: string
  beforeControlUnlink?: (controlPath: string) => void
  ownedSession?: OwnedUiDirectory
}): void {
  assertSessionId(opts.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.sessionId)
  opts.ownedSession?.assertCurrent()
  assertSafePath(paths.runtimeRoot, paths.sessionDir, 'UI session directory')
  assertDirectoryEntry(paths.sessionDir, `UI session ${opts.sessionId}`)
  const sessionIdentity = directoryIdentity(paths.sessionDir)
  const entry = existingEntry(paths.controlPath)
  if (entry === undefined) return
  // Parse and validate before unlinking so corrupt controls remain available
  // for diagnosis instead of being silently discarded.
  readUiControl(opts)
  opts.beforeControlUnlink?.(paths.controlPath)
  opts.ownedSession?.assertCurrent()
  assertDirectoryIdentity(paths.sessionDir, sessionIdentity)
  unlinkSync(paths.controlPath)
  opts.ownedSession?.assertCurrent()
}

export function latchUiStaleReasons(
  state: UiSessionStateV1,
  reasons: UiStaleReason[],
  now: string,
): UiSessionStateV1 {
  validateState(state)
  if (isTerminal(state.state)) throw new Error(`terminal UI session ${state.sessionId} is immutable`)
  validateTimestamp(now, 'now')
  if (Date.parse(now) < Date.parse(state.updatedAt)) throw new Error('updatedAt must not move backward')
  if (!Array.isArray(reasons)) throw new Error('stale reasons must be an array')
  for (const reason of reasons) if (!STALE_REASONS.includes(reason)) throw new Error(`invalid stale reason ${String(reason)}`)
  const combined = new Set<UiStaleReason>([...(state.staleReasons ?? []), ...reasons])
  return { ...state, staleReasons: [...combined].sort(compareReasons), updatedAt: now }
}

function validateState(value: unknown): asserts value is UiSessionStateV1 {
  const state = asRecord(value, 'state')
  exactKeys(state, [
    'schemaVersion', 'sessionId', 'state', 'plugin', 'target', 'contextDigest', 'startedAt', 'updatedAt',
  ], ['staleReasons', 'supervisorPid', 'childPid', 'url', 'error', 'cleanup'])
  if (state.schemaVersion !== 1) throw new Error('state.schemaVersion must be 1')
  assertSessionId(assertString(state.sessionId, 'state.sessionId'))
  const phase = assertString(state.state, 'state.state') as UiSessionPhase
  if (!PHASES.includes(phase)) throw new Error('state.state has an invalid value')
  validatePlugin(state.plugin)
  validateTarget(state.target)
  if (!SHA256_PATTERN.test(assertString(state.contextDigest, 'state.contextDigest'))) throw new Error('state.contextDigest must be a sha256 digest')
  if (state.staleReasons !== undefined) {
    if (!Array.isArray(state.staleReasons)) throw new Error('state.staleReasons must be an array')
    const seen = new Set<string>()
    for (const reason of state.staleReasons) {
      if (!STALE_REASONS.includes(reason as UiStaleReason) || seen.has(reason as string)) throw new Error('state.staleReasons must be unique valid reasons')
      seen.add(reason as string)
    }
    const sorted = [...state.staleReasons].sort(compareReasons)
    if (sorted.some((reason, index) => reason !== state.staleReasons![index])) throw new Error('state.staleReasons must be sorted')
  }
  for (const field of ['supervisorPid', 'childPid'] as const) {
    if (state[field] !== undefined && (!Number.isInteger(state[field]) || state[field]! <= 0)) throw new Error(`${field} must be a positive integer PID`)
  }
  if (state.url !== undefined) validateLoopbackUrl(state.url)
  if (state.error !== undefined) assertNonEmptyString(state.error, 'state.error')
  if (state.cleanup !== undefined && state.cleanup !== 'pass' && state.cleanup !== 'fail') throw new Error('state.cleanup has an invalid value')
  validateTimestamp(state.startedAt, 'state.startedAt')
  validateTimestamp(state.updatedAt, 'state.updatedAt')
  if (Date.parse(state.updatedAt) < Date.parse(state.startedAt)) throw new Error('updatedAt must not be before startedAt')

  if (phase === 'ready') {
    if (state.supervisorPid === undefined || state.childPid === undefined || state.url === undefined) throw new Error('ready state requires supervisorPid, childPid, and url')
    if (state.error !== undefined || state.cleanup !== undefined) throw new Error('ready state cannot contain error or cleanup')
  } else if (phase === 'crashed') {
    if (state.error === undefined) throw new Error('crashed state requires error')
    if (state.url !== undefined || (state.cleanup !== undefined && state.cleanup !== 'fail')) throw new Error('crashed state cannot contain url or cleanup: pass')
  } else if (phase === 'starting') {
    if (state.url !== undefined || state.error !== undefined || state.cleanup !== undefined) throw new Error('starting state cannot contain url, error, or cleanup')
  } else if (phase === 'stopping') {
    if (state.cleanup === undefined && state.supervisorPid === undefined && state.childPid === undefined) throw new Error('owned stopping state requires a supervisor or child PID')
    if (state.cleanup === 'pass' && (state.supervisorPid !== undefined || state.childPid !== undefined || state.url !== undefined || state.error !== undefined)) throw new Error('compact stopping state must not contain live process fields')
  } else {
    if (state.cleanup !== 'pass') throw new Error(`${phase} state requires cleanup: pass`)
    if (state.url !== undefined || state.supervisorPid !== undefined || state.childPid !== undefined || state.error !== undefined) throw new Error(`${phase} state must be compact`)
  }
}

function validatePlugin(value: unknown): void {
  const plugin = asRecord(value, 'state.plugin')
  exactKeys(plugin, ['packageName', 'sourcePath', 'digest'])
  assertNonEmptyString(plugin.packageName, 'plugin.packageName')
  assertNonEmptyString(plugin.sourcePath, 'plugin.sourcePath')
  if (!SHA256_PATTERN.test(assertString(plugin.digest, 'plugin.digest'))) throw new Error('plugin.digest must be a sha256 digest')
}

function validateTarget(value: unknown): asserts value is UiTargetIdentity {
  const target = asRecord(value, 'state.target')
  const name = assertString(target.name, 'target.name')
  if (name === 'next') {
    exactKeys(target, ['name', 'dsh'])
    assertNonEmptyString(target.dsh, 'target.dsh')
  } else if (name === 'master') {
    exactKeys(target, ['name', 'commit'])
    if (!COMMIT_PATTERN.test(assertString(target.commit, 'target.commit'))) throw new Error('target.commit must be a 40-character lowercase hexadecimal commit')
  } else throw new Error('target.name has an invalid value')
}

function validateControl(value: unknown): asserts value is UiControlV1 {
  const control = asRecord(value, 'control')
  exactKeys(control, ['schemaVersion', 'action', 'requestedAt'])
  if (control.schemaVersion !== 1 || (control.action !== 'finish' && control.action !== 'abort')) throw new Error('invalid UI control')
  validateTimestamp(control.requestedAt, 'control.requestedAt')
}

function validateLoopbackUrl(value: unknown): void {
  const url = assertString(value, 'state.url')
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('state.url must be a loopback URL') }
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.port === '') throw new Error('state.url must be a loopback URL')
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || parsed.username || parsed.password) throw new Error('state.url must be a loopback URL')
}

function assertSessionId(value: string): void {
  if (!SESSION_ID_PATTERN.test(value)) throw new Error(`invalid or unsafe sessionId ${JSON.stringify(value)}`)
}

function validateTimestamp(value: unknown, field: string): void {
  const text = assertString(value, field)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || Number.isNaN(Date.parse(text))) throw new Error(`${field} must be an ISO timestamp`)
}

function canTransition(from: UiSessionPhase, to: UiSessionPhase): boolean {
  if (from === to) return true
  const allowed: Record<UiSessionPhase, readonly UiSessionPhase[]> = {
    starting: ['ready', 'crashed', 'stopping'], ready: ['crashed', 'stopping'], crashed: ['stopping'],
    stopping: ['crashed', 'finished', 'aborted'], finished: [], aborted: [],
  }
  return allowed[from].includes(to)
}

function assertStaleReasonsRetained(current: UiSessionStateV1, next: UiSessionStateV1): void {
  const nextReasons = new Set(next.staleReasons ?? [])
  for (const reason of current.staleReasons ?? []) {
    if (!nextReasons.has(reason)) {
      throw new Error(`latched stale reason ${reason} cannot be removed from a UI session`)
    }
  }
}

function isTerminal(phase: UiSessionPhase): boolean { return phase === 'finished' || phase === 'aborted' }
function compareReasons(a: UiStaleReason, b: UiStaleReason): number { return a.localeCompare(b) }
function asRecord(value: unknown, field: string): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return value as Record<string, any>
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unexpected field ${key}`)
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`missing field ${key}`)
}
function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}
function assertNonEmptyString(value: unknown, field: string): string {
  const text = assertString(value, field)
  if (!text.trim() || text.includes('\u0000')) throw new Error(`${field} must be a non-empty string`)
  return text
}

type SessionPaths = { runtimeRoot: string; sessionsRoot: string; sessionDir: string; statePath: string; controlPath: string }
function sessionPaths(runtimeRoot: string, sessionId: string): SessionPaths {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot.trim()) throw new Error('runtimeRoot must be a non-empty path')
  if (PATH_COMPONENTS.has(runtimeRoot)) throw new Error('runtimeRoot must be a concrete path')
  const root = resolve(runtimeRoot)
  const sessionsRoot = join(root, 'ui-sessions')
  const sessionDir = join(sessionsRoot, sessionId)
  return { runtimeRoot: root, sessionsRoot, sessionDir, statePath: join(sessionDir, 'state.json'), controlPath: join(sessionDir, 'control.json') }
}

function mkdirChecked(path: string, label: string): void {
  assertNoSymlinkComponents(path, label)
  mkdirSync(path, { recursive: true })
  assertDirectoryEntry(path, label)
}
function assertSafePath(root: string, candidate: string, label: string): void {
  assertNoSymlinkComponents(root, 'runtime root')
  assertNoSymlinkComponents(candidate, label)
  const contained = relative(resolve(root), resolve(candidate))
  if (contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)) throw new Error(`${label} escapes runtime root`)
}
function assertNoSymlinkComponents(path: string, label: string): void {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink or junction at ${current}`)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
      break
    }
  }
}
function assertDirectoryEntry(path: string, label: string): void {
  let stat
  try { stat = lstatSync(path) } catch (error) { throw new Error(`${label} not found at ${path}`, { cause: error }) }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a regular directory at ${path}`)
}
type DirectoryIdentity = { dev: number; ino: number }
function directoryIdentity(path: string): DirectoryIdentity {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory() || !Number.isInteger(stat.dev) || !Number.isInteger(stat.ino) || stat.dev <= 0 || stat.ino <= 0) {
    throw new Error(`stable identity unavailable for UI session directory ${path}`)
  }
  return { dev: stat.dev, ino: stat.ino }
}
function assertDirectoryIdentity(path: string, expected: DirectoryIdentity): void {
  const current = directoryIdentity(path)
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw new Error(`UI session directory identity changed at ${path}`)
}

function validateStateCandidate(current: UiSessionStateV1, candidate: UiSessionStateV1, sessionId: string): UiSessionStateV1 | undefined {
  const state = candidate.state === 'crashed' && Number.isFinite(Date.parse(candidate.updatedAt)) && Date.parse(candidate.updatedAt) < Date.parse(current.updatedAt)
    ? { ...candidate, updatedAt: current.updatedAt }
    : candidate
  validateState(state)
  assertStaleReasonsRetained(current, state)
  if (isTerminal(current.state)) {
    if (JSON.stringify(current) !== JSON.stringify(state)) throw new Error(`terminal UI session ${sessionId} is immutable`)
    return undefined
  }
  if (!canTransition(current.state, state.state)) throw new Error(`invalid UI session transition ${current.state} -> ${state.state}`)
  if (Date.parse(state.updatedAt) < Date.parse(current.updatedAt)) throw new Error('updatedAt must not move backward')
  return state
}

function acquireSessionMutationLock(sessionDir: string, sessionIdentity: DirectoryIdentity, lockPath: string, afterCreate?: (lockPath: string) => void, ownedSession?: OwnedUiDirectory): DirectoryIdentity {
  ownedSession?.assertCurrent()
  assertDirectoryIdentity(sessionDir, sessionIdentity)
  try { mkdirSync(lockPath) } catch (error) {
    if (isExistsError(error)) throw new Error(`concurrent UI session mutation is already locked at ${lockPath}`)
    throw error
  }
  let lockIdentity: DirectoryIdentity | undefined
  try {
    assertDirectoryIdentity(sessionDir, sessionIdentity)
    lockIdentity = directoryIdentity(lockPath)
    if (lockIdentity.dev <= 0 || lockIdentity.ino <= 0) throw new Error(`stable identity unavailable for UI session mutation lock ${lockPath}`)
    afterCreate?.(lockPath)
    ownedSession?.assertCurrent()
    assertDirectoryIdentity(sessionDir, sessionIdentity)
    assertLockIdentity(lockPath, lockIdentity)
    return lockIdentity
  } catch (error) {
    if (lockIdentity !== undefined) {
      try {
        ownedSession?.assertCurrent()
        assertDirectoryIdentity(sessionDir, sessionIdentity)
        assertLockIdentity(lockPath, lockIdentity)
        rmdirSync(lockPath)
      } catch { /* preserve the identity failure and never remove a replacement lock */ }
    }
    throw error
  }
}

function releaseSessionMutationLock(
  sessionDir: string,
  sessionIdentity: DirectoryIdentity,
  lockPath: string,
  expectedLockIdentity: DirectoryIdentity,
  beforeRemove?: (lockPath: string) => void,
  afterRemove?: (lockPath: string) => void,
  ownedSession?: OwnedUiDirectory,
): void {
  try {
    beforeRemove?.(lockPath)
    ownedSession?.assertCurrent()
    assertDirectoryIdentity(sessionDir, sessionIdentity)
    assertLockIdentity(lockPath, expectedLockIdentity)
    assertDirectoryIdentity(sessionDir, sessionIdentity)
    rmdirSync(lockPath)
    afterRemove?.(lockPath)
    ownedSession?.assertCurrent()
    assertDirectoryIdentity(sessionDir, sessionIdentity)
  } catch (error) {
    throw error
  }
}
function existingEntry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path) } catch (error) { if (isNotFoundError(error)) return undefined; throw error }
}
function assertLockIdentity(path: string, expected: DirectoryIdentity): void {
  const current = directoryIdentity(path)
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw new Error(`UI session mutation lock identity changed at ${path}`)
}
function writeAtomic(path: string, contents: string, replace: boolean, parentIdentity: DirectoryIdentity, ownedSession?: OwnedUiDirectory, beforeTemporaryWrite?: (temporaryPath: string) => void, beforeRename?: (statePath: string) => void): void {
  const parent = resolve(path, '..')
  assertDirectoryEntry(parent, 'UI session directory')
  const existing = existingEntry(path)
  if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`UI state at ${path} is not a regular file`)
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  beforeTemporaryWrite?.(temp)
  ownedSession?.assertCurrent()
  assertDirectoryIdentity(parent, parentIdentity)
  writeExclusiveRegular(temp, contents)
  ownedSession?.assertCurrent()
  assertDirectoryIdentity(parent, parentIdentity)
  try {
    const current = existingEntry(path)
    if (current !== undefined && (current.isSymbolicLink() || !current.isFile())) throw new Error(`UI state at ${path} is not a regular file`)
    if (!replace && current !== undefined) throw new Error(`UI state already exists at ${path}`)
    beforeRename?.(path)
    ownedSession?.assertCurrent()
    assertDirectoryIdentity(parent, parentIdentity)
    renameSync(temp, path)
    ownedSession?.assertCurrent()
    assertDirectoryIdentity(parent, parentIdentity)
  } finally {
    try {
      assertDirectoryIdentity(parent, parentIdentity)
      ownedSession?.assertCurrent()
      unlinkSync(temp)
    } catch (error) {
      if (!isNotFoundError(error) && !/identity changed|not found|stable identity unavailable/i.test(error instanceof Error ? error.message : String(error))) throw error
    }
  }
}
function writeExclusiveRegular(path: string, contents: string): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600)
  try { writeFileSync(descriptor, contents, 'utf8') } finally { closeSync(descriptor) }
}
function readJsonRegular(path: string, label: string): any {
  const entry = existingEntry(path)
  if (entry === undefined) throw new Error(`${label} not found at ${path}`)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${label} at ${path} is not a regular file`)
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag())
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} at ${path} is not a regular file`)
    try { return JSON.parse(readFileSync(descriptor, 'utf8')) } catch (error) { throw corruption(path, error) }
  } finally { closeSync(descriptor) }
}
function corruption(path: string, error: unknown): Error {
  return new Error(`Corrupt UI session file at ${path}: ${error instanceof Error ? error.message : String(error)}`)
}
function noFollowFlag(): number { return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0 }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && 'code' in error }
function isExistsError(error: unknown): boolean { return isNodeError(error) && error.code === 'EEXIST' }
function isNotFoundError(error: unknown): boolean { return isNodeError(error) && error.code === 'ENOENT' }
function randomBytesHex(): string { return randomBytes(4).toString('hex') }
