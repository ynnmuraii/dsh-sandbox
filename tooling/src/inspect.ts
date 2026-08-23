import {
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { extname, join } from 'node:path'
import type { PluginRef } from './plugin-ref.js'
import { ROOT_PATHS, rootPath } from './context.js'
import { loadCompatibilityFromFile, type Compatibility, type TargetPin } from './schemas.js'

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface InspectDiagnostic {
  code: string
  severity: DiagnosticSeverity
  message: string
  location?: string
  remediation?: string
}

export interface InspectionResult {
  schemaVersion: 1
  plugin: { packageName: string; sourcePath: string }
  faces: { host: boolean; client: boolean | 'unknown' }
  diagnostics: InspectDiagnostic[]
  ok: boolean
}

type JsonObject = Record<string, unknown>

const REQUIRED_SCRIPTS = ['typecheck', 'test', 'build', 'pack-smoke'] as const
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

/**
 * Inspect a plugin's source contracts without executing plugin-controlled code.
 * Every rule below only reads files and returns diagnostics; this function has
 * no package-manager, process, or git side effects.
 */
export function inspectPlugin(opts: {
  root: string
  plugin: PluginRef
  target?: 'next' | 'master'
}): InspectionResult {
  const { root, plugin } = opts
  const sourcePath = plugin.sourcePath
  const diagnostics: InspectDiagnostic[] = []
  const packagePath = join(sourcePath, 'package.json')
  let pkg: JsonObject = {}

  try {
    pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as JsonObject
  } catch (error) {
    diagnostics.push({
      code: 'PACKAGE_JSON_UNREADABLE',
      severity: 'error',
      message: `cannot read package.json: ${errorMessage(error)}`,
      location: packagePath,
      remediation: 'Create a valid JSON package manifest.',
    })
  }

  packageRules(pkg, packagePath, sourcePath, diagnostics)
  bundleRules(pkg, packagePath, sourcePath, diagnostics)
  fileCoverageRules(pkg, packagePath, diagnostics)
  privateImportRules(sourcePath, diagnostics)

  const selectedTarget = opts.target ?? metadataTarget(plugin)
  if (selectedTarget !== undefined) {
    compatibilityRules(root, pkg, selectedTarget, packagePath, diagnostics)
  }

  const diagnosticsSorted = diagnostics
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code) || (a.location ?? '').localeCompare(b.location ?? ''))
  const client = inferClientFace(pkg, plugin)
  const host = inferHostFace(pkg)
  return {
    schemaVersion: 1,
    plugin: { packageName: plugin.packageName, sourcePath },
    faces: { host, client },
    diagnostics: diagnosticsSorted,
    ok: diagnosticsSorted.every(diagnostic => diagnostic.severity !== 'error'),
  }
}

function packageRules(
  pkg: JsonObject,
  packagePath: string,
  sourcePath: string,
  diagnostics: InspectDiagnostic[],
): void {
  if (pkg.type !== 'module') {
    diagnostics.push({
      code: 'PACKAGE_NOT_ESM',
      severity: 'error',
      message: "package.json must declare type: 'module'",
      location: packagePath,
      remediation: "Set package.json's type to 'module'.",
    })
  }

  const packageManager = pkg.packageManager
  if (
    typeof packageManager !== 'string' ||
    !/^pnpm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageManager)
  ) {
    diagnostics.push({
      code: 'PACKAGE_MANAGER_MISMATCH',
      severity: 'error',
      message: 'packageManager must be an exact pnpm@<version> declaration',
      location: packagePath,
      remediation: 'Pin pnpm in package.json, for example pnpm@11.7.0.',
    })
  }

  const lockfile = join(sourcePath, 'pnpm-lock.yaml')
  if (!isFile(lockfile)) {
    diagnostics.push({
      code: 'LOCKFILE_MISSING',
      severity: 'error',
      message: 'pnpm-lock.yaml is required',
      location: lockfile,
      remediation: 'Generate and commit the lockfile.',
    })
  }

  const workspace = join(sourcePath, 'pnpm-workspace.yaml')
  if (!isFile(workspace)) {
    diagnostics.push({
      code: 'WORKSPACE_BOUNDARY_MISSING',
      severity: 'error',
      message: 'standalone pnpm-workspace.yaml boundary is required',
      location: workspace,
      remediation: 'Add pnpm-workspace.yaml with the plugin as its workspace.',
    })
  }

  const scripts = asObject(pkg.scripts)
  for (const script of REQUIRED_SCRIPTS) {
    if (typeof scripts?.[script] !== 'string' || scripts[script] === '') {
      diagnostics.push({
        code: 'SCRIPT_MISSING',
        severity: 'error',
        message: `required script '${script}' is missing`,
        location: `${packagePath}#/scripts/${script}`,
        remediation: `Declare a package script named '${script}'.`,
      })
    }
  }

  const main = packagePathValue(pkg.main)
  const types = packagePathValue(pkg.types)
  const exportsValue = asObject(pkg.exports)
  const rootExport = typeof pkg.exports === 'string' ? pkg.exports : exportsValue?.['.']
  const defaultExport = exportPath(rootExport, 'default')
  const typeExport = exportPath(rootExport, 'types')
  if (!main || !types || !rootExport || !defaultExport || !typeExport ||
      normalizePackagePath(main) !== normalizePackagePath(defaultExport) ||
      normalizePackagePath(types) !== normalizePackagePath(typeExport)) {
    diagnostics.push({
      code: 'EXPORT_MISMATCH',
      severity: 'error',
      message: 'main/types must match the package root exports default/types entries',
      location: `${packagePath}#/exports`,
      remediation: 'Align main, types, and exports["."] paths to the same runtime artifacts.',
    })
  }
}

function bundleRules(
  pkg: JsonObject,
  packagePath: string,
  sourcePath: string,
  diagnostics: InspectDiagnostic[],
): void {
  const dsh = asObject(pkg.dsh)
  const bundle = asObject(dsh?.bundle)
  const patch = typeof bundle?.patch === 'string' && bundle.patch.length > 0 ? bundle.patch : undefined
  if (patch === undefined) {
    diagnostics.push({
      code: 'BUNDLE_PATCH_MISSING',
      severity: 'error',
      message: 'dsh.bundle.patch must name the bundle patch file',
      location: `${packagePath}#/dsh/bundle/patch`,
      remediation: 'Declare dsh.bundle.patch and include the referenced patch file.',
    })
    return
  }
  const patchPath = join(sourcePath, patch)
  if (!isFile(patchPath)) {
    diagnostics.push({
      code: 'BUNDLE_PATCH_MISSING',
      severity: 'error',
      message: `bundle patch does not exist: ${patch}`,
      location: patchPath,
      remediation: 'Create the referenced patch file or correct dsh.bundle.patch.',
    })
  }
}

function fileCoverageRules(
  pkg: JsonObject,
  packagePath: string,
  diagnostics: InspectDiagnostic[],
): void {
  const files = Array.isArray(pkg.files) ? pkg.files.filter((value): value is string => typeof value === 'string') : []
  const main = packagePathValue(pkg.main)
  const types = packagePathValue(pkg.types)
  const patch = bundlePatch(pkg)
  const covered = (path: string | undefined): boolean => {
    if (path === undefined) return false
    const normalized = normalizePackagePath(path)
    return files.some(entry => {
      const candidate = normalizePackagePath(entry)
      return candidate === normalized || normalized.startsWith(`${candidate}/`) || candidate === normalizePackagePath(dirnameFor(path))
    })
  }
  for (const [label, path] of [['main', main], ['types', types], ['bundle patch', patch]] as const) {
    if (path !== undefined && !covered(path)) {
      diagnostics.push({
        code: 'FILES_COVERAGE_MISSING',
        severity: 'error',
        message: `${label} '${path}' is not covered by package files`,
        location: `${packagePath}#/files`,
        remediation: 'Add the runtime artifact directory and bundle patch to files.',
      })
    }
  }
  // A files array is required for an explicit standalone package boundary.
  if (!Array.isArray(pkg.files)) {
    diagnostics.push({
      code: 'FILES_COVERAGE_MISSING',
      severity: 'error',
      message: 'package.json must declare files coverage for runtime artifacts and the bundle patch',
      location: `${packagePath}#/files`,
      remediation: 'Declare files including lib and the dsh bundle patch.',
    })
  }
}

function privateImportRules(sourcePath: string, diagnostics: InspectDiagnostic[]): void {
  for (const file of sourceFiles(sourcePath)) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!/(?:upstream[\\/]+deepseek-harness|deepseek-harness[\\/]src)/i.test(content)) continue
    diagnostics.push({
      code: 'PRIVATE_UPSTREAM_IMPORT',
      severity: 'error',
      message: 'production source imports a private upstream checkout',
      location: file,
      remediation: 'Import only public npm APIs from production plugin code.',
    })
  }
}

function compatibilityRules(
  root: string,
  pkg: JsonObject,
  target: 'next' | 'master',
  packagePath: string,
  diagnostics: InspectDiagnostic[],
): void {
  let compatibility: Compatibility
  try {
    compatibility = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))
  } catch {
    diagnostics.push({
      code: 'COMPATIBILITY_UNKNOWN',
      severity: 'warning',
      message: `cannot load compatibility pins for target '${target}'`,
      location: rootPath(root, ROOT_PATHS.compatibility),
      remediation: 'Provide a valid workbench/compatibility.yaml to enable pin checks.',
    })
    return
  }
  const pin = compatibility.targets[target]
  if (!pin) return

  const peer = asObject(pkg.peerDependencies)
  const dev = asObject(pkg.devDependencies)
  for (const dependency of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools'] as const) {
    const expected = dependency === '@deepseek-ai/cordis' ? pin.cordis : pin.dsh
    if (expected === undefined) continue
    for (const [field, values] of [['peerDependencies', peer], ['devDependencies', dev] ] as const) {
      const actual = values?.[dependency]
      if (actual !== expected) {
        diagnostics.push({
          code: 'DEPENDENCY_PIN_MISMATCH',
          severity: 'error',
          message: `${field}[${JSON.stringify(dependency)}] is '${typeof actual === 'string' ? actual : '(missing)'}', expected '${expected}' for target '${target}'`,
          location: `${packagePath}#/${field}/${dependency}`,
          remediation: `Pin ${dependency} to ${expected} in both peerDependencies and devDependencies.`,
        })
      }
    }
  }

  packageManagerPin(pkg, pin, packagePath, diagnostics)
}

function packageManagerPin(
  pkg: JsonObject,
  pin: TargetPin,
  packagePath: string,
  diagnostics: InspectDiagnostic[],
): void {
  if (typeof pin.pnpm !== 'string') return
  if (pkg.packageManager !== `pnpm@${pin.pnpm}`) {
    diagnostics.push({
      code: 'PACKAGE_MANAGER_MISMATCH',
      severity: 'error',
      message: `packageManager must match compatibility pin pnpm@${pin.pnpm}`,
      location: packagePath,
      remediation: `Set packageManager to pnpm@${pin.pnpm}.`,
    })
  }
}

function inferHostFace(pkg: JsonObject): boolean {
  const dsh = asObject(pkg.dsh)
  const explicit = dsh?.host ?? (dsh?.faces && asObject(dsh.faces)?.host)
  return typeof explicit === 'boolean' ? explicit : typeof pkg.main === 'string' || hasRootExport(pkg)
}

function inferClientFace(pkg: JsonObject, plugin: PluginRef): boolean | 'unknown' {
  const dsh = asObject(pkg.dsh)
  const dshFaces = asObject(dsh?.faces)
  const metadata = plugin.metadata as unknown as JsonObject | undefined
  const metadataFaces = asObject(metadata?.faces)
  for (const value of [dsh?.client, dshFaces?.client, metadata?.client, metadataFaces?.client]) {
    if (typeof value === 'boolean') return value
    if (value !== undefined && value !== null) return true
  }
  const exportsValue = asObject(pkg.exports)
  if (exportsValue) {
    for (const key of Object.keys(exportsValue)) {
      if (/^(?:\.?\/?)(?:client|browser|web)(?:\.|\/|$)/i.test(key)) return true
    }
  }
  return 'unknown'
}

function hasRootExport(pkg: JsonObject): boolean {
  return typeof pkg.exports === 'string' || Boolean(asObject(pkg.exports)?.['.'])
}

function metadataTarget(plugin: PluginRef): 'next' | 'master' | undefined {
  const targets = plugin.metadata?.targets
  if (!Array.isArray(targets)) return undefined
  const target = targets.find(value => value === 'next' || value === 'master')
  return target as 'next' | 'master' | undefined
}

function bundlePatch(pkg: JsonObject): string | undefined {
  const dsh = asObject(pkg.dsh)
  const bundle = asObject(dsh?.bundle)
  return typeof bundle?.patch === 'string' ? bundle.patch : undefined
}

function packagePathValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function exportPath(value: unknown, condition: 'default' | 'types'): string | undefined {
  if (typeof value === 'string') return condition === 'default' ? value : undefined
  const object = asObject(value)
  const path = object?.[condition]
  return typeof path === 'string' ? path : undefined
}

function normalizePackagePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
}

function dirnameFor(value: string): string {
  const normalized = normalizePackagePath(value)
  const slash = normalized.lastIndexOf('/')
  return slash < 0 ? normalized : normalized.slice(0, slash)
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function sourceFiles(root: string): string[] {
  const out: string[] = []
  const ignored = new Set([
    'node_modules',
    '.git',
    '.lab',
    'lib',
    'dist',
    'coverage',
    'test',
    'tests',
    '__tests__',
    'scripts',
  ])
  const visit = (directory: string): void => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()) &&
        !/(?:\.spec|\.test)\.[^.]+$/i.test(entry.name)
      ) out.push(path)
    }
  }
  visit(root)
  return out.sort()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
