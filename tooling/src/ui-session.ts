import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  linkSync,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { UiTargetIdentity } from './ui-evidence.js'

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
  writeAtomic(paths.statePath, JSON.stringify(opts.state, null, 2) + '\n', false)
  return paths.sessionDir
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

export function writeUiSession(opts: { runtimeRoot: string; state: UiSessionStateV1 }): void {
  validateState(opts.state)
  assertSessionId(opts.state.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.state.sessionId)
  assertSafePath(paths.runtimeRoot, paths.sessionDir, 'UI session directory')
  assertDirectoryEntry(paths.sessionDir, `UI session ${opts.state.sessionId}`)
  const current = readUiSession({ runtimeRoot: opts.runtimeRoot, sessionId: opts.state.sessionId })
  if (isTerminal(current.state)) {
    if (JSON.stringify(current) !== JSON.stringify(opts.state)) {
      throw new Error(`terminal UI session ${opts.state.sessionId} is immutable`)
    }
    return
  }
  if (!canTransition(current.state, opts.state.state)) {
    throw new Error(`invalid UI session transition ${current.state} -> ${opts.state.state}`)
  }
  if (Date.parse(opts.state.updatedAt) < Date.parse(current.updatedAt)) {
    throw new Error('updatedAt must not move backward')
  }
  writeAtomic(paths.statePath, JSON.stringify(opts.state, null, 2) + '\n', true)
}

export function writeUiControl(opts: { runtimeRoot: string; sessionId: string; control: UiControlV1 }): void {
  validateControl(opts.control)
  assertSessionId(opts.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.sessionId)
  assertSafePath(paths.runtimeRoot, paths.sessionDir, 'UI session directory')
  assertDirectoryEntry(paths.sessionDir, `UI session ${opts.sessionId}`)
  const existing = existingEntry(paths.controlPath)
  if (existing !== undefined) {
    // Validate an existing pending file before reporting the replacement
    // conflict, so corrupt or redirected files are never silently treated as
    // a valid control request.
    readUiControl(opts)
    throw new Error(`UI session ${opts.sessionId} already has a pending control at ${paths.controlPath}`)
  }
  const temporaryPath = `${paths.controlPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  writeExclusiveRegular(temporaryPath, JSON.stringify(opts.control, null, 2) + '\n')
  try {
    assertSafePath(paths.runtimeRoot, paths.sessionDir, 'UI session directory')
    assertDirectoryEntry(paths.sessionDir, `UI session ${opts.sessionId}`)
    try {
      linkSync(temporaryPath, paths.controlPath)
    } catch (error) {
      if (isExistsError(error)) throw new Error(`pending UI control already exists at ${paths.controlPath}`)
      throw error
    }
  } finally {
    try { unlinkSync(temporaryPath) } catch (error) { if (!isNotFoundError(error)) throw error }
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

export function clearUiControl(opts: { runtimeRoot: string; sessionId: string }): void {
  assertSessionId(opts.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.sessionId)
  assertSafePath(paths.runtimeRoot, paths.sessionDir, 'UI session directory')
  assertDirectoryEntry(paths.sessionDir, `UI session ${opts.sessionId}`)
  const entry = existingEntry(paths.controlPath)
  if (entry === undefined) return
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`UI control at ${paths.controlPath} is not a regular file`)
  unlinkSync(paths.controlPath)
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
    if (state.url !== undefined || state.cleanup !== undefined) throw new Error('crashed state cannot contain url or cleanup')
  } else if (phase === 'starting') {
    if (state.url !== undefined || state.error !== undefined || state.cleanup !== undefined) throw new Error('starting state cannot contain url, error, or cleanup')
  } else if (phase === 'stopping') {
    if (state.url !== undefined || state.supervisorPid !== undefined || state.childPid !== undefined || state.error !== undefined) throw new Error('stopping state must not contain live process fields')
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
    stopping: ['finished', 'aborted'], finished: [], aborted: [],
  }
  return allowed[from].includes(to)
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
function existingEntry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path) } catch (error) { if (isNotFoundError(error)) return undefined; throw error }
}
function writeAtomic(path: string, contents: string, replace: boolean): void {
  const parent = resolve(path, '..')
  assertDirectoryEntry(parent, 'UI session directory')
  const existing = existingEntry(path)
  if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`UI state at ${path} is not a regular file`)
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  writeExclusiveRegular(temp, contents)
  try {
    const current = existingEntry(path)
    if (current !== undefined && (current.isSymbolicLink() || !current.isFile())) throw new Error(`UI state at ${path} is not a regular file`)
    if (!replace && current !== undefined) throw new Error(`UI state already exists at ${path}`)
    renameSync(temp, path)
  } finally {
    try { unlinkSync(temp) } catch (error) { if (!isNotFoundError(error)) throw error }
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
