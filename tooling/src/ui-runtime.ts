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
import { clientBundleRequirement } from './client-smoke.js'
import type { OwnedUiDirectory, UiDirectoryIdentity } from './ui-owned-directory.js'
export interface UiRuntimeRetainedIdentities {
  runtimeHome: UiDirectoryIdentity
  profileDir: UiDirectoryIdentity
  overlayDir?: UiDirectoryIdentity
  overlayFile?: UiDirectoryIdentity
}
export interface UiRuntimePlan {
  sessionDir: string
  runtimeHome: string
  profileName: string
  profileDir: string
  overlayPath?: string
  launcher: { cmd: string; args: string[] }
  argv: string[]
  cwd: string
  retained?: UiRuntimeRetainedIdentities
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
  beforeRuntimeMutation?(operation: UiRuntimeMutation, path: string): void
}

export type UiRuntimeMutation =
  | 'session-dir' | 'runtime-home' | 'profiles-dir' | 'profile-dir' | 'overlay-dir'
  | 'overlay-write' | 'manifest-write' | 'workspace-write' | 'launcher-resolve' | 'profile-install'

const SESSION_ID_PATTERN = /^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$/

export async function prepareUiRuntime(
  opts: { root: string; plugin: UiRuntimePlugin; target: 'next' | 'master'; sessionId: string; signal?: AbortSignal; ownedSession?: OwnedUiDirectory },
  deps: UiRuntimeDependencies = defaultDependencies(),
): Promise<UiRuntimePlan & { retained: UiRuntimeRetainedIdentities }> {
  validateOptions(opts)
  const signal = opts.signal ?? new AbortController().signal
  signal.throwIfAborted()
  const root = resolve(opts.root)
  const sourcePath = resolve(opts.plugin.sourcePath)
  const sourceEntry = resolve(sourcePath, 'src', 'index.ts')
  const sourceRoot = resolve(sourcePath, 'src')
  if (!existsSync(sourceEntry) || !regularFile(sourceEntry)) throw new Error(`plugin source entry not found: ${sourceEntry}`)
  if (!existsSync(sourceRoot) || !directory(sourceRoot)) throw new Error(`plugin source root not found: ${sourceRoot}`)

  // Dual-face detection reuses the verify pipeline's client-smoke helper, so
  // malformed dsh.client shapes fail here before any filesystem mutation. A
  // plugin without package.json simply has no browser face (source mode); a
  // present-but-unparseable manifest is a loud error.
  let rawManifest: unknown = {}
  if (regularFile(join(sourcePath, 'package.json'))) {
    try {
      rawManifest = JSON.parse(readFileSync(join(sourcePath, 'package.json'), 'utf8'))
    } catch (cause) {
      throw new Error(`failed to parse plugin package.json at ${join(sourcePath, 'package.json')}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  // clientBundleRequirement throws on malformed dsh.client — surfaced before
  // any mutation so callers get a loud, actionable error.
  const requirement = clientBundleRequirement(rawManifest)
  const bundleMode = requirement.required
  const bundlePackageName = requirement.packageName || opts.plugin.packageName

  if (bundleMode) {
    // Bundle-mode UI sessions boot the built artifacts through a file: dependency
    // and the web bundle set. Both entry points must be regular non-symlink
    // files; the instructive message points the user at `pnpm build`.
    const libClient = join(sourcePath, 'lib', 'client.js')
    const libIndex = join(sourcePath, 'lib', 'index.js')
    if (!regularFile(libClient)) throw new Error(`bundle-mode UI session requires a built plugin: run pnpm build in ${sourcePath} first (missing ${libClient})`)
    if (!regularFile(libIndex)) throw new Error(`bundle-mode UI session requires a built plugin: run pnpm build in ${sourcePath} first (missing ${libIndex})`)
  }

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
  const overlayDir = bundleMode ? undefined : join(sessionDir, 'overlay')
  const overlayPath = bundleMode ? undefined : join(sessionDir, 'overlay', 'cordis.patch.yml')
  assertContained(root, sessionDir, 'UI runtime session directory')
  assertNoSymlinkComponents(root, 'forge root')
  assertNoSymlinkComponents(sessionDir, 'UI runtime session directory')

  runtimeMutation(opts, deps, 'session-dir', sessionDir, () => mkdirChecked(sessionDir, 'UI runtime session directory'))
  runtimeMutation(opts, deps, 'runtime-home', runtimeHome, () => mkdirChecked(runtimeHome, 'UI runtime home'))
  runtimeMutation(opts, deps, 'profiles-dir', join(runtimeHome, 'profiles'), () => mkdirChecked(join(runtimeHome, 'profiles'), 'UI runtime profiles directory'))
  runtimeMutation(opts, deps, 'profile-dir', profileDir, () => mkdirChecked(profileDir, 'UI runtime profile directory'))
  if (!bundleMode) {
    runtimeMutation(opts, deps, 'overlay-dir', overlayDir!, () => mkdirChecked(overlayDir!, 'UI runtime overlay directory'))
  }
  assertNoSymlinkComponents(sourcePath, 'plugin source path')

  if (!bundleMode) {
    const overlay = buildDevOverlay(
      opts.plugin.runtimeName,
      pathToFileURL(sourceEntry).href,
      sourceRoot,
    )
    runtimeMutation(opts, deps, 'overlay-write', overlayPath!, () => writeFileSync(overlayPath!, overlay, { encoding: 'utf8', flag: 'wx', mode: 0o600 }))
  }

  signal.throwIfAborted()
  opts.ownedSession?.assertCurrent()
  deps.beforeRuntimeMutation?.('launcher-resolve', sessionDir)
  opts.ownedSession?.assertCurrent()
  const launcher = await deps.resolveLauncher(root, opts.target, compatibility, signal)
  opts.ownedSession?.assertCurrent()
  if (!launcher || typeof launcher.cmd !== 'string' || !Array.isArray(launcher.args)) throw new Error('launcher resolver returned an invalid command')
  const upstream = rootPath(root, ROOT_PATHS.upstream)
  const dsh = opts.target === 'next'
    ? targetPin.dsh!
    : `file:${relative(profileDir, upstream).replace(/\\/g, '/')}`
  // Bundle-mode composes through a file: dependency and the web bundle set.
  // The plugin's own dsh.bundle.patch cordis.patch.yml contributes its loader
  // row — the plugin package name becomes entry.options.name, exactly what the
  // upstream client module system resolves for the browser face. No overlay is
  // written and no --patch is passed.
  const manifest = bundleMode
    ? buildProfilePackageJson({
        name: `@dsh-lab/profile-${profileName}`,
        bundles: [...DEV_WEB_BUNDLES, bundlePackageName],
        dependencies: { [bundlePackageName]: `file:${relative(profileDir, sourcePath).replace(/\\/g, '/')}` },
      }, { dsh })
    : buildProfilePackageJson({
        name: `@dsh-lab/profile-${profileName}`,
        bundles: DEV_WEB_BUNDLES,
      }, { dsh })
  runtimeMutation(opts, deps, 'manifest-write', join(profileDir, 'package.json'), () => writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }))
  runtimeMutation(opts, deps, 'workspace-write', join(profileDir, 'pnpm-workspace.yaml'), () => writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), buildProfileWorkspaceYaml(targetPin.allowBuilds ?? {}), { encoding: 'utf8', flag: 'wx', mode: 0o600 }))

  const baseArgv = bundleMode
    ? [...launcher.args, '--profile', profileName, '--host', '127.0.0.1', '--port', '0', '--no-open']
    : [...launcher.args, '--profile', profileName, '--patch', overlayPath!, '--host', '127.0.0.1', '--port', '0', '--no-open']
  const plan: UiRuntimePlan & { retained: UiRuntimeRetainedIdentities } = {
    sessionDir,
    runtimeHome,
    profileName,
    profileDir,
    // Source-mode plans carry the overlay path (callers branch on its
    // presence); bundle-mode plans boot the plugin's own bundle layer.
    ...(overlayPath === undefined ? {} : { overlayPath }),
    launcher: { cmd: launcher.cmd, args: [...launcher.args] },
    argv: baseArgv,
    cwd: profileDir,
    retained: {
      runtimeHome: identityOf(runtimeHome),
      profileDir: identityOf(profileDir),
      ...(bundleMode ? {} : { overlayDir: identityOf(overlayDir!), overlayFile: identityOf(overlayPath!) }),
    },
  }
  if (opts.target === 'next') {
    opts.ownedSession?.assertCurrent()
    assertMutationTarget(profileDir, 'profile-install')
    deps.beforeRuntimeMutation?.('profile-install', profileDir)
    opts.ownedSession?.assertCurrent()
    assertMutationTarget(profileDir, 'profile-install')
    await deps.installNextProfile(profileDir, buildUiRuntimeEnvironment(plan), signal)
    opts.ownedSession?.assertCurrent()
    assertMutationTarget(profileDir, 'profile-install')
    plan.retained = {
      runtimeHome: identityOf(runtimeHome),
      profileDir: identityOf(profileDir),
      ...(bundleMode ? {} : { overlayDir: identityOf(overlayDir!), overlayFile: identityOf(overlayPath!) }),
    }
  }
  return plan
}

export function assertUiRuntimePlanRetained(plan: UiRuntimePlan): void {
  const rawRetained: unknown = plan.retained
  const retained = rawRetained as UiRuntimeRetainedIdentities | undefined
  // In bundle-mode the overlay is absent — overlayPath and retained overlay
  // identities are optional. Skip those checks when the plan has no overlay.
  const entries: Array<[string, string | undefined, UiDirectoryIdentity | undefined]> = [
    ['runtimeHome', plan.runtimeHome, retained?.runtimeHome],
    ['profileDir', plan.profileDir, retained?.profileDir],
    ['overlayDir', plan.overlayPath ? join(plan.sessionDir, 'overlay') : undefined, retained?.overlayDir],
    ['overlayFile', plan.overlayPath, retained?.overlayFile],
  ]
  for (const [anchor, path, expected] of entries) {
    if (path === undefined || expected === undefined) {
      // Tolerate absent overlay in bundle-mode: undefined overlayFile means the
      // overlay was never materialized and must not be asserted.
      if (anchor === 'overlayDir' || anchor === 'overlayFile') continue
      throw new Error(`runtime plan retained.${anchor} is invalid`)
    }
    if (typeof expected.dev !== 'number' || typeof expected.ino !== 'number') throw new Error(`runtime plan retained.${anchor} is invalid`)
    assertNoSymlinkComponents(path, `retained ${anchor}`)
    let current
    try {
      current = lstatSync(path)
    } catch (error) {
      throw new Error(`retained ${anchor} identity unavailable at ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (current.isSymbolicLink()) throw new Error(`retained ${anchor} identity changed at ${path}: symlink or junction`)
    if (current.dev !== expected.dev || current.ino !== expected.ino) throw new Error(`retained ${anchor} identity changed at ${path}: expected dev ${expected.dev} ino ${expected.ino} but got dev ${current.dev} ino ${current.ino}`)
  }
}

function identityOf(path: string): UiDirectoryIdentity {
  const stat = lstatSync(path)
  return { dev: stat.dev, ino: stat.ino }
}

function runtimeMutation(
  opts: { ownedSession?: OwnedUiDirectory },
  deps: UiRuntimeDependencies,
  operation: UiRuntimeMutation,
  path: string,
  mutation: () => void,
): void {
  opts.ownedSession?.assertCurrent()
  assertMutationTarget(path, operation)
  deps.beforeRuntimeMutation?.(operation, path)
  opts.ownedSession?.assertCurrent()
  assertMutationTarget(path, operation)
  mutation()
  opts.ownedSession?.assertCurrent()
}

function assertMutationTarget(path: string, operation: UiRuntimeMutation): void {
  assertNoSymlinkComponents(path, `UI runtime ${operation} path`)
  const parent = resolve(path, '..')
  const stat = entry(parent)
  if (stat !== undefined && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new Error(`UI runtime ${operation} parent is not a regular directory at ${parent}`)
  }
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
