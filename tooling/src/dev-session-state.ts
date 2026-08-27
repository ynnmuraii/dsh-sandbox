import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { DevRestartBaseline, DevRestartReason } from './dev-restart-baseline.js'
import { claimOwnedUiDirectory, type OwnedUiDirectory } from './ui-owned-directory.js'

export type DevSessionPhase = 'starting' | 'ready' | 'crashed' | 'stopping' | 'stopped'

export interface DevSessionStateV1 {
  schemaVersion: 1
  sessionId: string
  state: DevSessionPhase
  plugin: { packageName: string; sourcePath: string; runtimeName: string }
  target: { name: 'next'; dsh: string } | { name: 'master'; commit: string }
  restartBaseline: DevRestartBaseline
  restartHash: `sha256:${string}`
  restartRequired: boolean
  restartReasons?: DevRestartReason[]
  supervisorPid?: number
  childPid?: number
  url?: string
  error?: string
  cleanup?: 'pass' | 'fail'
  startedAt: string
  updatedAt: string
}

export type DevControlV1 = { schemaVersion: 1; action: 'stop'; requestedAt: string }

export interface DevSessionViewV1 {
  schemaVersion: 1
  sessionId: string
  state: DevSessionPhase
  restartRequired: boolean
  restartReasons: DevRestartReason[]
  restartHash: `sha256:${string}`
  plugin: { packageName: string; sourcePath: string; runtimeName: string }
  target: { name: 'next'; dsh: string } | { name: 'master'; commit: string }
  url?: string
  error?: string
  cleanup?: 'pass' | 'fail'
  orphan?: true
  startedAt: string
  updatedAt: string
}

export const DEV_SESSION_ID_PATTERN = /^dev-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$/
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const COMMIT_PATTERN = /^[a-f0-9]{40}$/
const REASONS: readonly DevRestartReason[] = ['plugin-manifest', 'plugin-metadata', 'target-pin', 'source-changed']
const PHASES: readonly DevSessionPhase[] = ['starting', 'ready', 'crashed', 'stopping', 'stopped']

export function createDevSessionId(now = new Date(), randomHex = () => randomBytes(4).toString('hex')): string {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('now must be a valid Date')
  const suffix = randomHex()
  if (!/^[a-f0-9]{8}$/.test(suffix)) throw new Error('randomHex must return eight lowercase hex characters')
  const iso = now.toISOString()
  const date = iso.slice(0, 10).replace(/-/g, '')
  const time = iso.slice(11, 23).replace(/[:.]/g, '')
  const id = `dev-${date}T${time}Z-${suffix}`
  validateDevSessionId(id)
  return id
}

export function validateDevSessionId(value: string): void {
  if (typeof value !== 'string' || !DEV_SESSION_ID_PATTERN.test(value)) throw new Error(`invalid or unsafe sessionId ${JSON.stringify(value)}`)
}

export function canTransition(from: DevSessionPhase, to: DevSessionPhase): boolean {
  if (from === to) return true
  const allowed: Record<DevSessionPhase, readonly DevSessionPhase[]> = {
    starting: ['ready', 'crashed', 'stopping'],
    ready: ['crashed', 'stopping'],
    crashed: ['stopping'],
    stopping: ['stopped', 'crashed'],
    stopped: [],
  }
  return allowed[from].includes(to)
}

function sessionPaths(runtimeRoot: string, sessionId: string) {
  if (runtimeRoot === '.' || runtimeRoot === '..') throw new Error('runtimeRoot must be a concrete path')
  const root = resolve(runtimeRoot)
  const sessionsRoot = join(root, 'dev-sessions')
  const sessionDir = join(sessionsRoot, sessionId)
  return { runtimeRoot: root, sessionsRoot, sessionDir, statePath: join(sessionDir, 'state.json'), controlPath: join(sessionDir, 'control.json') }
}

// Mirrors ui-session.ts's mkdir safety ordering: containment and no symlink
// components are proven before the first exclusive create, so a junctioned
// dev-sessions root can never cause a session to be created outside runtimeRoot.
export function createOwnedDevSession(opts: { runtimeRoot: string; state: DevSessionStateV1; afterOwnerCapture?: (sessionDir: string) => void }): { sessionDir: string; ownedSession: OwnedUiDirectory } {
  validateDevState(opts.state)
  validateDevSessionId(opts.state.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.state.sessionId)
  assertSafePath(paths.runtimeRoot, paths.sessionDir, 'dev session directory')
  mkdirChecked(paths.runtimeRoot, 'runtime root')
  mkdirChecked(paths.sessionsRoot, 'dev sessions directory')
  try { mkdirSync(paths.sessionDir) } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      assertDirectoryEntry(paths.sessionDir, 'dev session directory')
      throw new Error(`dev session ${opts.state.sessionId} already exists`)
    }
    throw error
  }
  assertDirectoryEntry(paths.sessionDir, 'dev session directory')
  const ownedSession = claimOwnedUiDirectory({ root: paths.runtimeRoot, directory: paths.sessionDir })
  ownedSession.assertCurrent()
  opts.afterOwnerCapture?.(paths.sessionDir)
  ownedSession.assertCurrent()
  writeAtomic(paths.statePath, JSON.stringify(opts.state, null, 2) + '\n', false, ownedSession)
  ownedSession.assertCurrent()
  return { sessionDir: paths.sessionDir, ownedSession }
}

export function writeDevSessionRequest(opts: { runtimeRoot: string; sessionId: string; request: unknown; ownedSession?: OwnedUiDirectory }): string {
  validateDevSessionId(opts.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.sessionId)
  opts.ownedSession?.assertCurrent()
  assertSafePath(paths.runtimeRoot, paths.sessionDir, 'dev session directory')
  assertDirectoryEntry(paths.sessionDir, 'dev session directory')
  const requestPath = join(paths.sessionDir, 'request.json')
  writeFileSync(requestPath, JSON.stringify(opts.request, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  opts.ownedSession?.assertCurrent()
  return requestPath
}

export function readDevSession(opts: { runtimeRoot: string; sessionId: string }): DevSessionStateV1 {
  validateDevSessionId(opts.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.sessionId)
  const parsed = JSON.parse(readFileSync(paths.statePath, 'utf8')) as unknown
  validateDevState(parsed)
  if ((parsed as DevSessionStateV1).sessionId !== opts.sessionId) throw new Error(`dev session id mismatch at ${paths.statePath}`)
  return parsed as DevSessionStateV1
}

export function writeDevSession(opts: { runtimeRoot: string; state: DevSessionStateV1; ownedSession?: OwnedUiDirectory }): void {
  validateDevSessionId(opts.state.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.state.sessionId)
  opts.ownedSession?.assertCurrent()
  const current = readDevSession({ runtimeRoot: opts.runtimeRoot, sessionId: opts.state.sessionId })
  validateStateCandidate(current, opts.state)
  opts.ownedSession?.assertCurrent()
  writeAtomic(paths.statePath, JSON.stringify(opts.state, null, 2) + '\n', true, opts.ownedSession)
  opts.ownedSession?.assertCurrent()
}

export function writeDevControl(opts: { runtimeRoot: string; sessionId: string; control: DevControlV1; ownedSession?: OwnedUiDirectory }): void {
  validateDevSessionId(opts.sessionId)
  if (opts.control.schemaVersion !== 1 || opts.control.action !== 'stop') throw new Error('invalid dev control')
  const paths = sessionPaths(opts.runtimeRoot, opts.sessionId)
  opts.ownedSession?.assertCurrent()
  if (exists(paths.controlPath)) { readDevControl(opts); throw new Error(`dev session ${opts.sessionId} already has a pending control`) }
  writeFileSync(paths.controlPath, JSON.stringify(opts.control, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  opts.ownedSession?.assertCurrent()
}

export function readDevControl(opts: { runtimeRoot: string; sessionId: string }): DevControlV1 | undefined {
  validateDevSessionId(opts.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.sessionId)
  if (!exists(paths.controlPath)) return undefined
  const parsed = JSON.parse(readFileSync(paths.controlPath, 'utf8')) as DevControlV1
  if (parsed.schemaVersion !== 1 || parsed.action !== 'stop') throw new Error('invalid dev control')
  return parsed
}

export function clearDevControl(opts: { runtimeRoot: string; sessionId: string; ownedSession?: OwnedUiDirectory }): void {
  validateDevSessionId(opts.sessionId)
  const paths = sessionPaths(opts.runtimeRoot, opts.sessionId)
  opts.ownedSession?.assertCurrent()
  if (exists(paths.controlPath)) { readDevControl(opts); unlinkSync(paths.controlPath) }
  opts.ownedSession?.assertCurrent()
}

export function latchDevRestartReasons(state: DevSessionStateV1, reasons: DevRestartReason[], now: string): DevSessionStateV1 {
  if (state.state === 'stopped') throw new Error('terminal dev session is immutable')
  validateTimestamp(now, 'now')
  if (Date.parse(now) < Date.parse(state.updatedAt)) throw new Error('updatedAt must not move backward')
  for (const reason of reasons) if (!REASONS.includes(reason)) throw new Error(`invalid restart reason ${String(reason)}`)
  const combined = new Set<DevRestartReason>([...(state.restartReasons ?? []), ...reasons])
  return { ...state, restartRequired: true, restartReasons: [...combined].sort((a, b) => a.localeCompare(b)), updatedAt: now }
}

export function viewFromDevState(state: DevSessionStateV1): DevSessionViewV1 {
  const reasons = [...(state.restartReasons ?? [])].sort((a, b) => a.localeCompare(b))
  const view: DevSessionViewV1 = {
    schemaVersion: 1, sessionId: state.sessionId, state: state.state,
    restartRequired: state.restartRequired, restartReasons: reasons, restartHash: state.restartHash,
    plugin: state.plugin, target: state.target, startedAt: state.startedAt, updatedAt: state.updatedAt,
  }
  if (state.state === 'ready' && state.url !== undefined) view.url = state.url
  if (state.error !== undefined) view.error = state.error
  if (state.cleanup !== undefined) view.cleanup = state.cleanup
  return view
}

function validateStateCandidate(current: DevSessionStateV1, candidate: DevSessionStateV1): void {
  validateDevState(candidate)
  if (current.state === 'stopped') { if (JSON.stringify(current) !== JSON.stringify(candidate)) throw new Error(`terminal dev session ${current.sessionId} is immutable`); return }
  if (!canTransition(current.state, candidate.state)) throw new Error(`invalid dev session transition ${current.state} -> ${candidate.state}`)
  if (Date.parse(candidate.updatedAt) < Date.parse(current.updatedAt)) throw new Error('updatedAt must not move backward')
  // retained latched reasons never clear
  for (const reason of current.restartReasons ?? []) if (!(candidate.restartReasons ?? []).includes(reason)) throw new Error(`latched restart reason ${reason} cannot be removed`)
}

function validateDevState(value: unknown): asserts value is DevSessionStateV1 {
  const s = value as DevSessionStateV1
  if (!s || typeof s !== 'object') throw new Error('dev session state must be an object')
  if (s.schemaVersion !== 1) throw new Error('state.schemaVersion must be 1')
  validateDevSessionId(s.sessionId)
  if (!PHASES.includes(s.state)) throw new Error('state.state has an invalid value')
  validateTarget(s.target)
  validateTimestamp(s.startedAt, 'state.startedAt')
  validateTimestamp(s.updatedAt, 'state.updatedAt')
  if (Date.parse(s.updatedAt) < Date.parse(s.startedAt)) throw new Error('updatedAt must not be earlier than startedAt')
  for (const k of ['pluginManifest', 'pluginMetadata', 'targetPin', 'sourceTree'] as const) {
    if (!SHA256_PATTERN.test(s.restartBaseline?.[k] ?? '')) throw new Error(`restartBaseline.${k} must be a sha256 digest`)
  }
  if (!SHA256_PATTERN.test(s.restartHash)) throw new Error('restartHash must be a sha256 digest')
  if (typeof s.restartRequired !== 'boolean') throw new Error('restartRequired must be a boolean')
  for (const f of ['supervisorPid', 'childPid'] as const) if (s[f] !== undefined && (!Number.isInteger(s[f]) || s[f]! <= 0)) throw new Error(`${f} must be a positive integer PID`)
  if (s.url !== undefined) validateLoopbackUrl(s.url)
  if (s.error !== undefined && !s.error.trim()) throw new Error('error must be non-empty')
  if (s.cleanup !== undefined && s.cleanup !== 'pass' && s.cleanup !== 'fail') throw new Error('cleanup has an invalid value')
  if (s.state === 'ready' && (s.supervisorPid === undefined || s.childPid === undefined || s.url === undefined || s.error !== undefined || s.cleanup !== undefined)) throw new Error('ready requires supervisorPid, childPid, url')
  if (s.state === 'crashed' && (s.error === undefined || s.url !== undefined)) throw new Error('crashed requires error and no url')
  if (s.state === 'stopped' && (s.cleanup !== 'pass' || s.url !== undefined || s.supervisorPid !== undefined || s.childPid !== undefined || s.error !== undefined)) throw new Error('stopped must be compact with cleanup:pass')
}

function validateTarget(value: unknown): asserts value is DevSessionStateV1['target'] {
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

function validateTimestamp(value: unknown, field: string): void {
  const text = assertString(value, field)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || Number.isNaN(Date.parse(text))) throw new Error(`${field} must be an ISO timestamp`)
}

function validateLoopbackUrl(value: string): void {
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('state.url must be a loopback URL') }
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.port === '') throw new Error('state.url must be a loopback URL')
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || parsed.username || parsed.password) throw new Error('state.url must be a loopback URL')
}

function assertSafePath(root: string, candidate: string, label: string): void {
  assertNoSymlinkComponents(root, 'runtime root')
  assertNoSymlinkComponents(candidate, label)
  const contained = relative(resolve(root), resolve(candidate))
  if (contained === '..' || contained.startsWith(`..${sep}`) || isAbsolute(contained)) throw new Error(`${label} escapes runtime root`)
}

function mkdirChecked(path: string, label: string): void {
  assertNoSymlinkComponents(path, label)
  mkdirSync(path, { recursive: true })
  assertDirectoryEntry(path, label)
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
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
      break
    }
  }
}

function assertDirectoryEntry(path: string, label: string): void {
  let stat
  try { stat = lstatSync(path) } catch (error) { throw new Error(`${label} not found at ${path}`, { cause: error }) }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a regular directory at ${path}`)
}

function asRecord(value: unknown, field: string): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return value as Record<string, any>
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = [...required, ...optional]
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unexpected field ${key}`)
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

function writeAtomic(path: string, contents: string, replace: boolean, ownedSession?: OwnedUiDirectory): void {
  const temp = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  writeFileSync(temp, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  try {
    if (!replace && exists(path)) throw new Error(`dev state already exists at ${path}`)
    ownedSession?.assertCurrent()
    renameSync(temp, path)
    ownedSession?.assertCurrent()
  } finally { try { unlinkSync(temp) } catch (e) { if (!(isNodeError(e) && e.code === 'ENOENT')) throw e } }
}

function exists(path: string): boolean { try { lstatSync(path); return true } catch (e) { if (isNodeError(e) && e.code === 'ENOENT') return false; throw e } }
function isNodeError(e: unknown): e is NodeJS.ErrnoException { return e instanceof Error && 'code' in e }
