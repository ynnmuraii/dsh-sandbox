import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildDevOverlay,
  buildProfilePackageJson,
  buildProfileWorkspaceYaml,
  DEV_WEB_BUNDLES,
  resolveUiLauncher,
} from './run.js'
import { ROOT_PATHS, rootPath } from './context.js'
import { loadCompatibilityFromFile, type Compatibility } from './schemas.js'
import { assertRuntimePluginIdentity } from './runtime-identity.js'
import { pnpmAsync } from './proc.js'

export interface UiRuntimePlan {
  sessionDir: string
  runtimeHome: string
  profileName: string
  profileDir: string
  overlayPath: string
  launcher: { cmd: string; args: string[] }
  argv: string[]
  cwd: string
}

export interface UiRuntimePlugin {
  packageName: string
  sourcePath: string
  runtimeName: string
}

export interface UiRuntimeDependencies {
  loadCompatibility(path: string): Compatibility
  resolveLauncher(root: string, target: 'next' | 'master', compatibility: Compatibility, signal?: AbortSignal): Promise<{ cmd: string; args: string[] }>
  installNextProfile(profileDir: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): void | Promise<void>
}

const SESSION_ID_PATTERN = /^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$/

export async function prepareUiRuntime(
  opts: { root: string; plugin: UiRuntimePlugin; target: 'next' | 'master'; sessionId: string; signal?: AbortSignal },
  deps: UiRuntimeDependencies = defaultDependencies(),
): Promise<UiRuntimePlan> {
  validateOptions(opts)
  const signal = opts.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const root = resolve(opts.root)
  const sourcePath = resolve(opts.plugin.sourcePath)
  const sourceEntry = resolve(sourcePath, 'src', 'index.ts')
  const sourceRoot = resolve(sourcePath, 'src')
  if (!existsSync(sourceEntry) || !regularFile(sourceEntry)) throw new Error(`plugin source entry not found: ${sourceEntry}`)
  if (!existsSync(sourceRoot) || !directory(sourceRoot)) throw new Error(`plugin source root not found: ${sourceRoot}`)

  const compatibilityPath = rootPath(root, ROOT_PATHS.compatibility)
  const compatibility = deps.loadCompatibility(compatibilityPath)
  const targetPin = compatibility.targets[opts.target]
  if (!targetPin) throw new Error(`compatibility manifest has no ${opts.target} target`)
  if (opts.target === 'next' && !targetPin.dsh) throw new Error('next target requires a pinned dsh version')
  if (opts.target === 'master' && !targetPin.commit) throw new Error('master target requires a pinned commit')

  const sessionDir = join(root, ROOT_PATHS.runtime, 'ui-sessions', opts.sessionId)
  const runtimeHome = join(sessionDir, 'home')
  const profileName = `${opts.plugin.runtimeName}-${opts.target}-ui-${opts.sessionId}`
  const profileDir = join(runtimeHome, 'profiles', profileName)
  const overlayDir = join(sessionDir, 'overlay')
  const overlayPath = join(overlayDir, 'cordis.patch.yml')
  assertContained(root, sessionDir, 'UI runtime session directory')
  assertNoSymlinkComponents(root, 'forge root')
  assertNoSymlinkComponents(sessionDir, 'UI runtime session directory')

  mkdirChecked(sessionDir, 'UI runtime session directory')
  mkdirChecked(runtimeHome, 'UI runtime home')
  mkdirChecked(join(runtimeHome, 'profiles'), 'UI runtime profiles directory')
  mkdirChecked(profileDir, 'UI runtime profile directory')
  mkdirChecked(overlayDir, 'UI runtime overlay directory')
  assertNoSymlinkComponents(sourcePath, 'plugin source path')

  const overlay = buildDevOverlay(
    opts.plugin.runtimeName,
    pathToFileURL(sourceEntry).href,
    sourceRoot,
  )
  writeFileSync(overlayPath, overlay, { encoding: 'utf8', flag: 'wx', mode: 0o600 })

  signal.throwIfAborted()
  const launcher = await deps.resolveLauncher(root, opts.target, compatibility, signal)
  if (!launcher || typeof launcher.cmd !== 'string' || !Array.isArray(launcher.args)) throw new Error('launcher resolver returned an invalid command')
  const upstream = rootPath(root, ROOT_PATHS.upstream)
  const dsh = opts.target === 'next'
    ? targetPin.dsh!
    : `file:${relative(profileDir, upstream).replace(/\\/g, '/')}`
  const manifest = buildProfilePackageJson({
    name: `@dsh-lab/profile-${profileName}`,
    bundles: DEV_WEB_BUNDLES,
  }, { dsh })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), buildProfileWorkspaceYaml(targetPin.allowBuilds ?? {}), { encoding: 'utf8', flag: 'wx', mode: 0o600 })

  const plan: UiRuntimePlan = {
    sessionDir,
    runtimeHome,
    profileName,
    profileDir,
    overlayPath,
    launcher: { cmd: launcher.cmd, args: [...launcher.args] },
    argv: [
      ...launcher.args,
      '--profile', profileName,
      '--patch', overlayPath,
      '--host', '127.0.0.1',
      '--port', '0',
      '--no-open',
    ],
    cwd: profileDir,
  }
  if (opts.target === 'next') await deps.installNextProfile(profileDir, buildUiRuntimeEnvironment(plan), signal)
  return plan
}

export function buildUiRuntimeEnvironment(plan: UiRuntimePlan, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!plan || typeof plan.runtimeHome !== 'string' || !plan.runtimeHome) throw new Error('invalid UI runtime plan')
  return { ...inherited, DSH_HOME: plan.runtimeHome }
}

function defaultDependencies(): UiRuntimeDependencies {
  return {
    loadCompatibility: loadCompatibilityFromFile,
    resolveLauncher: (root, target, compatibility, signal) => resolveUiLauncher(root, target, compatibility, signal),
    installNextProfile: async (profileDir, env, signal) => {
      if (signal === undefined) throw new Error('UI profile installation requires an AbortSignal')
      await pnpmAsync(['install', '--config.strictDepBuilds=false'], { cwd: profileDir, env, signal })
    },
  }
}

function validateOptions(opts: { root: string; plugin: UiRuntimePlugin; target: 'next' | 'master'; sessionId: string }): void {
  if (!opts || typeof opts.root !== 'string' || !opts.root.trim()) throw new Error('root must be a non-empty path')
  if (!opts.plugin || typeof opts.plugin !== 'object') throw new Error('plugin is required')
  assertRuntimePluginIdentity(opts.plugin.runtimeName)
  if (typeof opts.plugin.packageName !== 'string' || !opts.plugin.packageName.trim()) throw new Error('plugin packageName must be non-empty')
  if (typeof opts.plugin.sourcePath !== 'string' || !opts.plugin.sourcePath.trim()) throw new Error('plugin sourcePath must be non-empty')
  if (opts.target !== 'next' && opts.target !== 'master') throw new Error('invalid target')
  if (typeof opts.sessionId !== 'string' || !SESSION_ID_PATTERN.test(opts.sessionId)) throw new Error(`invalid or unsafe sessionId ${JSON.stringify(opts.sessionId)}`)
}

function assertContained(root: string, candidate: string, label: string): void {
  const outside = relative(resolve(root), resolve(candidate))
  if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) throw new Error(`${label} escapes forge root`)
}
function assertNoSymlinkComponents(path: string, label: string): void {
  const absolute = resolve(path)
  const root = parseRoot(absolute)
  let current = root
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component)
    let stat
    try { stat = lstatSync(current) } catch (error) {
      if (isNotFound(error)) break
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink or junction at ${current}`)
  }
}
function mkdirChecked(path: string, label: string): void {
  const existing = entry(path)
  if (existing !== undefined && (existing.isSymbolicLink() || !existing.isDirectory())) throw new Error(`${label} is not a regular directory at ${path}`)
  mkdirSync(path, { recursive: true })
  const result = entry(path)
  if (!result || result.isSymbolicLink() || !result.isDirectory()) throw new Error(`${label} is not a regular directory at ${path}`)
}
function entry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path) } catch (error) { if (isNotFound(error)) return undefined; throw error }
}
function regularFile(path: string): boolean { const stat = entry(path); return stat !== undefined && stat.isFile() && !stat.isSymbolicLink() }
function directory(path: string): boolean { const stat = entry(path); return stat !== undefined && stat.isDirectory() && !stat.isSymbolicLink() }
function parseRoot(path: string): string { return path.match(/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/)?.[0] ?? resolve(path, '..', '..', '..') }
function isNotFound(error: unknown): boolean { return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT' }
