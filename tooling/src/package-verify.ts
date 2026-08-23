import { dump as dumpYaml, load as loadYaml } from 'js-yaml'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, win32 } from 'node:path'
import { pnpm, type RunOpts } from './proc.js'
import type { RunStepResult } from './evidence.js'

export interface PackageVerifyResult {
  tarball: string
  steps: RunStepResult[]
}

export interface PackageVerifyRunner {
  pnpm(args: string[], opts: RunOpts & { cwd: string }): string | Buffer
}

const STEP_IDS = ['install', 'typecheck', 'test', 'build', 'pack', 'pack-smoke'] as const
type StepId = (typeof STEP_IDS)[number]

interface WorkspacePolicy {
  [key: string]: unknown
  allowBuilds?: Record<string, unknown>
}

/**
 * Run the package-owned checks in an isolated/staged workspace.
 *
 * All validation that can be done without side effects happens before the
 * workspace policy is rewritten or pnpm is invoked. Commands are always sent
 * as argument arrays through the Windows-safe pnpm helper.
 */
export function verifyPackageInWorkspace(opts: {
  workspacePath: string
  allowBuilds: Record<string, boolean>
  runner?: PackageVerifyRunner
}): PackageVerifyResult {
  const steps = createSteps()
  const runner = opts.runner ?? { pnpm }
  let workspacePath: string
  let tarball = ''

  try {
    workspacePath = resolve(opts.workspacePath)
    validatePrerequisites(workspacePath, opts.allowBuilds)
    const policyPath = resolve(workspacePath, 'pnpm-workspace.yaml')
    const policy = mergeWorkspacePolicy(
      readFileSync(policyPath, 'utf8'),
      opts.allowBuilds,
    )

    // This is the only mutation performed by this verifier, and it is confined
    // to the copied workspace supplied by the caller.
    writeFileSync(policyPath, dumpYaml(policy, { noRefs: true }))
  } catch (error) {
    throw attachPrerequisiteSteps(error, steps)
  }

  try {
    runStep(steps, 'install', () => {
      runner.pnpm(['install', '--ignore-workspace', '--frozen-lockfile'], { cwd: workspacePath })
    })
    runStep(steps, 'typecheck', () => {
      runner.pnpm(['typecheck'], { cwd: workspacePath })
    })
    runStep(steps, 'test', () => {
      runner.pnpm(['test'], { cwd: workspacePath })
    })
    runStep(steps, 'build', () => {
      runner.pnpm(['build'], { cwd: workspacePath })
    })
    runStep(steps, 'pack', () => {
      const output = runner.pnpm(['pack', '--json'], {
        cwd: workspacePath,
        encoding: 'utf8',
      })
      // Deliberately parse this command's output exactly once. Besides making
      // malformed output a clear step failure, this avoids accepting one path
      // during validation and using a different one during pack-smoke.
      tarball = resolvePackedTarball(workspacePath, parsePackOutput(output))
    })
    runStep(steps, 'pack-smoke', () => {
      runner.pnpm(['pack-smoke', tarball], { cwd: workspacePath })
    })
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    Object.defineProperty(failure, 'steps', {
      configurable: true,
      enumerable: false,
      value: steps,
      writable: false,
    })
    throw failure
  }

  return { tarball, steps }
}

function validatePrerequisites(
  workspacePath: string,
  allowBuilds: Record<string, boolean>,
): void {
  if (!statIsDirectory(workspacePath)) {
    throw new Error(`package verification workspace is not a directory: ${workspacePath}`)
  }

  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json']) {
    const path = resolve(workspacePath, file)
    if (!existsSync(path) || !statIsFile(path)) {
      const label = file === 'pnpm-lock.yaml' ? 'lockfile' : file === 'pnpm-workspace.yaml' ? 'workspace boundary' : file
      throw new Error(`package verification workspace is missing ${label} (${file})`)
    }
  }

  const packagePath = resolve(workspacePath, 'package.json')
  let manifest: { scripts?: Record<string, unknown> }
  try {
    manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, unknown> }
  } catch (error) {
    throw new Error(`invalid package.json: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('package.json must contain an object')
  }
  if (!manifest.scripts || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)) {
    throw new Error('package.json must define scripts')
  }
  for (const script of ['typecheck', 'test', 'build', 'pack-smoke']) {
    if (typeof manifest.scripts[script] !== 'string' || manifest.scripts[script].trim() === '') {
      throw new Error(`package.json is missing required ${script} script`)
    }
  }

  validateAllowBuilds(allowBuilds)
  try {
    const parsed = loadYaml(readFileSync(resolve(workspacePath, 'pnpm-workspace.yaml'), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('pnpm-workspace.yaml must contain a mapping')
    }
    if (!Array.isArray((parsed as Record<string, unknown>).packages)) {
      throw new Error('pnpm-workspace.yaml is missing its packages workspace boundary')
    }
    validateExistingAllowBuilds((parsed as WorkspacePolicy).allowBuilds)
  } catch (error) {
    if (error instanceof Error && /workspace boundary|mapping|allowBuilds/.test(error.message)) throw error
    throw new Error(
      `invalid pnpm-workspace.yaml: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

function mergeWorkspacePolicy(text: string, allowBuilds: Record<string, boolean>): WorkspacePolicy {
  const parsed = loadYaml(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pnpm-workspace.yaml must contain a mapping')
  }
  const policy = { ...(parsed as Record<string, unknown>) } as WorkspacePolicy
  // Target policy is authoritative. Source-owned permissions are validated
  // during preflight but never carried into the staged workspace.
  const merged: Record<string, boolean> = Object.create(null) as Record<string, boolean>
  for (const [name, value] of Object.entries(allowBuilds)) merged[name] = value
  policy.allowBuilds = Object.fromEntries(
    Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)),
  )
  return policy
}

function validateAllowBuilds(allowBuilds: Record<string, boolean>): void {
  if (!allowBuilds || typeof allowBuilds !== 'object' || Array.isArray(allowBuilds)) {
    throw new Error('allowBuilds must be a package-to-boolean map')
  }
  for (const [name, value] of Object.entries(allowBuilds)) {
    validateAllowBuildsKey(name)
    if (typeof value !== 'boolean') throw new Error(`allowBuilds.${name} must be boolean true or false`)
  }
}

function validateExistingAllowBuilds(values: Record<string, unknown> | undefined): void {
  if (values === undefined) return
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new Error('pnpm-workspace.yaml allowBuilds must be a package-to-boolean map')
  }
  for (const [name, value] of Object.entries(values)) {
    validateAllowBuildsKey(name)
    if (typeof value !== 'boolean') {
      throw new Error(`pnpm-workspace.yaml allowBuilds.${name} must be boolean true or false`)
    }
  }
}

function validateAllowBuildsKey(name: string): void {
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    throw new Error(`allowBuilds.${name} is an unsafe package name/key`)
  }
}

function createSteps(): RunStepResult[] {
  return STEP_IDS.map(id => ({
    id,
    status: 'skipped',
    durationMs: 0,
  }))
}

function attachPrerequisiteSteps(error: unknown, steps: RunStepResult[]): Error {
  const failure = error instanceof Error ? error : new Error(String(error))
  const install = steps.find(step => step.id === 'install')!
  install.status = 'blocked'
  install.summary = sanitizeSummary(failure.message)
  Object.defineProperty(failure, 'steps', {
    configurable: true,
    enumerable: false,
    value: steps,
    writable: false,
  })
  return failure
}

function statIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function runStep(steps: RunStepResult[], id: StepId, operation: () => void): void {
  const step = steps.find(candidate => candidate.id === id)!
  const started = process.hrtime.bigint()
  try {
    operation()
    step.status = 'pass'
  } catch (error) {
    step.status = 'fail'
    step.summary = sanitizeSummary(error instanceof Error ? error.message : String(error))
    step.durationMs = elapsedMs(started)
    const failure = new Error(`package verification step '${id}' failed: ${step.summary}`, {
      cause: error,
    })
    throw failure
  }
  step.durationMs = elapsedMs(started)
}

function elapsedMs(started: bigint): number {
  const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0
}

function parsePackOutput(output: string | Buffer): unknown {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : output
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`pnpm pack --json produced invalid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

function resolvePackedTarball(workspacePath: string, parsed: unknown): string {
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('pnpm pack --json produced no tarball; it must produce exactly one tarball result')
  }
  const entry = parsed[0]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('pnpm pack --json produced no tarball')
  }
  const keys = Object.keys(entry)
  if (keys.length !== 1 || keys[0] !== 'filename') {
    throw new Error('pnpm pack --json produced a malformed tarball result')
  }
  const filename = (entry as { filename?: unknown }).filename
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('pnpm pack --json produced no tarball filename')
  }
  if (isAbsolute(filename) || win32.isAbsolute(filename) || /^[A-Za-z]:/.test(filename)) {
    throw new Error('packed tarball path is absolute and outside workspace')
  }
  let depth = 0
  for (const segment of filename.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (depth === 0) throw new Error('packed tarball path escapes or is outside workspace')
      depth -= 1
    } else {
      depth += 1
    }
  }
  const tarball = resolve(workspacePath, filename)
  const child = relative(workspacePath, tarball)
  if (!child || child === '..' || child.startsWith(`..${'\\'}`) || child.startsWith(`..${'/'}`) || isAbsolute(child)) {
    throw new Error('packed tarball path escapes or is outside workspace')
  }
  assertTarballInsideWorkspace(workspacePath, tarball)
  return tarball
}

function assertTarballInsideWorkspace(workspacePath: string, tarball: string): void {
  let workspaceReal: string
  let tarballReal: string
  try {
    const workspaceStat = lstatSync(workspacePath)
    if (workspaceStat.isSymbolicLink()) {
      throw new Error('workspace path is a symlink or junction')
    }
    workspaceReal = realpathSync(workspacePath)
    const relativeTarball = relative(workspacePath, tarball)
    let current = workspacePath
    for (const component of relativeTarball.split(/[\\/]+/).filter(Boolean)) {
      current = resolve(current, component)
      const componentStat = lstatSync(current)
      if (componentStat.isSymbolicLink()) {
        throw new Error(`packed tarball path contains a symlink or junction: ${current}`)
      }
      if (current !== tarball && !componentStat.isDirectory()) {
        throw new Error(`packed tarball path component is not a directory: ${current}`)
      }
    }
    const tarballStat = lstatSync(tarball)
    if (tarballStat.isSymbolicLink() || !tarballStat.isFile()) {
      throw new Error(`packed tarball is not a regular file: ${tarball}`)
    }
    tarballReal = realpathSync(tarball)
  } catch (error) {
    if (error instanceof Error && /^(workspace path|packed tarball)/.test(error.message)) throw error
    throw new Error(`packed tarball was not found or is not a regular file: ${tarball}`, { cause: error })
  }
  const resolvedChild = relative(workspaceReal, tarballReal)
  if (
    !resolvedChild ||
    resolvedChild === '..' ||
    resolvedChild.startsWith(`..${'\\'}`) ||
    resolvedChild.startsWith(`..${'/'}`) ||
    isAbsolute(resolvedChild) ||
    win32.isAbsolute(resolvedChild)
  ) {
    throw new Error('packed tarball real path escapes or is outside workspace')
  }
}

function sanitizeSummary(summary: string): string {
  let sanitized = summary.replace(/\r\n?|\n/g, ' ')
  sanitized = sanitized.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9_]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{10,})\b/gi,
    '[REDACTED]',
  )
  sanitized = sanitized.replace(
    /\b([A-Za-z][A-Za-z0-9_-]*)\b\s*([:=])\s*(?:"[^"]*"|'[^']*'|Bearer\s+[^\s,;]+|[^\s,;]+)/g,
    (match: string, key: string, separator: string) =>
      isSensitiveAssignmentKey(key) ? `${key}${separator}[REDACTED]` : match,
  )
  sanitized = sanitized.replace(
    /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]*)@/g,
    '$1[REDACTED]:[REDACTED]@',
  )
  sanitized = sanitized.replace(
    /([?&](?:access[_-]?key|api[_-]?key|credential|password|secret|token)[^=\s]*=)[^&#\s]+/gi,
    '$1[REDACTED]',
  )
  sanitized = sanitized.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
  return Array.from(sanitized).slice(0, 500).join('')
}

function isSensitiveAssignmentKey(key: string): boolean {
  const components = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_-]+/)
    .filter(Boolean)
    .map(component => component.toLowerCase())
  const sensitive = new Set([
    'password', 'passwd', 'pwd', 'secret', 'token', 'authorization', 'credential', 'credentials',
  ])
  return components.some(component => sensitive.has(component)) ||
    (components.includes('api') && components.includes('key')) ||
    (components.includes('private') && components.includes('key')) ||
    (components.includes('access') && components.includes('key'))
}
