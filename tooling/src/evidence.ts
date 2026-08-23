import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

export type StepStatus = 'pass' | 'fail' | 'blocked' | 'skipped' | 'not-applicable'
export type RunOutcome = 'pass' | 'fail' | 'blocked'

export interface RunStepResult {
  id: string
  status: StepStatus
  durationMs: number
  summary?: string
}

export interface VerifyRunResultV1 {
  schemaVersion: 1
  runId: string
  operation: 'verify'
  result: RunOutcome
  plugin: { packageName: string; sourcePath: string; digest: `sha256:${string}` }
  targets: Record<string, { dsh?: string; commit?: string; result: StepStatus }>
  lab: { contextDigest: string }
  environment: { node: string; pnpm: string; platform: NodeJS.Platform }
  steps: RunStepResult[]
  cleanup: 'pass' | 'fail'
  startedAt: string
  finishedAt: string
}

export interface PublishRunResultOptions {
  runsRoot: string
  result: VerifyRunResultV1
  /** Synchronous seam for testing the publication boundary. */
  renameFile?: (from: string, to: string) => void
}

type RecordValue = Record<string, unknown>

const STEP_STATUSES: readonly StepStatus[] = [
  'pass',
  'fail',
  'blocked',
  'skipped',
  'not-applicable',
]
const RUN_OUTCOMES: readonly RunOutcome[] = ['pass', 'fail', 'blocked']
const PLATFORMS: readonly NodeJS.Platform[] = [
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
]
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PLUGIN_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-[a-f0-9]{12}$/
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const MAX_SUMMARY_LENGTH = 500
const MAX_STEPS = 256

/**
 * Return a stable, path-safe identity for one plugin source tree.
 *
 * Path normalization is deliberately independent of the host platform: source
 * paths can refer to a Windows checkout even when the forge is being tested on
 * another platform.
 */
export function pluginEvidenceKey(plugin: {
  packageName: string
  sourcePath: string
}): string {
  assertNonEmptyString(plugin.packageName, 'plugin.packageName')
  assertNonEmptyString(plugin.sourcePath, 'plugin.sourcePath')

  const normalizedPath = normalizeSourcePath(plugin.sourcePath)
  const packageFragment = sanitizePackageName(plugin.packageName)
  const identity = `${plugin.packageName.trim()}\u0000${normalizedPath}`
  const pathHash = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 12)
  return `${packageFragment}-${pathHash}`
}

export function publishRunResult(opts: PublishRunResultOptions): string {
  if (!isNonEmptyString(opts.runsRoot)) throw new Error('runsRoot must be a non-empty string')
  const result = validateRunResult(opts.result)
  const pluginKey = pluginEvidenceKey(result.plugin)
  validateRunId(result.runId)

  const pluginDirectory = join(opts.runsRoot, pluginKey)
  const runDirectory = join(opts.runsRoot, pluginKey, result.runId)
  const finalPath = join(runDirectory, 'result.json')
  const temporaryPath = join(runDirectory, `${result.runId}.tmp`)
  const lockPath = join(runDirectory, '.publication.lock')

  assertSafeEvidencePath(opts.runsRoot, opts.runsRoot, 'runsRoot')
  assertSafeEvidencePath(opts.runsRoot, pluginDirectory, 'plugin evidence directory')
  mkdirSync(runDirectory, { recursive: true })
  assertSafeEvidencePath(opts.runsRoot, pluginDirectory, 'plugin evidence directory')
  assertSafeEvidencePath(opts.runsRoot, runDirectory, 'run evidence directory')

  try {
    // mkdir is an atomic exclusive operation. It closes the check-then-rename
    // race between two forge publishers sharing this runs root.
    mkdirSync(lockPath)
  } catch (error) {
    if (isFileExistsError(error)) {
      throw new Error(
        `Run ${result.runId} has an existing publication lock at ${lockPath}; ` +
          'it may be stale or orphaned. Confirm no publisher is active, then remove the lock and retry.',
      )
    }
    throw error
  }

  let temporaryCreated = false
  let publicationSucceeded = false
  try {
    if (existsSync(finalPath)) {
      throw new Error(`Run ${result.runId} is already finalized; immutable evidence cannot be replaced`)
    }
    if (existsSync(temporaryPath)) {
      throw new Error(`Temporary evidence already exists for run ${result.runId}`)
    }

    try {
      // wx avoids replacing a stale temporary file if another process has not
      // obeyed the publication lock. The temporary and final files share a
      // directory so rename remains atomic on the target filesystem.
      temporaryCreated = true
      const stored = sanitizeResult(result)
      writeFileSync(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      })
      ;(opts.renameFile ?? renameSync)(temporaryPath, finalPath)
      temporaryCreated = false
      publicationSucceeded = true
    } catch (error) {
      if (temporaryCreated || existsSync(temporaryPath)) removeTemporary(temporaryPath)
      throw error
    }

    return finalPath
  } finally {
    const lockError = removeLock(lockPath)
    if (lockError && publicationSucceeded) throw lockError
  }
}

export function loadRunResults(opts: { runsRoot: string; pluginKey: string }): VerifyRunResultV1[] {
  if (!isNonEmptyString(opts.runsRoot)) throw new Error('runsRoot must be a non-empty string')
  validatePluginKey(opts.pluginKey)
  const pluginRoot = join(opts.runsRoot, opts.pluginKey)
  assertSafeEvidencePath(opts.runsRoot, opts.runsRoot, 'runsRoot')
  if (!existsSync(pluginRoot)) return []
  assertSafeEvidencePath(opts.runsRoot, pluginRoot, 'plugin evidence directory')

  let entries
  try {
    entries = readdirSync(pluginRoot, { withFileTypes: true })
  } catch (error) {
    throw corruptionError(pluginRoot, error)
  }

  const runs: VerifyRunResultV1[] = []
  for (const entry of entries) {
    const runDirectory = join(pluginRoot, entry.name)
    let runStat
    try {
      runStat = lstatSync(runDirectory)
    } catch (error) {
      throw corruptionError(runDirectory, error)
    }
    if (runStat.isSymbolicLink()) {
      throw corruptionError(runDirectory, 'symlink or junction path component is not allowed')
    }
    if (!runStat.isDirectory()) continue
    assertSafeEvidencePath(opts.runsRoot, runDirectory, 'run evidence directory')

    const resultPath = join(runDirectory, 'result.json')
    let resultFile
    try {
      resultFile = lstatSync(resultPath)
    } catch (error) {
      if (isNotFoundError(error)) continue
      throw corruptionError(resultPath, error)
    }
    if (!resultFile.isFile()) throw corruptionError(resultPath, 'result.json is not a regular file')

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(resultPath, 'utf8'))
    } catch (error) {
      throw corruptionError(resultPath, error)
    }

    try {
      validateRunId(entry.name)
      const run = validateRunResult(parsed)
      if (run.runId !== entry.name) {
        throw new Error(`runId does not match its directory (${entry.name})`)
      }
      if (pluginEvidenceKey(run.plugin) !== opts.pluginKey) {
        throw new Error('plugin identity does not match its evidence directory')
      }
      runs.push(run)
    } catch (error) {
      throw corruptionError(resultPath, error)
    }
  }

  runs.sort((left, right) => {
    const byFinishedAt = Date.parse(right.finishedAt) - Date.parse(left.finishedAt)
    return byFinishedAt || compareCodePoints(left.runId, right.runId)
  })
  return runs
}

function validateRunResult(value: unknown): VerifyRunResultV1 {
  const result = asRecord(value, 'result')
  assertExactKeys(result, [
    'schemaVersion',
    'runId',
    'operation',
    'result',
    'plugin',
    'targets',
    'lab',
    'environment',
    'steps',
    'cleanup',
    'startedAt',
    'finishedAt',
  ], 'result')

  if (result.schemaVersion !== 1) throw new Error('schemaVersion must be 1')
  validateRunId(assertString(result.runId, 'runId'))
  if (result.operation !== 'verify') throw new Error('operation must be verify')
  assertOneOf(result.result, RUN_OUTCOMES, 'result.result')

  validatePlugin(result.plugin)
  validateTargets(result.targets)
  validateLab(result.lab)
  validateEnvironment(result.environment)
  validateSteps(result.steps)
  assertOneOf(result.cleanup, ['pass', 'fail'], 'cleanup')
  validateTimestamp(result.startedAt, 'startedAt')
  validateTimestamp(result.finishedAt, 'finishedAt')

  return value as VerifyRunResultV1
}

function validatePlugin(value: unknown): void {
  const plugin = asRecord(value, 'plugin')
  assertExactKeys(plugin, ['packageName', 'sourcePath', 'digest'], 'plugin')
  assertNonEmptyString(plugin.packageName, 'plugin.packageName')
  assertNonEmptyString(plugin.sourcePath, 'plugin.sourcePath')
  const digest = assertString(plugin.digest, 'plugin.digest')
  if (!SHA256_PATTERN.test(digest)) throw new Error('plugin.digest must be a sha256 digest')
}

function validateTargets(value: unknown): void {
  const targets = asRecord(value, 'targets')
  for (const [targetName, targetValue] of Object.entries(targets)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(targetName)) {
      throw new Error(`targets.${targetName} is not a safe target name`)
    }
    const target = asRecord(targetValue, `targets.${targetName}`)
    assertKnownKeys(target, ['dsh', 'commit', 'result'], `targets.${targetName}`)
    assertRequiredKeys(target, ['result'], `targets.${targetName}`)
    if (Object.hasOwn(target, 'dsh')) assertNonEmptyString(target.dsh, `targets.${targetName}.dsh`)
    if (Object.hasOwn(target, 'commit')) {
      assertNonEmptyString(target.commit, `targets.${targetName}.commit`)
    }
    assertOneOf(target.result, STEP_STATUSES, `targets.${targetName}.result`)
  }
}

function validateLab(value: unknown): void {
  const lab = asRecord(value, 'lab')
  assertExactKeys(lab, ['contextDigest'], 'lab')
  assertNonEmptyString(lab.contextDigest, 'lab.contextDigest')
}

function validateEnvironment(value: unknown): void {
  const environment = asRecord(value, 'environment')
  assertExactKeys(environment, ['node', 'pnpm', 'platform'], 'environment')
  assertNonEmptyString(environment.node, 'environment.node')
  assertNonEmptyString(environment.pnpm, 'environment.pnpm')
  assertOneOf(environment.platform, PLATFORMS, 'environment.platform')
}

function validateSteps(value: unknown): void {
  if (!Array.isArray(value)) throw new Error('steps must be an array')
  if (value.length > MAX_STEPS) throw new Error(`steps cannot contain more than ${MAX_STEPS} entries`)
  for (const [index, stepValue] of value.entries()) {
    const step = asRecord(stepValue, `steps[${index}]`)
    assertKnownKeys(step, ['id', 'status', 'durationMs', 'summary'], `steps[${index}]`)
    assertRequiredKeys(step, ['id', 'status', 'durationMs'], `steps[${index}]`)
    assertNonEmptyString(step.id, `steps[${index}].id`)
    assertOneOf(step.status, STEP_STATUSES, `steps[${index}].status`)
    if (typeof step.durationMs !== 'number' || !Number.isFinite(step.durationMs) || step.durationMs < 0) {
      throw new Error(`steps[${index}].durationMs must be a non-negative finite number`)
    }
    if (Object.hasOwn(step, 'summary')) {
      const summary = assertString(step.summary, `steps[${index}].summary`)
      if (Array.from(summary).length > MAX_SUMMARY_LENGTH) {
        throw new Error(`steps[${index}].summary exceeds ${MAX_SUMMARY_LENGTH} characters`)
      }
    }
  }
}

function sanitizeResult(result: VerifyRunResultV1): VerifyRunResultV1 {
  const steps = result.steps.map(step => {
    const storedStep: RunStepResult = {
      id: step.id,
      status: step.status,
      durationMs: step.durationMs,
    }
    if (step.summary !== undefined) storedStep.summary = sanitizeSummary(step.summary)
    return storedStep
  })
  return {
    schemaVersion: 1,
    runId: result.runId,
    operation: 'verify',
    result: result.result,
    plugin: {
      packageName: result.plugin.packageName,
      sourcePath: result.plugin.sourcePath,
      digest: result.plugin.digest,
    },
    targets: Object.fromEntries(
      Object.entries(result.targets).map(([name, target]) => [name, {
        ...(target.dsh === undefined ? {} : { dsh: target.dsh }),
        ...(target.commit === undefined ? {} : { commit: target.commit }),
        result: target.result,
      }]),
    ),
    lab: { contextDigest: result.lab.contextDigest },
    environment: {
      node: result.environment.node,
      pnpm: result.environment.pnpm,
      platform: result.environment.platform,
    },
    steps,
    cleanup: result.cleanup,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  }
}

function sanitizeSummary(summary: string): string {
  let sanitized = summary.replace(/\r\n?|\n/g, ' ')
  sanitized = sanitized.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{10,})\b/gi,
    '[REDACTED]',
  )
  sanitized = sanitized.replace(
    /\b(?:token|password|passwd|pwd|secret|api[-_]?key|access[-_]?token|authorization|private[-_]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '[REDACTED]',
  )
  sanitized = sanitized.replace(
    /\b[A-Z][A-Z0-9_]{1,}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/g,
    '[REDACTED]',
  )
  sanitized = sanitized.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
  return Array.from(sanitized).slice(0, MAX_SUMMARY_LENGTH).join('')
}

function normalizeSourcePath(sourcePath: string): string {
  const slashPath = sourcePath.trim().replaceAll('\\', '/')
  const drive = /^[A-Za-z]:/.exec(slashPath)?.[0] ?? ''
  const unc = slashPath.startsWith('//')
  const withoutDrive = drive ? slashPath.slice(2) : slashPath
  const absolute = withoutDrive.startsWith('/')
  const segments: string[] = []
  for (const segment of withoutDrive.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      const previous = segments.at(-1)
      if (previous && previous !== '..') segments.pop()
      else if (!absolute) segments.push(segment)
      continue
    }
    segments.push(segment)
  }
  const body = segments.join('/')
  if (drive) return `${drive.toLowerCase()}${body ? `/${body.toLowerCase()}` : '/'}`
  if (unc) return `//${body.toLowerCase()}`
  if (absolute) return `/${body}`
  return body || '.'
}

function sanitizePackageName(packageName: string): string {
  const fragment = packageName
    .trim()
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 64)
    .replace(/-+$/g, '')
  return fragment || 'plugin'
}

function validatePluginKey(pluginKey: string): void {
  if (!PLUGIN_KEY_PATTERN.test(pluginKey)) throw new Error(`Invalid plugin key: ${pluginKey}`)
}

function validateRunId(runId: string): void {
  const basename = runId.split('.')[0]!.toUpperCase()
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/
  if (
    !RUN_ID_PATTERN.test(runId) ||
    runId === '.' ||
    runId === '..' ||
    /[. ]$/.test(runId) ||
    reserved.test(basename)
  ) {
    throw new Error(`Invalid runId: ${runId}`)
  }
}

function validateTimestamp(value: unknown, field: string): void {
  const timestamp = assertString(value, field)
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) throw new Error(`${field} must be an ISO timestamp`)
}

function asRecord(value: unknown, field: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as RecordValue
}

function assertExactKeys(value: RecordValue, expected: readonly string[], field: string): void {
  assertKnownKeys(value, expected, field)
  assertRequiredKeys(value, expected, field)
}

function assertKnownKeys(value: RecordValue, expected: readonly string[], field: string): void {
  const allowed = new Set(expected)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unexpected field ${field}.${key}`)
  }
}

function assertRequiredKeys(value: RecordValue, expected: readonly string[], field: string): void {
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`Missing field ${field}.${key}`)
  }
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function assertNonEmptyString(value: unknown, field: string): string {
  const stringValue = assertString(value, field)
  if (!stringValue.trim() || stringValue.includes('\u0000')) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return stringValue
}

function assertOneOf<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new Error(`${field} has an invalid value`)
  }
  return value as T
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\u0000')
}

function isFileExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST'
}

function isNotFoundError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT'
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function assertSafeEvidencePath(runsRoot: string, candidate: string, label: string): void {
  const rootPath = resolve(runsRoot)
  const candidatePath = resolve(candidate)
  assertNoSymlinkComponents(rootPath, 'runsRoot')
  assertNoSymlinkComponents(candidatePath, label)

  if (!existsSync(rootPath)) return
  const realRoot = realpathSync(rootPath)
  const existingCandidate = nearestExistingPath(candidatePath)
  const realCandidate = realpathSync(existingCandidate)
  const outside = relative(realRoot, realCandidate)
  if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) {
    throw new Error(`${label} escapes runsRoot through a symlink or junction`)
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
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (isNotFoundError(error)) break
      throw error
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symlink or junction at ${current}`)
    }
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
  const leftFolded = left.toLowerCase()
  const rightFolded = right.toLowerCase()
  const foldedComparison = compareCodePointStrings(leftFolded, rightFolded)
  return foldedComparison || compareCodePointStrings(left, right)
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

function removeTemporary(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // Preserve the publication error; cleanup is best effort.
  }
}

function removeLock(path: string): Error | undefined {
  try {
    rmSync(path, { recursive: true, force: true })
    return undefined
  } catch {
    return new Error(
      `Publication lock ${path} could not be removed; it may be orphaned. ` +
        'Confirm no publisher is active, then remove the lock and retry.',
    )
  }
}

function corruptionError(path: string, cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new Error(`Corrupt finalized evidence at ${path}: ${message}`)
}
