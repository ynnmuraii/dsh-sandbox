import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import { loadCompatibility, loadCompatibilityFromFile, loadCatalogFromFile } from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'
import { contextDocuments, snapshotContext } from './sync.js'
import {
  AGENT_SKILL_PATH,
  normalizeGeneratedText,
  renderAgentSkill,
  SKILL_SOURCE_PATH,
} from './skill.js'
import { verifyUpstreamCommit } from './upstream.js'
import { pnpm } from './proc.js'

export interface DiagnosticResult {
  level: 'error' | 'warn'
  message: string
}

export interface DoctorOptions {
  root: string
}

// Canonical "context version: <digest>" line inside a shared-context snapshot.
function contextVersion(snapshot: string): string | undefined {
  const m = /^> context version: (\S+)$/m.exec(snapshot)
  return m?.[1]
}

function workingTreeDirty(dir: string): boolean {
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

export async function doctor({ root }: DoctorOptions): Promise<DiagnosticResult[]> {
  const out: DiagnosticResult[] = []
  // Run the isolated, read-only skill gate first so diagnostics survive any
  // unrelated compatibility, catalog, or toolchain failure below.
  out.push(...portableSkillDiagnostics(root))
  const compatPath = rootPath(root, ROOT_PATHS.compatibility)
  let compat: ReturnType<typeof loadCompatibilityFromFile> | undefined
  if (!existsSync(compatPath)) {
    out.push({ level: 'error', message: `missing compatibility manifest: ${compatPath}` })
  } else {
    try {
      compat = loadCompatibilityFromFile(compatPath)
    } catch (e) {
      out.push({ level: 'error', message: `invalid compatibility manifest: ${(e as Error).message}` })
    }
  }

  if (compat) {
    const expectedNode = compat.targets.next.node
    if (expectedNode) {
      const actual = process.versions.node
      if (actual !== expectedNode) {
        out.push({
          level: 'error',
          message: `node version mismatch: manifest pins ${expectedNode}, running ${actual}`,
        })
      }
    }

    // Toolchain pin gate (§14): the pinned pnpm version must match the running
    // one, or a later install/verify against the pinned targets is not faithful.
    const expectedPnpm = compat.targets.next.pnpm
    if (expectedPnpm) {
      const actual = pnpm(['--version'], { encoding: 'utf8' }).toString().trim()
      if (actual !== expectedPnpm) {
        out.push({
          level: 'error',
          message: `pnpm version mismatch: manifest pins ${expectedPnpm}, running ${actual}`,
        })
      }
    }
  }

  const catalogPath = rootPath(root, ROOT_PATHS.catalog)
  if (!existsSync(catalogPath)) {
    out.push({ level: 'warn', message: `catalog not found: ${catalogPath}` })
  } else {
    try {
      readFileSync(catalogPath, 'utf8')
    } catch (e) {
      out.push({ level: 'error', message: `unreadable catalog: ${(e as Error).message}` })
    }
  }

  // Upstream submodule must be present, pinned to the recorded master commit,
  // and clean (criterion 10). A missing/mismatched/dirty upstream is an error:
  // a master verify against it would not be a faithful pinned run.
  const upstreamPath = rootPath(root, ROOT_PATHS.upstream)
  if (!existsSync(join(upstreamPath, '.git'))) {
    out.push({
      level: 'error',
      message: `upstream checkout missing or not a git dir: ${upstreamPath}`,
    })
  } else {
    if (compat) {
      const pin = compat.targets.master.commit
      if (!pin) {
        out.push({
          level: 'error',
          message: 'compatibility manifest is missing the master commit pin',
        })
      } else if (!(await verifyUpstreamCommit(root, pin))) {
        out.push({
          level: 'error',
          message: `upstream HEAD does not match pinned master commit ${pin} (run in ${upstreamPath})`,
        })
      }
    }
    if (workingTreeDirty(upstreamPath)) {
      out.push({
        level: 'error',
        message: `upstream submodule working tree is dirty: ${upstreamPath}`,
      })
    }
  }

  // Stale shared-context snapshots: every cataloged plugin's committed snapshot
  // must carry the canonical context digest (criterion 10).
  if (existsSync(catalogPath)) {
    try {
      const catalog = loadCatalogFromFile(catalogPath)
      const canonical = snapshotContext(root, contextDocuments(root))
      const expected = contextVersion(canonical)
      for (const [name, entry] of Object.entries(catalog.plugins)) {
        const snapshotPath = join(root, entry.path, '.dsh-lab', 'shared-context.md')
        const actual = existsSync(snapshotPath)
          ? contextVersion(readFileSync(snapshotPath, 'utf8'))
          : undefined
        if (actual === undefined || expected === undefined || actual !== expected) {
          out.push({
            level: 'error',
            message:
              `stale shared context for plugin '${name}': snapshot ${actual ?? 'missing'}, ` +
              `canonical ${expected ?? 'unknown'} (run \`lab sync-context ${name}\`)`,
          })
        }
      }
    } catch (e) {
      out.push({
        level: 'error',
        message: `cannot read catalog for context check: ${(e as Error).message}`,
      })
    }
  }

  // Plugin pin + repo integrity gate (§14 / §16.10). For every cataloged plugin:
  // (a) a declared target's exact Cordis dependency (peer and dev) must equal
  // the compatibility pin, and (b) a `tracking: submodule` entry must be present,
  // tracked as a gitlink by the meta-repo, and free of working-tree dirt — all
  // without modifying the plugin repo.
  if (existsSync(catalogPath)) {
    try {
      const catalog = loadCatalogFromFile(catalogPath)
      for (const [name, entry] of Object.entries(catalog.plugins)) {
        const pluginDir = join(root, entry.path)
        const yamlPath = join(pluginDir, '.dsh-lab', 'plugin.yaml')
        const pkgPath = join(pluginDir, 'package.json')
        if (existsSync(yamlPath) && existsSync(pkgPath)) {
          let cfg: { targets?: string[] }
          try {
            cfg = JSON.parse(JSON.stringify(loadYaml(readFileSync(yamlPath, 'utf8')))) as {
              targets?: string[]
            }
          } catch (e) {
            cfg = {}
            out.push({
              level: 'error',
              message: `plugin '${name}' has an unreadable .dsh-lab/plugin.yaml: ${(e as Error).message}`,
            })
          }
          try {
            const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
              peerDependencies?: Record<string, string>
              devDependencies?: Record<string, string>
            }
            for (const target of cfg.targets ?? []) {
              const pin = compat
                ? (compat.targets as Record<string, { cordis?: string }>)[target]?.cordis
                : undefined
              if (!pin) continue
              for (const field of ['peerDependencies', 'devDependencies'] as const) {
                const actual = pkg[field]?.['@deepseek-ai/cordis']
                if (actual !== pin) {
                  out.push({
                    level: 'error',
                    message:
                      `plugin '${name}' ${field}['@deepseek-ai/cordis'] is '${actual ?? '(missing)'}', ` +
                      `does not match declared target '${target}' pin '${pin}'`,
                  })
                }
              }
            }
          } catch (e) {
            out.push({
              level: 'error',
              message: `plugin '${name}' has an unreadable package.json: ${(e as Error).message}`,
            })
          }
        }
        if (entry.tracking === 'submodule') {
          const submoduleErrors = submoduleDiagnostics(root, entry.path)
          for (const msg of submoduleErrors) {
            out.push({ level: 'error', message: msg })
          }
        }
      }
    } catch (e) {
      out.push({
        level: 'error',
        message: `cannot read catalog for plugin pin check: ${(e as Error).message}`,
      })
    }
  }

  return out
}

function portableSkillDiagnostics(root: string): DiagnosticResult[] {
  const out: DiagnosticResult[] = []
  const sourcePath = rootPath(root, SKILL_SOURCE_PATH)
  const projectionPath = rootPath(root, AGENT_SKILL_PATH)

  let body: string
  try {
    body = readFileSync(sourcePath, 'utf8')
  } catch (error) {
    const kind = errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable'
    out.push({
      level: 'error',
      message: `agent skill source ${kind}: ${sourcePath}${formatError(error)}`,
    })
    return out
  }

  let expected: string
  try {
    expected = renderAgentSkill({ body, documents: contextDocuments(root) })
  } catch (error) {
    out.push({
      level: 'error',
      message: `agent skill source invalid: ${sourcePath}${formatError(error)}`,
    })
    return out
  }

  let actual: string
  try {
    actual = readFileSync(projectionPath, 'utf8')
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      out.push({
        level: 'error',
        message: `agent skill projection unreadable: ${projectionPath}${formatError(error)}`,
      })
      return out
    }
    out.push({
      level: 'error',
      message: `stale agent skill: ${projectionPath} (run \`lab sync-context\`)`,
    })
    return out
  }

  if (normalizeGeneratedText(actual) !== normalizeGeneratedText(expected)) {
    out.push({
      level: 'error',
      message: `stale agent skill: ${projectionPath} (run \`lab sync-context\`)`,
    })
  }
  return out
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function formatError(error: unknown): string {
  return ` (${error instanceof Error ? error.message : String(error)})`
}

// Diagnostics for a cataloged `tracking: submodule` plugin repo, without
// modifying anything: presence, meta-repo gitlink, and working-tree cleanliness.
function submoduleDiagnostics(root: string, relPath: string): string[] {
  const out: string[] = []
  const dir = join(root, relPath)
  if (!existsSync(join(dir, '.git'))) {
    out.push(`cataloged submodule '${relPath}' is missing (expected a git repo at ${dir})`)
    return out
  }
  // The parent must track the path as a gitlink (mode 160000), not a regular
  // file, and the gitlink's recorded object ID must match the nested repo's
  // current HEAD — a submodule checked out at a DIFFERENT commit has an empty
  // `status --porcelain` but is still not the recorded pin.
  try {
    const stage = execFileSync('git', ['ls-files', '--stage', '--', relPath.replace(/\\/g, '/')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const hit = /^160000\s+([0-9a-f]{40})\s+\d+\t/.exec(stage.trim())
    if (!hit) {
      out.push(`cataloged submodule '${relPath}' is not tracked as a gitlink by the meta-repo`)
    } else {
      const recorded = hit[1]
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (head !== recorded) {
        out.push(
          `cataloged submodule '${relPath}' HEAD ${head} does not match the meta-repo gitlink ${recorded}`,
        )
      }
    }
  } catch (e) {
    out.push(`cannot inspect meta-repo gitlink for submodule '${relPath}': ${(e as Error).message}`)
  }
  if (workingTreeDirty(dir)) {
    out.push(`cataloged submodule '${relPath}' working tree is dirty: ${dir}`)
  }
  return out
}
