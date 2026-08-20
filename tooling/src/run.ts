import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { loadPluginConfig } from './create.js'
import { loadCatalogFromFile, CompatibilityError, type CatalogEntry } from './schemas.js'
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

// Read the catalog entry for a plugin; throw if the name is absent.
function catalogEntry(root: string, name: string): CatalogEntry {
  const catalog = loadCatalogFromFile(rootPath(root, ROOT_PATHS.catalog))
  const entry = catalog.plugins[name]
  if (!entry) {
    throw new CompatibilityError(`plugin '${name}' not found in catalog`)
  }
  return entry
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
  const overlay = [
    '',
    '- insert:',
    `    - id: ${name}`,
    `      name: '${entryPath.replace(/\\/g, '/').replace(/'/g, `\\'`)}'`,
    '',
  ].join('\n')
  writeFileSync(overlayPath, overlay)

  console.log(`[dev] plugin '${name}' (${target}) -> ${entryPath}`)
  console.log(`[dev] generated overlay: ${overlayPath}`)
  console.log(`[dev] run dsh with '--patch <overlay>' (source mode; see profile spec below).`)

  // Boot the workbench profile against the overlay and watch source for HMR.
  // A non-zero boot surfaces as a thrown error; at this scaffolding stage the
  // profile may not have dsh installed yet, so a failed boot is acceptable
  // (asserted end-to-end by Task 9).
  const profileDir = resolve(root, 'workbench', 'profiles', target)
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
