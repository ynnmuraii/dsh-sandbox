import { join, relative, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs'
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
import { pnpm, pnpmCommand } from './proc.js'
import { resolvePluginRef, type PluginRef } from './plugin-ref.js'
import { verifyPlugin } from './verify.js'

export interface ProfileSpec {
  name: string
  bundles: string[]
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

// Materialize a pinned profile package.json (and workspace marker) into the
// runtime dir, reading the target's pin from the compatibility manifest. The
// materialized location is `.lab/runtime/profiles/<name>-<target>-<kind>`, so the
// master source reference is computed as a path back to `upstream/` from
// there (and forward-slash normalized for the `file:` spec).
function materializeProfile(opts: {
  root: string
  name: string
  target: Target
  profileKind: 'dev' | 'verify'
  runId?: string
  bundles?: string[]
}): string {
  const { root, name, target, profileKind, runId, bundles = PROFILE_BUNDLES } = opts
  const compat = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))
  const profile = profileName(name, target, profileKind, runId)
  const profileDir = join(root, ROOT_PATHS.runtime, 'profiles', profile)
  let dsh: string
  if (target === 'master') {
    dsh = `file:${relative(profileDir, rootPath(root, ROOT_PATHS.upstream)).replace(/\\/g, '/')}`
  } else {
    const pin = compat.targets.next.dsh
    if (!pin) {
      throw new CompatibilityError('next target requires a pinned dsh version')
    }
    dsh = pin
  }
  const spec: ProfileSpec = { name: `@dsh-lab/profile-${profile}`, bundles }
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(buildProfilePackageJson(spec, { dsh }), null, 2))
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), buildProfileWorkspaceYaml(compat.targets[target].allowBuilds ?? {}))
  return profileDir
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

// `pnpmCommand` is also the test seam for a directly executable launcher. In
// production the resolved pnpm entry needs `exec dsh`; an injected node script
// already represents dsh and must receive only dsh's own flags.
async function resolveDevLauncher(root: string, compat: Compatibility, target: Target): Promise<Command> {
  const launcher = await resolveLauncher(root, compat, target)
  if (target !== 'next' || launcher.cmd !== process.execPath) return launcher
  const entry = launcher.args[0]
  if (entry !== undefined && !/pnpm\.(?:cjs|mjs)$/i.test(entry)) {
    return { cmd: launcher.cmd, args: launcher.args.slice(0, -2) }
  }
  return launcher
}

// Run a launcher command against the materialized profile, isolating it to the
// lab runtime home (`DSH_HOME`) so it never touches the user's real ~/.dsh.
// The launcher's OWN flags come first: `--profile <name>` must precede any
// inner/`--patch` arguments, and the `web` subcommand alias is never used (it
// would hard-code profile "web" and bypass our materialized profile).
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

/**
 * Run live source development for either a catalog plugin or an arbitrary
 * standalone plugin directory. All generated profiles, overlays, and runtime
 * state belong to the forge root; the plugin directory is only read.
 */
export async function devPlugin(opts: DevPluginOptions): Promise<void> {
  const { root, plugin, target } = opts
  const name = devPluginName(plugin)
  const declaredTargets = plugin.metadata?.targets
  if (declaredTargets !== undefined && !declaredTargets.includes(target)) {
    throw new Error(`plugin '${name}' does not declare target '${target}'`)
  }
  if (target === 'master' && !existsSync(rootPath(root, ROOT_PATHS.upstream + '/.git'))) {
    throw new Error('master target requires the pinned upstream checkout (see Task 8)')
  }
  const entryPath = pathToFileURL(resolve(plugin.sourcePath, 'src', 'index.ts')).href
  const sourceRoot = resolve(plugin.sourcePath, 'src')

  // Emit an absolute overlay into the runtime dir. The overlay both inserts the
  // plugin source entry AND re-enables Cordis module HMR with a module `root`
  // at the plugin's src dir, so edits there reload live during `lab dev`.
  const overlayDir = join(root, ROOT_PATHS.runtime, 'overlays', name)
  const overlayPath = join(overlayDir, 'cordis.patch.yml')
  mkdirSync(overlayDir, { recursive: true })
  writeFileSync(overlayPath, buildDevOverlay(name, entryPath, sourceRoot))

  // Materialize the pinned profile (carrying the full WEB bundle stack so a
  // real web composition boots), then boot THE ACTUAL profile by name with the
  // source overlay and watch source for HMR. DSH_HOME is pointed at the lab
  // runtime home so the boot is fully isolated from the user's real ~/.dsh.
  // The `--profile <name>-<target>` flag boots the materialized web profile
  // (NOT the `web` built-in alias); master boots the pinned upstream's built
  // CLI directly (no `dsh` bin exists on dsh-root).
  const profileDir = materializeProfile({ root, name, target, profileKind: 'dev', bundles: DEV_WEB_BUNDLES })
  const bootProfileName = profileName(name, target, 'dev')
  const compat = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))
  const launcher = await resolveDevLauncher(root, compat, target)
  const directLauncher = launcher.cmd === process.execPath && launcher.args.length === 1
  const nodeOptions = [
    process.env.NODE_OPTIONS,
    `--import=${resolveTsxLoader()}`,
    ...(directLauncher ? ['--title=tsx/esm'] : []),
  ].filter(Boolean).join(' ')
  const env = { ...process.env, NODE_OPTIONS: nodeOptions, DSH_HOME: rootPath(root, ROOT_PATHS.runtime).replace(/\\/g, '/') }
  console.log(`[dev] plugin '${name}' (${target}) -> ${entryPath}`)
  console.log(`[dev] generated overlay: ${overlayPath}`)
  console.log(`[dev] booting materialized web profile '${bootProfileName}' with DSH_HOME=${env.DSH_HOME}`)

  try {
    if (target !== 'master') {
      pnpm(['install', '--config.strictDepBuilds=false'], { cwd: profileDir, env })
    }
    bootProfile(launcher, profileDir, bootProfileName, env, ['--patch', overlayPath])
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
}): Promise<void> {
  const { root, pluginName, target, tarball, compat, masterBin } = opts
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

    // 4. Compose the profile config for THIS target WITHOUT binding a port/server
    //    (a live dsh is already bound on 3080), then assert the plugin's patch
    //    layer surfaces. The plugin's execution contract itself is proven earlier
    //    by the pack-smoke; this per-target check confirms the tarball composes
    //    into the specific target's profile.
    const out = execFileSync(
      launcher.cmd,
      [...launcher.args, '--profile', profileNameValue, '--dump-config'],
      { cwd: profileDir, env, encoding: 'utf8' },
    ) as string
    if (!out.includes(pluginName)) {
      throw new Error(`plugin '${pluginName}' missing from composed profile config under ${target}`)
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
        console.warn(`[verify] profile cleanup deferred; moved stale profile to ${stale}`)
        throw new Error(
          `failed to clean verify profile '${profileDir}'; moved stale profile to '${stale}': ${
            e instanceof Error ? e.message : String(e)
          }`,
          { cause: e },
        )
      }
      throw new Error(`failed to clean verify profile '${profileDir}': ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      })
    }
  }
}
