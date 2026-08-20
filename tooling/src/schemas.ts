import { load as loadYaml, FAILSAFE_SCHEMA } from 'js-yaml'
import { readFileSync } from 'node:fs'

export interface TargetPin {
  dsh?: string
  cordis?: string
  node?: string
  pnpm?: string
  repository?: string
  commit?: string
}

export interface Compatibility {
  targets: Record<'next' | 'master', TargetPin>
}

// Declared by Task 5 (`new`) from `.dsh-lab/plugin.yaml`; validated there.
export interface PluginConfig {
  name: string
  targets: string[]
  tracking: string
}

export class CompatibilityError extends Error {}

export interface CatalogEntry {
  path: string
  repository?: string
  tracking: 'local' | 'submodule'
  maturity?: 'experiment' | 'stable'
}

export interface Catalog {
  plugins: Record<string, CatalogEntry>
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function assertPin(kind: 'next' | 'master', pin: TargetPin): void {
  if (kind === 'next') {
    for (const v of [pin.dsh, pin.cordis, pin.node]) {
      if (v !== undefined && !EXACT_VERSION.test(v)) {
        throw new CompatibilityError(`next target requires an exact pinned version, got '${v}'`)
      }
    }
  } else {
    if (!pin.commit || !/^[0-9a-f]{40}$/.test(pin.commit)) {
      throw new CompatibilityError('master target requires a 40-char pinned git commit')
    }
  }
}

export function loadCompatibility(text: string): Compatibility {
  // FAILSAFE_SCHEMA keeps all scalars as strings. The default schema would
  // coerce an all-digit commit (e.g. the all-zero placeholder) to a number and
  // drop leading zeros, breaking the 40-char SHA contract.
  const raw = loadYaml(text, { schema: FAILSAFE_SCHEMA }) as Compatibility
  if (!raw?.targets?.next || !raw?.targets?.master) {
    throw new CompatibilityError('compatibility manifest requires both next and master targets')
  }
  assertPin('next', raw.targets.next)
  assertPin('master', raw.targets.master)
  return raw
}

export function loadCompatibilityFromFile(path: string): Compatibility {
  return loadCompatibility(readFileSync(path, 'utf8'))
}

export function loadCatalog(text: string): Catalog {
  const raw = loadYaml(text, { schema: FAILSAFE_SCHEMA }) as Catalog
  if (!raw?.plugins || typeof raw.plugins !== 'object') {
    throw new CompatibilityError('catalog requires a plugins map')
  }
  for (const [name, entry] of Object.entries(raw.plugins)) {
    if (!entry.path) {
      throw new CompatibilityError(`catalog entry '${name}' requires a path`)
    }
    if (entry.tracking !== 'local' && entry.tracking !== 'submodule') {
      throw new CompatibilityError(`catalog entry '${name}' has invalid tracking '${entry.tracking}'`)
    }
    if (entry.tracking === 'submodule' && !entry.repository) {
      throw new CompatibilityError(`submodule entry '${name}' requires a repository`)
    }
  }
  return raw
}

export function loadCatalogFromFile(path: string): Catalog {
  return loadCatalog(readFileSync(path, 'utf8'))
}
