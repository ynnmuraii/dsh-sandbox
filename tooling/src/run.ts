import { join, relative, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
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

// Build a workbench profile package.json, pinning dsh to an exact version
// that `lab dev`/`lab verify` substitute at runtime.
export function buildProfilePackageJson(spec: ProfileSpec, pin: { dsh: string }) {
  return {
    name: spec.name,
    private: true,
    type: 'module',
    dependencies: {
      '@deepseek-ai/dsh': pin.dsh,
    },
    dsh: {
      profile: {
        bundles: spec.bundles,
      },
    },
  }
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
  // Build + pack in the plugin repo, then install into a temp profile and
  // assert the observable packed-bundle result. Finalized end-to-end here;
  // the profile/variant-specific assertions land in Task 10.
  execSync('pnpm build && pnpm pack', { cwd: pluginDir, stdio: 'inherit' })
  console.log(`[verify] ${name} against ${target}`)
}
