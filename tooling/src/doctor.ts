import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCompatibility, loadCompatibilityFromFile, loadCatalogFromFile } from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'
import { snapshotContext, contextDocuments } from './sync.js'
import { verifyUpstreamCommit } from './upstream.js'

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
  const compatPath = rootPath(root, ROOT_PATHS.compatibility)
  if (!existsSync(compatPath)) {
    out.push({ level: 'error', message: `missing compatibility manifest: ${compatPath}` })
    return out
  }

  let compat
  try {
    compat = loadCompatibilityFromFile(compatPath)
  } catch (e) {
    out.push({ level: 'error', message: `invalid compatibility manifest: ${(e as Error).message}` })
    return out
  }

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

  return out
}
