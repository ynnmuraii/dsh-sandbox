import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { load as loadYaml, dump as dumpYaml } from 'js-yaml'
import { loadCatalogFromFile } from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'
import { snapshotContext, contextDocuments } from './sync.js'

// Resolve the template dir from this module's own location so creation works
// regardless of the caller's cwd/root (unit tests root a throwaway tmpdir).
const TEMPLATES = fileURLToPath(new URL('../../templates/plugin', import.meta.url))

export interface PluginConfig {
  name: string
  tracking: 'local' | 'submodule'
  maturity: string
  targets: string[]
}

export interface CatalogShape {
  plugins: Record<
    string,
    {
      path: string
      tracking: 'local' | 'submodule'
      maturity: 'experiment' | 'stable'
      repository?: string
    }
  >
}

export function loadPluginConfig(path: string): PluginConfig {
  return loadYaml(readFileSync(path, 'utf8')) as PluginConfig
}

// Namespace-friendly name check: lowercase letters, digits, hyphens, and
// must start with a letter-or-digit.
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

// Names of template-local dirs that must never be copied into a new plugin.
const SKIPPED: Record<string, true> = { node_modules: true, '.git': true }

// Read a directory's direct children as sorted names (deterministic across
// platforms), dropping rev-control/install dirs.
function readDirSorted(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => !SKIPPED[e.name])
    .map(e => e.name)
    .sort()
}

// Whether `path` is a directory, using a single readdirSync + Dirent test on
// its parent (no extra stat syscall, deterministic output).
function statIsDir(path: string): boolean {
  const parent = join(path, '..')
  const base = path.slice(parent.length + 1)
  return readdirSync(parent, { withFileTypes: true }).some(
    e => e.name === base && e.isDirectory(),
  )
}

// Recursively list the dir's contents. Directories are emitted first (as
// `path/`) followed by their children, so `render` can mkdir ahead of files.
function readDirRecursive(dir: string): string[] {
  const entries: string[] = []
  for (const f of readDirSorted(dir)) {
    const full = join(dir, f)
    if (statIsDir(full)) {
      entries.push(full + '/')
      entries.push(...readDirRecursive(full))
    } else {
      entries.push(full)
    }
  }
  return entries
}

function render(templateDir: string, targetDir: string, name: string): void {
  for (const entry of readDirRecursive(templateDir)) {
    const rel = entry.slice(templateDir.length)
    const out = join(targetDir, rel.replace(/__PLUGIN_NAME__/g, name))
    if (entry.endsWith('/')) {
      mkdirSync(out, { recursive: true })
      continue
    }
    mkdirSync(join(out, '..'), { recursive: true })
    const text = readFileSync(entry, 'utf8')
    writeFileSync(out, text.replaceAll('__PLUGIN_NAME__', name))
  }
}

// Rewrite the plugin tsconfig.json to be self-contained so a standalone clone
// compiles without inheriting the meta-repo's tsconfig.base.json (constraint
// 12). The template's `extends` chain is replaced by inlined base options.
const STANDALONE_TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    lib: ['ESNext'],
    noEmit: true,
  },
  include: ['src', 'tests'],
}

export async function createPlugin(opts: { root: string; name: string }): Promise<string> {
  const { root, name } = opts
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid plugin name '${name}': use lowercase letters, digits, hyphens`)
  }
  // Reject a name already registered in the catalog BEFORE touching any target
  // path: overwriting an existing catalog entry would silently absorb a
  // reviewed local or submodule plugin into a fresh scaffold. Only the explicit
  // submodule/catalog workflow may convert an existing entry.
  const catalogPath = rootPath(root, ROOT_PATHS.catalog)
  if (existsSync(catalogPath)) {
    const existing = loadCatalogFromFile(catalogPath) as CatalogShape
    if (Object.hasOwn(existing.plugins, name)) {
      throw new Error(
        `plugin '${name}' is already registered in the catalog; use the submodule/catalog ` +
          `workflow to convert an existing entry instead of \`lab new\``,
      )
    }
  }
  const target = join(root, ROOT_PATHS.plugins, name)
  // Refuse any existing target that holds ANY entry (including .git or
  // node_modules). Uses an unfiltered listing: the template filters for .git /
  // node_modules must NOT apply here, or an already-initialized repo would be
  // mistaken for empty and deleted below.
  if (existsSync(target) && readdirSync(target, { withFileTypes: true }).length > 0) {
    throw new Error(`plugin target already exists and is non-empty: ${target}`)
  }
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  render(TEMPLATES, target, name)

  // Self-contained tsconfig.json (see comment above).
  writeFileSync(
    join(target, 'tsconfig.json'),
    JSON.stringify(STANDALONE_TSCONFIG, null, 2) + '\n',
  )

  // Write the canonical shared-context snapshot so a fresh `lab new` leaves
  // `lab doctor` clean (criterion 10 / criterion 9 self-sufficiency): a
  // `not-synced` placeholder would be flagged as stale by the doctor loop.
  mkdirSync(join(target, '.dsh-lab'), { recursive: true })
  writeFileSync(
    join(target, '.dsh-lab', 'shared-context.md'),
    snapshotContext(root, contextDocuments(root)),
  )

  execFileSync('git', ['init', '-q'], { cwd: target, stdio: 'ignore' })

  // Register the new plugin in the meta-repo catalog so `lab dev`/`lab verify`
  // can resolve it (criterion 4). Read an existing catalog, add the entry, write
  // back; create catalog.yaml if it is absent.
  let catalog: CatalogShape
  if (existsSync(catalogPath)) {
    catalog = loadCatalogFromFile(catalogPath) as CatalogShape
  } else {
    catalog = { plugins: {} }
  }
  catalog.plugins[name] = {
    path: `plugins/${name}`,
    tracking: 'local',
    maturity: 'experiment',
  }
  writeFileSync(catalogPath, dumpYaml(catalog, { noRefs: true, lineWidth: 120 }) + '\n')

  return target
}
