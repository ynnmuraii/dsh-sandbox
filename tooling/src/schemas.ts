import { load as loadYaml, FAILSAFE_SCHEMA } from 'js-yaml'
import { readFileSync } from 'node:fs'

export interface TargetPin {
  dsh?: string
  cordis?: string
  node?: string
  pnpm?: string
  repository?: string
  commit?: string
  allowBuilds?: Record<string, boolean>
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

export class CompatibilityError extends Error {
  readonly code: string | undefined
  readonly target: 'next' | 'master' | undefined

  constructor(
    message: string,
    options?: { cause?: unknown; code?: string; target?: 'next' | 'master' },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CompatibilityError'
    this.code = options?.code
    this.target = options?.target
  }
}

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
const PIN_RANGE = /^(~|\^|>=|<=)?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?: \|\| .+)?$/

function requireField(kind: 'next' | 'master', pin: TargetPin, field: keyof TargetPin): void {
  if (pin[field] === undefined || pin[field] === '') {
    throw new CompatibilityError(
      `target '${kind}' requires a mandatory pin field '${field}'`,
    )
  }
}

function assertPin(kind: 'next' | 'master', pin: TargetPin): void {
  if (kind === 'next') {
    // Full mandatory shape: every field the next target pins must be present
    // and exact. An empty `next: {}` (or any missing field) is a config error,
    // not a valid "unpinned" target.
    for (const field of ['dsh', 'cordis', 'node', 'pnpm'] as const) {
      requireField(kind, pin, field)
    }
    for (const v of [pin.dsh, pin.cordis, pin.node, pin.pnpm]) {
      if (!EXACT_VERSION.test(v ?? '')) {
        throw new CompatibilityError(`next target requires an exact pinned version, got '${v}'`)
      }
    }
  } else {
    // Full mandatory shape: upstream identity + pinned commit + toolchain pins.
    for (const field of ['repository', 'commit', 'pnpm', 'node'] as const) {
      requireField(kind, pin, field)
    }
    if (!/^[0-9a-f]{40}$/.test(pin.commit!)) {
      throw new CompatibilityError('master target requires a 40-char pinned git commit')
    }
    for (const v of [pin.pnpm, pin.node]) {
      if (v !== undefined && !PIN_RANGE.test(v)) {
        throw new CompatibilityError(`master target requires a valid pinned version, got '${v}'`)
      }
    }
  }
}

function normalizeAllowBuilds(pin: TargetPin, kind: 'next' | 'master'): void {
  if (pin.allowBuilds === undefined) return
  const raw = pin.allowBuilds as unknown
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CompatibilityError(`target '${kind}' allowBuilds must be a package-to-boolean map`)
  }
  const normalized: Record<string, boolean> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== 'true' && value !== 'false' && typeof value !== 'boolean') {
      throw new CompatibilityError(
        `target '${kind}' allowBuilds.${name} must be boolean true or false`,
      )
    }
    normalized[name] = value === true || value === 'true'
  }
  pin.allowBuilds = normalized
}

function parseYaml(text: string, what: string): unknown {
  // FAILSAFE_SCHEMA keeps all scalars as strings. The default schema would
  // coerce an all-digit commit (e.g. the all-zero placeholder) to a number and
  // drop leading zeros, breaking the 40-char SHA contract.
  try {
    return loadYaml(text, { schema: FAILSAFE_SCHEMA })
  } catch (e) {
    throw new CompatibilityError(`invalid ${what}: ${(e as Error).message}`, { cause: e })
  }
}

export function loadCompatibility(text: string): Compatibility {
  const raw = parseYaml(text, 'compatibility manifest') as Compatibility
  if (!raw?.targets?.next || !raw?.targets?.master) {
    throw new CompatibilityError('compatibility manifest requires both next and master targets')
  }
  assertPin('next', raw.targets.next)
  assertPin('master', raw.targets.master)
  normalizeAllowBuilds(raw.targets.next, 'next')
  normalizeAllowBuilds(raw.targets.master, 'master')
  return raw
}

export function loadCompatibilityFromFile(path: string): Compatibility {
  return loadCompatibility(readFileSync(path, 'utf8'))
}

export function loadTargetPinFromFile(path: string, target: 'next' | 'master'): TargetPin {
  const raw = parseYaml(readFileSync(path, 'utf8'), 'compatibility manifest') as { targets?: Record<string, TargetPin> }
  const pin = raw?.targets?.[target]
  if (pin === undefined || pin === null || typeof pin !== 'object') {
    throw new CompatibilityError(`compatibility manifest missing target '${target}'`, {
      code: 'missing-target',
      target,
    })
  }
  assertPin(target, pin)
  normalizeAllowBuilds(pin, target)
  return pin
}

export function loadCatalog(text: string): Catalog {
  const raw = parseYaml(text, 'catalog') as Catalog
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
