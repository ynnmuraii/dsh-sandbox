import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCompatibility, loadCompatibilityFromFile } from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'

export interface DiagnosticResult {
  level: 'error' | 'warn'
  message: string
}

export interface DoctorOptions {
  root: string
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

  const upstreamPath = rootPath(root, ROOT_PATHS.upstream)
  if (!existsSync(join(upstreamPath, '.git'))) {
    out.push({ level: 'warn', message: `upstream checkout missing or not a git dir: ${upstreamPath}` })
  }

  return out
}
