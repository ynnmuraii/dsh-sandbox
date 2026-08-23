import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { pluginEvidenceKey } from './evidence.js'

export type UiTargetIdentity =
  | { name: 'next'; dsh: string }
  | { name: 'master'; commit: string }

export interface UiResultV1 {
  schemaVersion: 1
  sessionId: string
  operation: 'ui'
  verdict: 'pass' | 'fail'
  plugin: { packageName: string; sourcePath: string; digest: `sha256:${string}` }
  target: UiTargetIdentity
  lab: { contextDigest: `sha256:${string}` }
  summary: string
  cleanup: 'pass'
  startedAt: string
  finishedAt: string
}

export interface PublishUiResultOptions {
  uiRunsRoot: string
  result: UiResultV1
  /** Synchronous seam for testing the publication boundary. */
  renameFile?: (from: string, to: string) => void
  beforePublishWrite?: (sessionDirectory: string) => void
}

const PLUGIN_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[a-f0-9]{12}$/
const SESSION_ID_PATTERN = /^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$/
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const COMMIT_PATTERN = /^[a-f0-9]{40}$/
const MAX_SUMMARY_CODE_POINTS = 500
type RecordValue = Record<string, unknown>

export function normalizeUiSummary(summary: string): string {
  if (typeof summary !== 'string') throw new Error('summary must be a string')
  const normalized = summary.trim()
  if (Array.from(normalized).length < 1 || Array.from(normalized).length > MAX_SUMMARY_CODE_POINTS) {
    throw new Error(`summary must contain 1..${MAX_SUMMARY_CODE_POINTS} Unicode code points`)
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new Error('summary must be a single line without control characters')
  }
  return normalized
}

export function publishUiResult(opts: PublishUiResultOptions): string {
  if (!isNonEmptyString(opts.uiRunsRoot)) throw new Error('uiRunsRoot must be a non-empty string')
  const result = canonicalizeUiResult(opts.result)
  const key = pluginEvidenceKey(result.plugin)
  validatePluginKey(key)

  const pluginDirectory = join(opts.uiRunsRoot, key)
  const sessionDirectory = join(pluginDirectory, result.sessionId)
  const finalPath = join(sessionDirectory, 'result.json')
  const temporaryPath = join(sessionDirectory, `${result.sessionId}.tmp`)
  const lockPath = join(sessionDirectory, '.publication.lock')

  assertSafeUiPath(opts.uiRunsRoot, opts.uiRunsRoot, 'uiRunsRoot')
  assertSafeUiPath(opts.uiRunsRoot, pluginDirectory, 'plugin evidence directory')
  mkdirSync(sessionDirectory, { recursive: true })
  assertSafeUiPath(opts.uiRunsRoot, pluginDirectory, 'plugin evidence directory')
  assertSafeUiPath(opts.uiRunsRoot, sessionDirectory, 'session evidence directory')

  try {
    mkdirSync(lockPath)
  } catch (error) {
    if (isFileExistsError(error)) {
      throw new Error(
        `UI session ${result.sessionId} has an existing publication lock at ${lockPath}; ` +
          'it may be stale or orphaned. Confirm no publisher is active, then remove the lock and retry.',
      )
    }
    throw error
  }

  let temporaryCreated = false
  let publicationSucceeded = false
  try {
    if (existsSync(finalPath)) {
      throw new Error(`UI session ${result.sessionId} is already finalized; immutable evidence cannot be replaced`)
    }
    opts.beforePublishWrite?.(sessionDirectory)
    assertSafeUiPath(opts.uiRunsRoot, sessionDirectory, 'session evidence directory')
    assertDirectoryEntry(sessionDirectory, 'session evidence directory')
    if (existsSync(finalPath)) {
      throw new Error(`UI session ${result.sessionId} is already finalized; immutable evidence cannot be replaced`)
    }
    if (existingFileEntry(temporaryPath)) {
      throw new Error(
        `Temporary UI evidence already exists at ${temporaryPath}; it may be stale or orphaned. ` +
          `Confirm no publisher is active, then remove ${temporaryPath} or recover it before retrying.`,
      )
    }

    try {
      assertSafeUiPath(opts.uiRunsRoot, sessionDirectory, 'session evidence directory')
      assertDirectoryEntry(sessionDirectory, 'session evidence directory')
      temporaryCreated = true
      writeTemporaryNoFollow(temporaryPath, `${JSON.stringify(result, null, 2)}\n`)
      assertSafeUiPath(opts.uiRunsRoot, sessionDirectory, 'session evidence directory')
      assertDirectoryEntry(sessionDirectory, 'session evidence directory')
      ;(opts.renameFile ?? renameSync)(temporaryPath, finalPath)
      temporaryCreated = false
      publicationSucceeded = true
    } catch (error) {
      if (temporaryCreated) removeTemporary(opts.uiRunsRoot, sessionDirectory, temporaryPath)
      throw error
    }
    return finalPath
  } finally {
    const lockError = removeLock(opts.uiRunsRoot, sessionDirectory, lockPath)
    if (lockError && publicationSucceeded) throw lockError
  }
}

export function loadUiResults(opts: {
  uiRunsRoot: string
  pluginKey: string
  beforeResultRead?: (resultPath: string) => void
}): UiResultV1[] {
  if (!isNonEmptyString(opts.uiRunsRoot)) throw new Error('uiRunsRoot must be a non-empty string')
  validatePluginKey(opts.pluginKey)
  const pluginRoot = join(opts.uiRunsRoot, opts.pluginKey)
  assertSafeUiPath(opts.uiRunsRoot, opts.uiRunsRoot, 'uiRunsRoot')
  if (!existsSync(pluginRoot)) return []
  assertSafeUiPath(opts.uiRunsRoot, pluginRoot, 'plugin evidence directory')

  let entries
  try {
    entries = readdirSync(pluginRoot, { withFileTypes: true })
  } catch (error) {
    throw corruptionError(pluginRoot, error)
  }

  const results: UiResultV1[] = []
  for (const entry of entries) {
    const sessionDirectory = join(pluginRoot, entry.name)
    let sessionStat
    try {
      sessionStat = lstatSync(sessionDirectory)
    } catch (error) {
      throw corruptionError(sessionDirectory, error)
    }
    if (sessionStat.isSymbolicLink()) {
      throw corruptionError(sessionDirectory, 'symlink or junction path component is not allowed')
    }
    if (!sessionStat.isDirectory()) continue

    assertSafeUiPath(opts.uiRunsRoot, sessionDirectory, 'session evidence directory')
    const resultPath = join(sessionDirectory, 'result.json')
    let resultStat
    try {
      resultStat = lstatSync(resultPath)
    } catch (error) {
      if (isNotFoundError(error)) continue
      throw corruptionError(resultPath, error)
    }
    if (!resultStat.isFile()) throw corruptionError(resultPath, 'result.json is not a regular file')
    opts.beforeResultRead?.(resultPath)
    try {
      assertSafeUiPath(opts.uiRunsRoot, sessionDirectory, 'session evidence directory')
      assertDirectoryEntry(sessionDirectory, 'session evidence directory')
      assertRegularFile(resultPath)
    } catch (error) {
      throw corruptionError(resultPath, error)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(readResultNoFollow(resultPath))
    } catch (error) {
      throw corruptionError(resultPath, error)
    }
    try {
      validateSessionId(entry.name)
      const result = validateUiResult(parsed)
      if (result.sessionId !== entry.name) throw new Error(`sessionId does not match its directory (${entry.name})`)
      if (pluginEvidenceKey(result.plugin) !== opts.pluginKey) {
        throw new Error('plugin identity does not match its evidence directory')
      }
      results.push(result)
    } catch (error) {
      throw corruptionError(resultPath, error)
    }
  }

  results.sort((left, right) => {
    const byFinishedAt = Date.parse(right.finishedAt) - Date.parse(left.finishedAt)
    return byFinishedAt || compareCodePoints(left.sessionId, right.sessionId)
  })
  return results
}

function canonicalizeUiResult(value: unknown): UiResultV1 {
  const result = validateUiResult(value)
  return {
    schemaVersion: 1,
    sessionId: result.sessionId,
    operation: 'ui',
    verdict: result.verdict,
    plugin: {
      packageName: result.plugin.packageName,
      sourcePath: result.plugin.sourcePath,
      digest: result.plugin.digest,
    },
    target: result.target.name === 'next'
      ? { name: 'next', dsh: result.target.dsh }
      : { name: 'master', commit: result.target.commit },
    lab: { contextDigest: result.lab.contextDigest },
    summary: normalizeUiSummary(result.summary),
    cleanup: 'pass',
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  }
}

function validateUiResult(value: unknown): UiResultV1 {
  const result = asRecord(value, 'result')
  assertExactKeys(result, [
    'schemaVersion', 'sessionId', 'operation', 'verdict', 'plugin', 'target', 'lab',
    'summary', 'cleanup', 'startedAt', 'finishedAt',
  ], 'result')
  if (result.schemaVersion !== 1) throw new Error('schemaVersion must be 1')
  validateSessionId(assertString(result.sessionId, 'sessionId'))
  if (result.operation !== 'ui') throw new Error('operation must be ui')
  assertOneOf(result.verdict, ['pass', 'fail'], 'verdict')
  validatePlugin(result.plugin)
  validateTarget(result.target)
  validateLab(result.lab)
  normalizeUiSummary(assertString(result.summary, 'summary'))
  if (result.cleanup !== 'pass') throw new Error('cleanup must be pass')
  validateTimestamp(result.startedAt, 'startedAt')
  validateTimestamp(result.finishedAt, 'finishedAt')
  if (Date.parse(result.startedAt as string) > Date.parse(result.finishedAt as string)) {
    throw new Error('finishedAt must not be before startedAt')
  }
  return value as UiResultV1
}

function validatePlugin(value: unknown): void {
  const plugin = asRecord(value, 'plugin')
  assertExactKeys(plugin, ['packageName', 'sourcePath', 'digest'], 'plugin')
  assertNonEmptyString(plugin.packageName, 'plugin.packageName')
  assertNonEmptyString(plugin.sourcePath, 'plugin.sourcePath')
  const digest = assertString(plugin.digest, 'plugin.digest')
  if (!SHA256_PATTERN.test(digest)) throw new Error('plugin.digest must be a sha256 digest')
}

function validateTarget(value: unknown): asserts value is UiTargetIdentity {
  const target = asRecord(value, 'target')
  const name = assertString(target.name, 'target.name')
  if (name === 'next') {
    assertExactKeys(target, ['name', 'dsh'], 'target')
    assertNonEmptyString(target.dsh, 'target.dsh')
  } else if (name === 'master') {
    assertExactKeys(target, ['name', 'commit'], 'target')
    const commit = assertString(target.commit, 'target.commit')
    if (!COMMIT_PATTERN.test(commit)) throw new Error('target.commit must be a 40-character lowercase hexadecimal commit')
  } else {
    throw new Error('target.name has an invalid value')
  }
}

function validateLab(value: unknown): void {
  const lab = asRecord(value, 'lab')
  assertExactKeys(lab, ['contextDigest'], 'lab')
  const digest = assertString(lab.contextDigest, 'lab.contextDigest')
  if (!SHA256_PATTERN.test(digest)) throw new Error('lab.contextDigest must be a sha256 digest')
}

function validateSessionId(value: string): void {
  if (!SESSION_ID_PATTERN.test(value)) throw new Error(`Invalid sessionId: ${value}`)
}

function validatePluginKey(pluginKey: string): void {
  if (!PLUGIN_KEY_PATTERN.test(pluginKey)) throw new Error(`Invalid plugin key: ${pluginKey}`)
}

function validateTimestamp(value: unknown, field: string): void {
  const timestamp = assertString(value, field)
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) throw new Error(`${field} must be an ISO timestamp`)
}

function asRecord(value: unknown, field: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return value as RecordValue
}

function assertExactKeys(value: RecordValue, expected: readonly string[], field: string): void {
  const allowed = new Set(expected)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unexpected field ${field}.${key}`)
  for (const key of expected) if (!Object.hasOwn(value, key)) throw new Error(`Missing field ${field}.${key}`)
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function assertNonEmptyString(value: unknown, field: string): string {
  const stringValue = assertString(value, field)
  if (!stringValue.trim() || stringValue.includes('\u0000')) throw new Error(`${field} must be a non-empty string`)
  return stringValue
}

function assertOneOf<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`${field} has an invalid value`)
  return value as T
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\u0000')
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
function isFileExistsError(error: unknown): boolean { return isNodeError(error) && error.code === 'EEXIST' }
function isNotFoundError(error: unknown): boolean { return isNodeError(error) && error.code === 'ENOENT' }

function noFollowFlag(): number {
  return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
}

function writeTemporaryNoFollow(path: string, contents: string): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600)
  try { writeFileSync(descriptor, contents, { encoding: 'utf8' }) } finally { closeSync(descriptor) }
}

function readResultNoFollow(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag())
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile()) throw new Error('result.json is not a regular file')
    return readFileSync(descriptor, { encoding: 'utf8' })
  } finally { closeSync(descriptor) }
}

function assertSafeUiPath(uiRunsRoot: string, candidate: string, label: string): void {
  const rootPath = resolve(uiRunsRoot)
  const candidatePath = resolve(candidate)
  assertNoSymlinkComponents(rootPath, 'uiRunsRoot')
  assertNoSymlinkComponents(candidatePath, label)
  if (!existsSync(rootPath)) return
  const realRoot = realpathSync(rootPath)
  const existingCandidate = nearestExistingPath(candidatePath)
  const realCandidate = realpathSync(existingCandidate)
  const outside = relative(realRoot, realCandidate)
  if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
    throw new Error(`${label} escapes uiRunsRoot through a symlink or junction`)
  }
}

function assertNoSymlinkComponents(path: string, label: string): void {
  const absolutePath = resolve(path)
  const root = parse(absolutePath).root
  const relativePath = relative(root, absolutePath)
  let current = root
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component)
    let stat
    try { stat = lstatSync(current) } catch (error) {
      if (isNotFoundError(error)) break
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink or junction at ${current}`)
  }
}

function nearestExistingPath(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }
  return current
}

function compareCodePoints(left: string, right: string): number {
  const folded = compareCodePointStrings(left.toLowerCase(), right.toLowerCase())
  return folded || compareCodePointStrings(left, right)
}
function compareCodePointStrings(left: string, right: string): number {
  const leftPoints = Array.from(left)
  const rightPoints = Array.from(right)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!
    const rightPoint = rightPoints[index]!.codePointAt(0)!
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1
  }
  return leftPoints.length === rightPoints.length ? 0 : leftPoints.length < rightPoints.length ? -1 : 1
}

function removeTemporary(uiRunsRoot: string, sessionDirectory: string, path: string): void {
  try {
    assertSafeUiPath(uiRunsRoot, sessionDirectory, 'session evidence directory')
    assertDirectoryEntry(sessionDirectory, 'session evidence directory')
    rmSync(path, { force: true })
  } catch { /* preserve the publication error */ }
}

function removeLock(uiRunsRoot: string, sessionDirectory: string, path: string): Error | undefined {
  try {
    assertSafeUiPath(uiRunsRoot, sessionDirectory, 'session evidence directory')
    assertDirectoryEntry(sessionDirectory, 'session evidence directory')
    rmSync(path, { recursive: true, force: true })
    return undefined
  } catch {
    return new Error(`Publication lock ${path} could not be removed; it may be orphaned. Confirm no publisher is active, then remove the lock and retry.`)
  }
}

function existingFileEntry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path) } catch (error) {
    if (isNotFoundError(error)) return undefined
    throw error
  }
}
function assertDirectoryEntry(path: string, label: string): void {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} is not a regular directory; symlink or junction replacement detected`)
}
function assertRegularFile(path: string): void {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('result.json is not a regular file; symlink or junction replacement detected')
}
function corruptionError(path: string, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new Error(`Corrupt finalized UI evidence at ${path}: ${message}`)
}
