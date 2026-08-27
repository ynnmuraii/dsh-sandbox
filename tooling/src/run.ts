import { join, relative, resolve, sep } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, rmSync, renameSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  loadCompatibilityFromFile,
  CompatibilityError,
  type Compatibility,
} from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'
import { verifyUpstreamCommit } from './upstream.js'
import { pnpm, pnpmAsync, pnpmCommand } from './proc.js'
import { resolvePluginRef, type PluginRef } from './plugin-ref.js'
import { verifyPlugin } from './verify.js'
import { assertRuntimePluginIdentity } from './runtime-identity.js'
import { sanitizeSummary } from './evidence.js'
import type { LabErrorCode } from './evidence.js'

export interface ProfileSpec {
  name: string
  bundles: string[]
  dependencies?: Record<string, string>
}

export interface DevOptions {
  root: string
  name: string
  target: 'next' | 'master'
}

export interface DevPluginOptions {
  root: string
  plugin: PluginRef
  target: 'next' | 'master'
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

export interface VerifyOptions {
  root: string
  name: string
  target: 'next' | 'master' | 'all'
  masterBin?: string
}

export function profileName(
  name: string,
  target: Target,
  kind: 'dev' | 'verify',
  runId?: string,
): string {
  assertRuntimePluginIdentity(name)
  if (kind === 'dev') return `${name}-${target}-dev`
  if (!runId) throw new Error('verify profiles require a run id')
  return `${name}-${target}-verify-${runId}`
}

export function buildProfileWorkspaceYaml(allowBuilds: Record<string, boolean>): string {
  const lines = ['packages:', '  - "."']
  const entries = Object.entries(allowBuilds).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length > 0) {
    lines.push('allowBuilds:')
    for (const [name, allowed] of entries) lines.push(`  ${name}: ${allowed ? 'true' : 'false'}`)
  }
  return `${lines.join('\n')}\n`
}

export function resolveTsxLoader(): string {
  return import.meta.resolve('tsx/esm')
}

const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base']
// The shipped Web surface: base plus the web-app bundle (windows-shell.spec /
// web-agent-presets.e2e in upstream declare exactly these two). `lab dev`
// materializes a profile with these so booting it by name (`--profile
// <name>-<target>`) is a REAL web composition — not the base bundle alone.
export const DEV_WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const TARGETS = ['next', 'master'] as const
type Target = (typeof TARGETS)[number]

interface Command {
  cmd: string
  args: string[]
}

// Resolve the source entry as a file URL. Cordis Loader passes plugin names to
// dynamic import(), so a Windows drive path must not be emitted as a bare URL
// with an unsupported `A:` scheme.
export function resolveSourceOverlay(
  root: string,
  pluginRel: string,
  entryRel: string,
  name: string,
): string {
  return pathToFileURL(resolve(root, pluginRel, entryRel)).href
}

// Build a workbench profile package.json, pinning the dsh launcher to an exact
// version that `lab dev`/`lab verify` substitute at runtime. When `dsh` is
// omitted the manifest carries no launcher dependency at all — the master
// target composes against the built upstream bin directly rather than a
// profile-local install.
export function buildProfilePackageJson(
  spec: ProfileSpec,
  pin: { dsh?: string },
): {
  name: string
  private: true
  type: 'module'
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
} {
  const manifest = {
    name: spec.name,
    private: true as const,
    type: 'module' as const,
    dependencies: {} as Record<string, string>,
    dsh: {
      profile: {
        bundles: spec.bundles,
      },
    },
  }
  if (spec.dependencies) {
    for (const [dep, version] of Object.entries(spec.dependencies)) {
      manifest.dependencies[dep] = version
    }
  }
  if (pin.dsh !== undefined) {
    manifest.dependencies['@deepseek-ai/dsh'] = pin.dsh
  }
  return manifest
}

// Render the cordis source-overlay YAML for a plugin entry. The entry path is
// normalized to forward slashes and embedded in a single-quoted YAML scalar,
// where an apostrophe is escaped by DOUBLING it (YAML has no backslash escape
// inside single-quoted scalars).
export function buildSourceOverlay(name: string, entryPath: string): string {
  const entry = entryPath.replace(/\\/g, '/').replace(/'/g, "''")
  return ['', '- insert:', `    - id: ${name}`, `      name: '${entry}'`, ''].join('\n')
}

// Render the full source-dev overlay. Beyond inserting the plugin's source
// entry (buildSourceOverlay), it re-enables the shared Cordis module HMR row
// and points its module `root` at the plugin's source directory, so edits to
// src/index.ts are watched and reloaded while `lab dev` runs (criterion 6).
// The web bundle previously disabled the shared hmr row (`disabled: true`);
// because later patch layers win per row, this overlay — applied last via
// `--patch` — overrides `disabled` back to false and scopes the watched root.
export function buildDevOverlay(name: string, entryPath: string, sourceRoot: string): string {
  const root = sourceRoot.replace(/\\/g, '/').replace(/'/g, "''")
  const insert = buildSourceOverlay(name, entryPath)
  return [
    '- id: hmr',
    '  disabled: false',
    '  config:',
    '    root:',
    `      - '${root}'`,
    insert,
  ].join('\n')
}

// Whether the upstream checkout has a modified tracked working tree
// (`git status --porcelain` non-empty). A pinned HEAD whose tracked files were
// touched is not a faithful source run, so both `verify --target master` and
// `lab doctor` reject it.
export function upstreamWorkingTreeDirty(dir: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
    })
    return out.trim().length > 0
  } catch {
    return true // cannot inspect; treat as dirty to avoid a false clean gate
  }
}

// Build the pinned upstream source for the master target (and enforce its
// pinning / cleanliness before reporting any master result). Mirrored by
// `devSource` for master so both the dev and the verify flows run the SAME
// pinned upstream CLI.
export async function buildUpstream(root: string, compat: Compatibility): Promise<string> {
  const masterPin = compat.targets.master
  const upstreamDir = rootPath(root, ROOT_PATHS.upstream)
  if (!masterPin.commit || !(await verifyUpstreamCommit(root, masterPin.commit))) {
    throw new CompatibilityError(
      `master target requires upstream/deepseek-harness HEAD pinned to ${masterPin.commit} ` +
        `(refresh the Task 8 submodule); refusing to report a master pass on a mismatched checkout`,
    )
  }
  if (upstreamWorkingTreeDirty(upstreamDir)) {
    throw new CompatibilityError(
      `master target requires a clean upstream/deepseek-harness working tree ` +
        `(git -C ${upstreamDir} status); refusing to report a master pass on modified tracked files`,
    )
  }
  // Keep build output captured: verify --json must reserve stdout for its
  // single finalized evidence document. Callers retain the thrown command
  // error and can summarize it through their normal failure step.
  pnpm(['install', '--config.strictDepBuilds=false'], { cwd: upstreamDir, stdio: 'pipe' })
  pnpm(['run', 'build'], { cwd: upstreamDir, stdio: 'pipe' })
  return rootPath(root, ROOT_PATHS.upstream + '/apps/cli/lib/bin.js').replace(/\\/g, '/')
}

// Resolve the launcher for a target as an explicit command + argument array.
// `next` runs the pinned launcher through `pnpm exec dsh` (composed against the
// profile's installed launcher); `master` composes against the BUILDable
// upstream source by invoking the built CLI bin directly — the upstream root
// (`@deepseek-ai/dsh-root`) ships no `dsh` bin, and `apps/cli` uses workspace:
// deps that fail isolated installs, so master must not pretend a profile-local
// dsh exists.
async function resolveLauncher(root: string, compat: Compatibility, target: Target): Promise<Command> {
  if (target === 'master') {
    const binPath = await buildUpstream(root, compat)
    return { cmd: process.execPath, args: [binPath] }
  }
  const pc = pnpmCommand()
  return { cmd: pc.cmd, args: [...pc.args, 'exec', 'dsh'] }
}

async function buildUpstreamCancellable(root: string, compat: Compatibility, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const masterPin = compat.targets.master
  const upstreamDir = rootPath(root, ROOT_PATHS.upstream)
  if (!masterPin.commit || !(await verifyUpstreamCommit(root, masterPin.commit))) {
    throw new CompatibilityError(
      `master target requires upstream/deepseek-harness HEAD pinned to ${masterPin.commit} ` +
        `(refresh the Task 8 submodule); refusing to report a master pass on a mismatched checkout`,
    )
  }
  signal.throwIfAborted()
  if (upstreamWorkingTreeDirty(upstreamDir)) {
    throw new CompatibilityError(
      `master target requires a clean upstream/deepseek-harness working tree ` +
        `(git -C ${upstreamDir} status); refusing to report a master pass on modified tracked files`,
    )
  }
  await pnpmAsync(['install', '--config.strictDepBuilds=false'], { cwd: upstreamDir, stdio: 'pipe', signal })
  await pnpmAsync(['run', 'build'], { cwd: upstreamDir, stdio: 'pipe', signal })
  return rootPath(root, ROOT_PATHS.upstream + '/apps/cli/lib/bin.js').replace(/\\/g, '/')
}

// UI sessions use the same target launcher resolution as dev/verify while
// keeping their session-specific argument and environment boundaries separate.
export async function resolveUiLauncher(root: string, target: Target, compat: Compatibility, signal?: AbortSignal): Promise<Command> {
  if (signal !== undefined && target === 'master') {
    const binPath = await buildUpstreamCancellable(root, compat, signal)
    return { cmd: process.execPath, args: [binPath] }
  }
  return resolveLauncher(root, compat, target)
}

// Resolve the foreground `lab dev` launcher for a target. `next` boots the
// profile-installed dsh bin directly (no `pnpm exec` wrapper, which pnpm 11.7
// rejects when the tsx loader is in NODE_OPTIONS — it demands a `.pnpmfile.mjs`
// and crashes); `master` boots the built upstream bin. `next` therefore needs
// the materialized runtime plan so the installed bin can be resolved from the
// profile. This keeps a single launcher rule for the dev path — the dev
// supervisor resolves the identical `next` launcher via
// `resolveProfileDshLauncher`.
async function resolveDevPluginLauncher(opts: { root: string; compat: Compatibility; target: Target; plan?: DevRuntimePlan }): Promise<Command> {
  if (opts.target === 'next') {
    if (!opts.plan) throw new Error('next target requires a prepared runtime plan before resolving the dev launcher')
    return resolveProfileDshLauncher(opts.plan.profileDir)
  }
  return resolveLauncher(opts.root, opts.compat, opts.target)
}

// Run a launcher command against the materialized profile, isolating it to the
// lab runtime home (`DSH_HOME`) so it never touches the user's real ~/.dsh.
// The launcher's OWN flags come first: `--profile <name>` must precede any
// inner/`--patch` arguments, and the `web` subcommand alias is never used (it
// would hard-code profile "web" and bypass our materialized profile).
// Resolve the installed `@deepseek-ai/dsh` bin out of a materialized profile so
// the runtime launches the real CLI directly — no `pnpm exec` wrapper. pnpm is
// install-time only; running `pnpm exec dsh` with the tsx loader in NODE_OPTIONS
// makes pnpm 11.7 demand a `.pnpmfile.mjs` and crash, whereas the direct bin
// keeps the loader in the child env for live TS source without pnpm in the loop.
export function resolveProfileDshLauncher(profileDir: string): { cmd: string; args: string[] } {
  const pkgDir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh')
  const manifestPath = join(pkgDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`installed dsh package not found at ${manifestPath}; the profile must be installed before launching the dev session`)
  }
  let bin: unknown
  try {
    bin = JSON.parse(readFileSync(manifestPath, 'utf8')).bin
  } catch (e) {
    throw new Error(`cannot parse dsh manifest ${manifestPath}: ${(e as Error).message}`)
  }
  const binValue = typeof bin === 'string'
    ? bin
    : bin !== null && typeof bin === 'object'
      ? (bin as Record<string, unknown>).dsh ?? Object.values(bin as Record<string, unknown>)[0]
      : undefined
  if (typeof binValue !== 'string' || binValue.length === 0) {
    throw new Error(`@deepseek-ai/dsh at ${pkgDir} exposes no usable bin (bin=${JSON.stringify(bin)})`)
  }
  const binPath = resolve(pkgDir, binValue)
  const pkgRoot = resolve(pkgDir)
  const contained = binPath === pkgRoot || binPath.startsWith(pkgRoot + sep)
  const stats = statSync(binPath, { throwIfNoEntry: false })
  if (!contained) throw new Error(`dsh bin ${binPath} escapes the package dir ${pkgRoot}`)
  if (stats === undefined) throw new Error(`dsh bin does not exist: ${binPath}`)
  if (!stats.isFile()) throw new Error(`dsh bin is not a regular file: ${binPath}`)
  return { cmd: process.execPath, args: [binPath] }
}

function bootProfile(
  launcher: Command,
  profileDir: string,
  profileName: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): void {
  execFileSync(launcher.cmd, [...launcher.args, '--profile', profileName, ...args], {
    cwd: profileDir,
    env,
    stdio: 'inherit',
  })
}

export async function devSource(opts: DevOptions): Promise<void> {
  const plugin = resolvePluginRef({ root: opts.root, selector: { name: opts.name } })
  return devPlugin({ root: opts.root, plugin, target: opts.target })
}

function devPluginName(plugin: PluginRef): string {
  if (plugin.metadata?.name) return plugin.metadata.name
  if (plugin.catalogName) return plugin.catalogName
  const parts = plugin.packageName.split('/')
  return parts.at(-1) ?? plugin.packageName
}

export interface DevRuntimePlugin {
  packageName: string
  sourcePath: string
  runtimeName: string
}

export interface DevRuntimePlan {
  overlayPath: string
  profileDir: string
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface PrepareDevRuntimeOptions {
  root: string
  plugin: DevRuntimePlugin
  target: 'next' | 'master'
  runtimeHome: string
  profileName: string
  overlayDir?: string
  installProfile?: boolean
  signal?: AbortSignal
}

// Materialize the dev profile + source overlay and compute the boot
// environment for a foreground `lab dev` run. Extracted from `devPlugin` so
// the CLI-dev flow stays byte-identical while a supervisor can prepare an
// isolated runtime (Tasks 4/5).
export async function prepareDevRuntime(opts: PrepareDevRuntimeOptions): Promise<DevRuntimePlan> {
  const { root, plugin, target, runtimeHome, profileName } = opts
  const sourcePath = resolve(plugin.sourcePath)
  const sourceEntry = resolve(sourcePath, 'src', 'index.ts')
  const sourceRoot = resolve(sourcePath, 'src')
  const entryPath = pathToFileURL(sourceEntry).href
  const overlayDir = opts.overlayDir ?? join(runtimeHome, 'overlays', plugin.runtimeName)
  const overlayPath = join(overlayDir, 'cordis.patch.yml')
  const profileDir = join(runtimeHome, 'profiles', profileName)

  mkdirSync(overlayDir, { recursive: true })
  writeFileSync(overlayPath, buildDevOverlay(plugin.runtimeName, entryPath, sourceRoot))

  const compat = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))
  const pin = compat.targets[target]
  if (!pin) throw new CompatibilityError(`compatibility manifest has no ${target} target`)
  const dsh = target === 'master'
    ? `file:${relative(profileDir, rootPath(root, ROOT_PATHS.upstream)).replace(/\\/g, '/')}`
    : (pin.dsh ?? (() => { throw new CompatibilityError('next target requires a pinned dsh version') })())
  const spec: ProfileSpec = { name: `@dsh-lab/profile-${profileName}`, bundles: DEV_WEB_BUNDLES }
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(buildProfilePackageJson(spec, { dsh }), null, 2))
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), buildProfileWorkspaceYaml(pin.allowBuilds ?? {}))
  // The profile `pnpm install` runs with a plain env (process + DSH_HOME only)
  // so pnpm is never handed the tsx loader in NODE_OPTIONS — injecting it makes
  // pnpm 11.7 demand a `.pnpmfile.mjs` in the profile workspace root and throw
  // "Cannot find module .pnpmfile.mjs", crashing the session before the
  // harness boots. The tsx loader is applied only to the returned child env
  // (`plan.env`) so live TS source still loads.
  const installEnv = { ...process.env, DSH_HOME: runtimeHome.replace(/\\/g, '/') }
  const childEnv = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${resolveTsxLoader()}`].filter(Boolean).join(' '),
    DSH_HOME: runtimeHome.replace(/\\/g, '/'),
  }
  if (opts.installProfile !== false && target !== 'master') {
    opts.signal?.throwIfAborted()
    pnpm(['install', '--config.strictDepBuilds=false'], { cwd: profileDir, env: installEnv })
  }
  return { overlayPath, profileDir, cwd: profileDir, env: childEnv }
}

/**
 * Run live source development for either a catalog plugin or an arbitrary
 * standalone plugin directory. All generated profiles, overlays, and runtime
 * state belong to the forge root; the plugin directory is only read.
 */
export async function devPlugin(opts: DevPluginOptions): Promise<void> {
  const { root, plugin, target } = opts
  const logger = opts.logger ?? { info: console.log.bind(console), warn: console.warn.bind(console) }
  const name = devPluginName(plugin)
  assertRuntimePluginIdentity(name)
  const declaredTargets = plugin.metadata?.targets
  if (declaredTargets !== undefined && !declaredTargets.includes(target)) {
    throw new Error(`plugin '${name}' does not declare target '${target}'`)
  }
  if (target === 'master' && !existsSync(rootPath(root, ROOT_PATHS.upstream + '/.git'))) {
    throw new Error('master target requires the pinned upstream checkout (see Task 8)')
  }
  const entryPath = pathToFileURL(resolve(plugin.sourcePath, 'src', 'index.ts')).href
  const runtimeHome = rootPath(root, ROOT_PATHS.runtime)
  const bootProfileName = profileName(name, target, 'dev')
  const compat = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))
  const overlayPath = join(runtimeHome, 'overlays', name, 'cordis.patch.yml')
  const devHome = runtimeHome.replace(/\\/g, '/')
  logger.info(`[dev] plugin '${name}' (${target}) -> ${entryPath}`)
  logger.info(`[dev] generated overlay: ${overlayPath}`)
  logger.info(`[dev] booting materialized web profile '${bootProfileName}' with DSH_HOME=${devHome}`)

  try {
    const plan = await prepareDevRuntime({
      root,
      plugin: { packageName: plugin.packageName, sourcePath: plugin.sourcePath, runtimeName: name },
      target,
      runtimeHome,
      profileName: bootProfileName,
      overlayDir: join(runtimeHome, 'overlays', name),
      installProfile: target !== 'master',
    })
    // `next` boots the profile-installed dsh bin directly (resolved after the
    // profile is installed); `master` boots the built upstream launcher. This
    // keeps the tsx loader in the child env for live TS source without pnpm in
    // the launch loop.
    const launcher = await resolveDevPluginLauncher({ root, compat, target, plan })
    bootProfile(launcher, plan.profileDir, bootProfileName, plan.env, ['--patch', plan.overlayPath])
  } catch (e) {
    throw new Error(`dsh boot failed for profile '${target}': ${(e as Error).message}`, { cause: e })
  }
}

// `lab verify --target all` runs the plugin against every declared target and
// reports all failures together while still running each target (a failure in
// one does not skip the others). The `run` seam lets a caller assert the
// dispatch order/aggregation without an end-to-end boot.
export async function verifyAllTargets(
  root: string,
  name: string,
  run: (target: Target) => Promise<void>,
): Promise<void> {
  const failures: string[] = []
  for (const target of TARGETS) {
    try {
      await run(target)
    } catch (e) {
      failures.push(`${target}: ${(e as Error).message}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`verify failed:\n  ${failures.join('\n  ')}`)
  }
}

export async function verifyBundle(opts: VerifyOptions): Promise<void> {
  const plugin = resolvePluginRef({ root: opts.root, selector: { name: opts.name } })
  const result = await verifyPlugin({
    root: opts.root,
    plugin,
    target: opts.target,
    ...(opts.masterBin === undefined ? {} : { masterBin: opts.masterBin }),
  })
  if (result.result !== 'pass') throw new Error(`verify ${result.result}`)
}

export async function verifyPackedTarget(opts: {
  root: string
  pluginName: string
  target: Target
  tarball: string
  compat: Compatibility
  masterBin?: string
  removeProfile?: (profileDir: string) => void
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}): Promise<void> {
  assertRuntimePluginIdentity(opts.pluginName)
  const { root, pluginName, target, tarball, compat, masterBin } = opts
  const logger = opts.logger ?? { info: console.log.bind(console), warn: console.warn.bind(console) }
  const removeProfile = opts.removeProfile ?? ((profileDir: string) => {
    rmSync(profileDir, { recursive: true, force: true })
  })
  // Ephemeral profile under the runtime home. The launcher resolves
  // `--profile <name>` under `$DSH_HOME/profiles`, so DSH_HOME is pointed at
  // the runtime dir and the profile lands at
  // `<root>/.lab/runtime/profiles/<name>-<target>-verify-<run-id>`.
  const home = rootPath(root, ROOT_PATHS.runtime)
  const runId = randomUUID()
  const profileNameValue = profileName(pluginName, target, 'verify', runId)
  const profileDir = join(home, 'profiles', profileNameValue)
  try {
    mkdirSync(profileDir, { recursive: true })
    const spec: ProfileSpec = { name: `@dsh-lab/profile-${profileNameValue}`, bundles: PROFILE_BUNDLES }
    const dsh = target === 'master' ? undefined : compat.targets.next.dsh
    if (target !== 'master' && !dsh) {
      throw new CompatibilityError(`target '${target}' requires a pinned dsh version`)
    }
    const pin: { dsh?: string } = dsh === undefined ? {} : { dsh }
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify(buildProfilePackageJson(spec, pin), null, 2) + '\n',
    )
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), buildProfileWorkspaceYaml(opts.compat.targets[target].allowBuilds ?? {}))
    const env = { ...process.env, DSH_HOME: home.replace(/\\/g, '/') }

    // 3. Install the packed bundle through dsh's own plugin manager. `plugin add`
    //    forwards to pnpm and reconciles `dsh.profile.bundles` against installed
    //    state, so a tarball whose manifest declares `dsh.bundle.patch` joins the
    //    layer stack — the real publish path. `next` first installs the pinned
    //    launcher so `pnpm exec dsh` resolves; its `--config.strictDepBuilds=false`
    //    keeps pnpm from hard-failing on dsh's native build scripts, and the
    //    tarball path is passed as a single argument (no shell tokenization, so
    //    Windows paths with spaces are safe).
    const launcher = target === 'master' && masterBin
      ? { cmd: process.execPath, args: [masterBin] }
      : await resolveLauncher(root, compat, target)
    if (target !== 'master') {
      pnpm(['install', '--config.strictDepBuilds=false'], { cwd: profileDir, env })
    }
    try {
      execFileSync(
        launcher.cmd,
        [
          ...launcher.args,
          'plugin',
          '--profile',
          profileNameValue,
          'add',
          `file:${tarball.replace(/\\/g, '/')}`,
          '--config.strictDepBuilds=false',
        ],
        { cwd: profileDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (e) {
      const err = new Error(`dsh plugin add failed for '${pluginName}' under ${target}: ${sanitizeSummary(e instanceof Error ? e.message : String(e))}`, { cause: e })
      Object.defineProperty(err, 'code', { value: 'dsh.plugin-add.fail' as LabErrorCode, enumerable: true, configurable: true })
      Object.defineProperty(err, 'detail', { value: extractRunDetail(e), enumerable: true, configurable: true })
      throw err
    }

    // 4. Compose the profile config for THIS target WITHOUT binding a port/server
    //    (a live dsh is already bound on 3080), then assert the plugin's patch
    //    layer surfaces. The plugin's execution contract itself is proven earlier
    //    by the pack-smoke; this per-target check confirms the tarball composes
    //    into the specific target's profile.
    let out: string
    try {
      out = execFileSync(
        launcher.cmd,
        [...launcher.args, '--profile', profileNameValue, '--dump-config'],
        { cwd: profileDir, env, encoding: 'utf8' },
      ) as string
    } catch (e) {
      const err = new Error(`dsh dump-config failed for '${pluginName}' under ${target}: ${sanitizeSummary(e instanceof Error ? e.message : String(e))}`, { cause: e })
      Object.defineProperty(err, 'code', { value: 'dsh.dump-config.fail' as LabErrorCode, enumerable: true, configurable: true })
      Object.defineProperty(err, 'detail', { value: extractRunDetail(e), enumerable: true, configurable: true })
      throw err
    }
    if (!out!.includes(pluginName)) {
      const assertion = new Error(`plugin '${pluginName}' missing from composed profile config under ${target}`)
      Object.defineProperty(assertion, 'code', { value: 'dsh.dump-config.fail' as LabErrorCode, enumerable: true, configurable: true })
      Object.defineProperty(assertion, 'detail', { value: sanitizeSummary(out!.slice(-500)), enumerable: true, configurable: true })
      throw assertion
    }
  } finally {
    try {
      removeProfile(profileDir)
    } catch (e) {
      const stale = `${profileDir}.stale-${runId}`
      if (existsSync(profileDir)) {
        try {
          renameSync(profileDir, stale)
        } catch (rollback) {
          throw new AggregateError([e, rollback], `failed to clean verify profile '${profileDir}'`)
        }
        logger.warn(`[verify] profile cleanup deferred; moved stale profile to ${stale}`)
        const err = new Error(
          `failed to clean verify profile '${profileDir}'; moved stale profile to '${stale}': ${
            e instanceof Error ? e.message : String(e)
          }`,
          { cause: e },
        )
        Object.defineProperty(err, 'code', { value: 'dsh.profile-cleanup.fail' as LabErrorCode, enumerable: true, configurable: true })
        Object.defineProperty(err, 'detail', { value: extractRunDetail(e), enumerable: true, configurable: true })
        throw err
      }
      const err = new Error(`failed to clean verify profile '${profileDir}': ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      })
      Object.defineProperty(err, 'code', { value: 'dsh.profile-cleanup.fail' as LabErrorCode, enumerable: true, configurable: true })
      Object.defineProperty(err, 'detail', { value: extractRunDetail(e), enumerable: true, configurable: true })
      throw err
    }
  }
}

function extractRunDetail(error: unknown): string {
  const raw = (() => {
    if (error instanceof Error) {
      const withOutput = error as Error & { stderr?: unknown; stdout?: unknown; output?: unknown }
      if (typeof withOutput.stderr === 'string' || Buffer.isBuffer(withOutput.stderr)) return String(withOutput.stderr)
      if (typeof withOutput.stdout === 'string' || Buffer.isBuffer(withOutput.stdout)) return String(withOutput.stdout)
      if (Array.isArray(withOutput.output)) {
        const combined = (withOutput.output as unknown[]).filter(v => typeof v === 'string' || Buffer.isBuffer(v as Buffer)).map(v => String(v)).join(' ')
        if (combined) return combined
      }
      return error.message
    }
    return String(error)
  })()
  return sanitizeSummary(raw.slice(-500))
}
