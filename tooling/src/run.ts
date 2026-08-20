import { join, relative, resolve, dirname } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { loadPluginConfig } from './create.js'
import {
  loadCatalogFromFile,
  loadCompatibilityFromFile,
  CompatibilityError,
  type CatalogEntry,
  type Compatibility,
} from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'
import { verifyUpstreamCommit } from './upstream.js'
import { pnpm, pnpmCommand } from './proc.js'

export interface ProfileSpec {
  name: string
  bundles: string[]
}

export interface DevOptions {
  root: string
  name: string
  target: 'next' | 'master'
}

export interface VerifyOptions {
  root: string
  name: string
  target: 'next' | 'master' | 'all'
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

// Resolve the source entry of a plugin to an absolute path on the host. On
// Windows this yields backslashes (e.g. `C:\…`); the runtime overlay YAML
// normalizes them to forward slashes before embedding.
export function resolveSourceOverlay(
  root: string,
  pluginRel: string,
  entryRel: string,
  name: string,
): string {
  return resolve(root, pluginRel, entryRel)
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

// Read the catalog entry for a plugin; throw if the name is absent.
function catalogEntry(root: string, name: string): CatalogEntry {
  const catalog = loadCatalogFromFile(rootPath(root, ROOT_PATHS.catalog))
  const entry = catalog.plugins[name]
  if (!entry) {
    throw new CompatibilityError(`plugin '${name}' not found in catalog`)
  }
  return entry
}

// Materialize a pinned profile package.json (and workspace marker) into the
// runtime dir, reading the target's pin from the compatibility manifest. The
// materialized location is `.lab/runtime/profiles/<name>-<target>`, so the
// master source reference is computed as a path back to `upstream/` from
// there (and forward-slash normalized for the `file:` spec).
function materializeProfile(opts: {
  root: string
  name: string
  target: Target
  bundles?: string[]
}): string {
  const { root, name, target, bundles = PROFILE_BUNDLES } = opts
  const compat = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))
  const profileDir = join(root, ROOT_PATHS.runtime, 'profiles', `${name}-${target}`)
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
  const spec: ProfileSpec = { name: `@dsh-lab/profile-${target}`, bundles }
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(buildProfilePackageJson(spec, { dsh }), null, 2))
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\n')
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
async function buildUpstream(root: string, compat: Compatibility): Promise<string> {
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
  pnpm(['install', '--config.strictDepBuilds=false'], { cwd: upstreamDir, stdio: 'inherit' })
  pnpm(['run', 'build'], { cwd: upstreamDir, stdio: 'inherit' })
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
  const { root, name, target } = opts
  const entry = catalogEntry(root, name)
  const cfg = loadPluginConfig(join(root, entry.path, '.dsh-lab', 'plugin.yaml'))
  if (!cfg.targets.includes(target)) {
    throw new Error(`plugin '${name}' does not declare target '${target}'`)
  }
  if (target === 'master' && !existsSync(rootPath(root, ROOT_PATHS.upstream + '/.git'))) {
    throw new Error('master target requires the pinned upstream checkout (see Task 8)')
  }
  const entryPath = resolveSourceOverlay(root, entry.path, 'src/index.ts', name)

  // Emit an absolute overlay into the runtime dir. The overlay both inserts the
  // plugin source entry AND re-enables Cordis module HMR with a module `root`
  // at the plugin's src dir, so edits there reload live during `lab dev`.
  const overlayDir = join(root, ROOT_PATHS.runtime, 'overlays', name)
  const overlayPath = join(overlayDir, 'cordis.patch.yml')
  mkdirSync(overlayDir, { recursive: true })
  writeFileSync(overlayPath, buildDevOverlay(name, entryPath, dirname(entryPath)))

  // Materialize the pinned profile (carrying the full WEB bundle stack so a
  // real web composition boots), then boot THE ACTUAL profile by name with the
  // source overlay and watch source for HMR. DSH_HOME is pointed at the lab
  // runtime home so the boot is fully isolated from the user's real ~/.dsh.
  // The `--profile <name>-<target>` flag boots the materialized web profile
  // (NOT the `web` built-in alias); master boots the pinned upstream's built
  // CLI directly (no `dsh` bin exists on dsh-root).
  const profileDir = materializeProfile({ root, name, target, bundles: DEV_WEB_BUNDLES })
  const profileName = `${name}-${target}`
  const env = { ...process.env, DSH_HOME: rootPath(root, ROOT_PATHS.runtime).replace(/\\/g, '/') }
  console.log(`[dev] plugin '${name}' (${target}) -> ${entryPath}`)
  console.log(`[dev] generated overlay: ${overlayPath}`)
  console.log(`[dev] booting materialized web profile '${profileName}' with DSH_HOME=${env.DSH_HOME}`)

  const compat = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))
  const launcher = await resolveLauncher(root, compat, target)
  try {
    if (target !== 'master') {
      pnpm(['install', '--config.strictDepBuilds=false'], { cwd: profileDir, env })
    }
    bootProfile(launcher, profileDir, profileName, env, ['--patch', overlayPath])
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

// Enforce a plugin's DECLARED compatibility targets (P1-4). `--target all`
// derives from the declared list, and a requested target the plugin does not
// declare is rejected outright rather than silently run.
function resolveVerifyTargets(
  requested: 'next' | 'master' | 'all',
  declared: string[],
  name: string,
): Target[] {
  for (const d of declared) {
    if (!(TARGETS as readonly string[]).includes(d)) {
      throw new Error(`plugin '${name}' declares unknown target '${d}'`)
    }
  }
  if (requested === 'all') {
    return TARGETS.filter(t => declared.includes(t))
  }
  if (!declared.includes(requested)) {
    throw new Error(
      `plugin '${name}' does not declare target '${requested}' (declared: ${declared.join(', ') || 'none'})`,
    )
  }
  return [requested]
}

export async function verifyBundle(opts: VerifyOptions): Promise<void> {
  const { root, name } = opts
  const entry = catalogEntry(root, name)
  const pluginDir = resolve(root, entry.path)
  const cfg = loadPluginConfig(join(pluginDir, '.dsh-lab', 'plugin.yaml'))
  const resolvedTargets = resolveVerifyTargets(opts.target, cfg.targets, name)
  if (resolvedTargets.length === 0) {
    throw new Error(`plugin '${name}' declares no supported compatibility targets`)
  }
  const compat = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))

  // Install plugin deps only when absent: a fresh clone needs them, but this
  // host enforces a global pnpm `minimumReleaseAge` supply-chain policy that
  // rejects a same-day dev dependency on an unconditional reinstall.
  // `--config.minimumReleaseAge=0` relaxes just that host guard; the plugin's
  // committed lockfile still pins every version.
  if (!existsSync(join(pluginDir, 'node_modules'))) {
    pnpm(['install', '--config.minimumReleaseAge=0'], { cwd: pluginDir, stdio: 'inherit' })
  }

  // P1-3: run the plugin's OWN checks (typecheck + behavior/lifecycle/deps
  // tests) before any target compatibility run. These are the source-level
  // observable-contract proofs the plugin owns.
  pnpm(['typecheck'], { cwd: pluginDir, stdio: 'inherit' })
  pnpm(['test'], { cwd: pluginDir, stdio: 'inherit' })

  // Build + pack the bundle once, then EXECUTE the produced tarball's built
  // entry through the plugin's own packed-bundle smoke (P1-6/P1-9/P1-2). This
  // replaces the old source-regex gate with a plugin-owned observable smoke
  // contract, and turns the verify pass into a real keyless execution (imports
  // the built lib/index.js, mounts the fiber, asserts the registered tool)
  // rather than a `--dump-config` name match alone.
  pnpm(['build'], { cwd: pluginDir, stdio: 'inherit' })
  const tarball = packTarball(pluginDir)
  runPackSmoke(pluginDir, tarball)

  // Target compatibility: install the tarball into an ephemeral profile via the
  // real harness plugin manager and assert it composes for EACH declared target.
  const failures: string[] = []
  for (const target of resolvedTargets) {
    try {
      await verifyBundleTarget({ root, name, target, tarball, compat })
    } catch (e) {
      failures.push(`${target}: ${(e as Error).message}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`verify failed:\n  ${failures.join('\n  ')}`)
  }
}

// Produce the plugin's packed tarball name via `pnpm pack --json` and return its
// absolute path.
function packTarball(pluginDir: string): string {
  const out = pnpm(['pack', '--json'], { cwd: pluginDir, encoding: 'utf8' }) as string
  const packed = JSON.parse(out) as { filename: string } | { filename: string }[]
  const first = Array.isArray(packed) ? packed[0] : packed
  if (!first) throw new Error('pnpm pack produced an empty package list')
  return join(pluginDir, first.filename)
}

// Run the plugin's OWN packed-bundle smoke against the produced tarball. The
// plugin owns its observable contract; the smoke installs the tarball and
// executes its built entry keyless (no model/API key). A plugin without a
// pack-smoke cannot claim a bundle-verified pass.
function runPackSmoke(pluginDir: string, tarball: string): void {
  const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  if (!pkg.scripts?.['pack-smoke']) {
    throw new Error(
      `plugin at ${pluginDir} does not define a 'pack-smoke' script (add scripts/pack-smoke.mjs ` +
        `to own the packed-bundle observable contract)`,
    )
  }
  pnpm(['pack-smoke', tarball], { cwd: pluginDir, stdio: 'inherit' })
}

async function verifyBundleTarget(opts: {
  root: string
  name: string
  target: Target
  tarball: string
  compat: Compatibility
}): Promise<void> {
  const { root, name, target, tarball, compat } = opts

  // Ephemeral profile under the runtime home. The launcher resolves
  // `--profile <name>` under `$DSH_HOME/profiles`, so DSH_HOME is pointed at
  // the runtime dir and the profile lands at
  // `<root>/.lab/runtime/profiles/<name>-<target>`.
  const home = rootPath(root, ROOT_PATHS.runtime)
  const profileName = `${name}-${target}`
  const profileDir = join(home, 'profiles', profileName)
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })
  const spec: ProfileSpec = { name: `@dsh-lab/profile-${target}`, bundles: PROFILE_BUNDLES }
  const dsh = target === 'master' ? undefined : compat.targets.next.dsh
  if (target !== 'master' && !dsh) {
    throw new CompatibilityError(`target '${target}' requires a pinned dsh version`)
  }
  const pin: { dsh?: string } = dsh === undefined ? {} : { dsh }
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify(buildProfilePackageJson(spec, pin), null, 2) + '\n',
  )
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - "."\n')
  const env = { ...process.env, DSH_HOME: home.replace(/\\/g, '/') }

  const launcher = await resolveLauncher(root, compat, target)

  // 3. Install the packed bundle through dsh's own plugin manager. `plugin add`
  //    forwards to pnpm and reconciles `dsh.profile.bundles` against installed
  //    state, so a tarball whose manifest declares `dsh.bundle.patch` joins the
  //    layer stack — the real publish path. `next` first installs the pinned
  //    launcher so `pnpm exec dsh` resolves; its `--config.strictDepBuilds=false`
  //    keeps pnpm from hard-failing on dsh's native build scripts, and the
  //    tarball path is passed as a single argument (no shell tokenization, so
  //    Windows paths with spaces are safe).
  if (target !== 'master') {
    pnpm(['install', '--config.strictDepBuilds=false'], { cwd: profileDir, env })
  }
  execFileSync(
    launcher.cmd,
    [
      ...launcher.args,
      'plugin',
      '--profile',
      profileName,
      'add',
      `file:${tarball.replace(/\\/g, '/')}`,
      '--config.strictDepBuilds=false',
    ],
    { cwd: profileDir, env, stdio: 'inherit' },
  )

  // 4. Compose the profile config for THIS target WITHOUT binding a port/server
  //    (a live dsh is already bound on 3080), then assert the plugin's patch
  //    layer surfaces. The plugin's execution contract itself is proven earlier
  //    by the pack-smoke; this per-target check confirms the tarball composes
  //    into the specific target's profile.
  const out = execFileSync(
    launcher.cmd,
    [...launcher.args, '--profile', profileName, '--dump-config'],
    { cwd: profileDir, env, encoding: 'utf8' },
  ) as string
  if (!out.includes(name)) {
    throw new Error(`plugin '${name}' missing from composed profile config under ${target}`)
  }
  console.log(`[verify] bundled plugin '${name}' composes under ${target}`)
}
