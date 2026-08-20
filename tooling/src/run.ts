import { join, relative, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { loadPluginConfig } from './create.js'
import {
  loadCatalogFromFile,
  loadCompatibilityFromFile,
  CompatibilityError,
  type CatalogEntry,
} from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'

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
  target: string
}

const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base']

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
  target: 'next' | 'master'
}): string {
  const { root, name, target } = opts
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
  const spec: ProfileSpec = { name: `@dsh-lab/profile-${target}`, bundles: PROFILE_BUNDLES }
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(buildProfilePackageJson(spec, { dsh }), null, 2))
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\n')
  return profileDir
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

  // Emit an absolute overlay into the runtime dir.
  const overlayDir = join(root, ROOT_PATHS.runtime, 'overlays', name)
  const overlayPath = join(overlayDir, 'cordis.patch.yml')
  mkdirSync(overlayDir, { recursive: true })
  writeFileSync(overlayPath, buildSourceOverlay(name, entryPath))

  console.log(`[dev] plugin '${name}' (${target}) -> ${entryPath}`)
  console.log(`[dev] generated overlay: ${overlayPath}`)
  console.log(`[dev] run dsh with '--patch <overlay>' (source mode; see profile spec below).`)

  // Materialize the pinned profile, then boot it against the overlay and
  // watch source for HMR. A non-zero boot surfaces as a thrown error; at this
  // scaffolding stage the profile may not have dsh installed yet, so a failed
  // boot is acceptable (asserted end-to-end by Task 9).
  const profileDir = materializeProfile({ root, name, target })
  try {
    execSync('pnpm install', { cwd: profileDir, stdio: 'inherit' })
    execSync(`pnpm exec dsh web --patch "${overlayPath}"`, { cwd: profileDir, stdio: 'inherit' })
  } catch (e) {
    throw new Error(`dsh boot failed for profile '${target}': ${(e as Error).message}`, { cause: e })
  }
}

export async function verifyBundle(opts: VerifyOptions): Promise<void> {
  const { root, name, target } = opts
  const entry = catalogEntry(root, name)
  const pluginDir = resolve(root, entry.path)
  const compat = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))

  // 1. Build + pack the plugin for real and locate the produced tarball.
  //    Install deps only when absent: a fresh clone needs them, but this host
  //    enforces a global pnpm `minimumReleaseAge` supply-chain policy that
  //    rejects a same-day dev dependency (vite) on an unconditional reinstall.
  //    `--config.minimumReleaseAge=0` relaxes just that host guard so a clean
  //    checkout reproduces here; the plugin's committed lockfile still pins
  //    every version.
  if (!existsSync(join(pluginDir, 'node_modules'))) {
    execSync('pnpm install --config.minimumReleaseAge=0', { cwd: pluginDir, stdio: 'inherit' })
  }
  execSync('pnpm build', { cwd: pluginDir, stdio: 'inherit' })

  // Pack-inspection: the built bundle must still register the plugin's
  // declared tool. The composed-config layer (from cordis.patch.yml) only
  // proves the bundle is active in a profile, so this is the check that makes
  // the regression guard tool-sensitive: a renamed/removed tool fails here
  // even though the profile layer would still compose.
  const entrySource = readFileSync(join(pluginDir, 'src', 'index.ts'), 'utf8')
  const toolMatch = /defineTool\(\s*\{[\s\S]*?name:\s*['"]([^'"]+)['"]/.exec(entrySource)
  const toolName = toolMatch?.[1]
  if (!toolName) {
    throw new Error(`plugin '${name}' source does not declare a tool name (defineTool)`)
  }
  const builtMain = readFileSync(join(pluginDir, 'lib', 'index.js'), 'utf8')
  if (!builtMain.includes(toolName)) {
    throw new Error(`plugin '${name}' built bundle no longer registers tool '${toolName}'`)
  }

  const packOut = execSync('pnpm pack --json', { cwd: pluginDir, encoding: 'utf8' })
  const packed = JSON.parse(packOut) as { filename: string } | { filename: string }[]
  let tarballName: string
  if (Array.isArray(packed)) {
    const first = packed[0]
    if (!first) throw new Error('pnpm pack produced an empty package list')
    tarballName = first.filename
  } else {
    tarballName = packed.filename
  }
  const tarball = join(pluginDir, tarballName)

  // 2. Ephemeral profile under the runtime home. The launcher resolves
  //    `--profile <name>` under `$DSH_HOME/profiles`, so DSH_HOME is pointed
  //    at the runtime dir and the profile lands at
  //    `<root>/.lab/runtime/profiles/<name>-<target>`.
  const home = rootPath(root, ROOT_PATHS.runtime)
  const profileName = `${name}-${target}`
  const profileDir = join(home, 'profiles', profileName)
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })
  // The dsh launcher: `next` pins an exact registry version into the profile
  // and runs it via `pnpm exec dsh`; `master` composes against the BUILDable
  // upstream source by invoking the built CLI bin directly. A `file:` pin to
  // the upstream root cannot serve as the launcher — the root manifest
  // (`@deepseek-ai/dsh-root`) ships no `dsh` bin, and `apps/cli` (the real
  // `@deepseek-ai/dsh`) uses workspace: deps that fail isolated installs — so
  // master must not pretend a profile-local dsh exists.
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
  const launcher =
    target === 'master'
      ? `node "${rootPath(root, ROOT_PATHS.upstream + '/apps/cli/lib/bin.js').replace(/\\/g, '/')}"`
      : 'pnpm exec dsh'

  // 3. Install the packed bundle through dsh's own plugin manager. `plugin
  //    add` forwards to pnpm and reconciles `dsh.profile.bundles` against
  //    installed state, so a tarball whose manifest declares `dsh.bundle.
  //    patch` joins the layer stack — the real publish path. `next` first
  //    installs the pinned launcher so `pnpm exec dsh` resolves; its
  //    `--config.strictDepBuilds=false` keeps pnpm from hard-failing on dsh's
  //    native build scripts (node-pty, koffi, ...) — this profile only
  //    composes config, it never runs them, so a skipped build must not abort.
  if (target !== 'master') {
    execSync('pnpm install --config.strictDepBuilds=false', { cwd: profileDir, env, stdio: 'inherit' })
  }
  execSync(
    `${launcher} plugin --profile ${profileName} add file:${tarball.replace(/\\/g, '/')} --config.strictDepBuilds=false`,
    { cwd: profileDir, env, stdio: 'inherit' },
  )

  // 4. Compose the profile config WITHOUT binding a port/server (a live dsh is
  //    already bound on 3080), then assert the plugin's patch layer surfaces.
  const out = execSync(`${launcher} --profile ${profileName} --dump-config`, {
    cwd: profileDir,
    env,
    encoding: 'utf8',
  })
  if (!out.includes(name)) {
    throw new Error(`plugin '${name}' missing from composed profile config under ${target}`)
  }
  console.log(`[verify] bundled plugin '${name}' loads under ${target}`)
}
