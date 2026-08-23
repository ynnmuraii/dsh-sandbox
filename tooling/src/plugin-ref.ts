import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadCatalogFromFile, type CatalogEntry } from './schemas.js'
import { loadPluginConfig, type PluginConfig } from './create.js'
import { ROOT_PATHS, rootPath } from './context.js'

export interface PluginRef {
  sourcePath: string
  packageName: string
  catalogName?: string
  catalogEntry?: CatalogEntry
  metadata?: PluginConfig
}

export interface PluginSelector {
  name?: string
  path?: string
}

/**
 * Parse the plugin selector while leaving command-specific flags untouched.
 * The selector is the first positional argument, or the value of --path.
 */
export function parsePluginSelector(args: string[]): {
  selector: PluginSelector
  rest: string[]
} {
  let name: string | undefined
  let path: string | undefined
  let sawOption = false
  const rest: string[] = []

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--path') {
      sawOption = true
      const value = args[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--path requires a value')
      }
      if (path !== undefined) throw new Error('--path may be specified only once')
      path = value
      i += 1
      continue
    }
    if (arg.startsWith('--')) {
      sawOption = true
      rest.push(arg)
      // --target is the only selector-adjacent option whose value must not be
      // mistaken for a second positional selector. Keep both tokens in rest.
      if (arg === '--target' && args[i + 1] !== undefined) {
        rest.push(args[i + 1]!)
        i += 1
      }
      continue
    }
    if (!sawOption && name === undefined) {
      name = arg
      continue
    }
    if (name === undefined && path === undefined) {
      name = arg
      continue
    }
    throw new Error('conflicting positional names')
  }

  const identifiers = Number(name !== undefined) + Number(path !== undefined)
  if (identifiers !== 1) throw new Error('exactly one of plugin name or --path is required')
  return {
    selector: path === undefined ? { name: name! } : { path },
    rest,
  }
}

export function resolvePluginRef(opts: { root: string; selector: PluginSelector }): PluginRef {
  const { root, selector } = opts
  const identifiers = Number(selector.name !== undefined) + Number(selector.path !== undefined)
  if (identifiers !== 1) throw new Error('exactly one of plugin name or path is required')

  let sourcePath: string
  let catalogName: string | undefined
  let catalogEntry: CatalogEntry | undefined

  const catalogPath = rootPath(root, ROOT_PATHS.catalog)
  if (selector.name !== undefined) {
    const catalog = loadCatalogFromFile(catalogPath)
    const entry = catalog.plugins[selector.name]
    if (!entry) throw new Error(`plugin '${selector.name}' not found in catalog`)
    catalogName = selector.name
    catalogEntry = entry
    sourcePath = resolve(root, entry.path)
  } else {
    sourcePath = resolve(selector.path!)
  }

  if (!existsSync(sourcePath) || !statIsDirectory(sourcePath)) {
    throw new Error(`plugin source directory not found: ${sourcePath}`)
  }

  const packagePath = join(sourcePath, 'package.json')
  let packageJson: unknown
  try {
    packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
  } catch (e) {
    throw new Error(`cannot read package.json for plugin at ${sourcePath}: ${(e as Error).message}`, {
      cause: e,
    })
  }
  const packageName =
    typeof packageJson === 'object' && packageJson !== null && 'name' in packageJson
      ? (packageJson as { name?: unknown }).name
      : undefined
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new Error(`package.json for plugin at ${sourcePath} must declare a package name`)
  }

  const metadataPath = join(sourcePath, '.dsh-lab', 'plugin.yaml')
  const metadata = existsSync(metadataPath) ? loadPluginConfig(metadataPath) : undefined
  return {
    sourcePath,
    packageName,
    ...(catalogName === undefined ? {} : { catalogName }),
    ...(catalogEntry === undefined ? {} : { catalogEntry }),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function statIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
