import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalogFromFile } from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'

export interface SyncedResult {
  name: string
  changed: boolean
  path: string
}

export interface SyncOptions {
  root: string
  names: string[]
  all: boolean
}

const SNAPSHOT_HEADER = '# Shared context snapshot\n'

export function snapshotContext(root: string, reads: string[]): string {
  const hash = createHash('sha256')
  for (const text of reads) hash.update(text)
  const digest = hash.digest('hex').slice(0, 12)
  const body = reads.map(t => t.trimEnd()).join('\n\n---\n\n')
  return `${SNAPSHOT_HEADER}\n> context version: ${digest}\n> regenerate with \`lab sync-context\`\n\n${body}\n`
}

function contextDocuments(root: string): string[] {
  const dir = rootPath(root, ROOT_PATHS.contextDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => readFileSync(join(dir, f), 'utf8'))
}

export async function syncContext({ root, names, all }: SyncOptions): Promise<SyncedResult[]> {
  const catalogPath = rootPath(root, ROOT_PATHS.catalog)
  const catalog = existsSync(catalogPath) ? loadCatalogFromFile(catalogPath) : { plugins: {} }
  const docs = contextDocuments(root)
  const snapshot = snapshotContext(root, docs)

  const targets = all
    ? Object.keys(catalog.plugins)
    : names.filter(n => Object.hasOwn(catalog.plugins, n))

  const results: SyncedResult[] = []
  for (const name of targets) {
    const entry = catalog.plugins[name]!
    const path = join(root, entry.path, '.dsh-lab', 'shared-context.md')
    mkdirSync(join(path, '..'), { recursive: true })
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
    const changed = existing !== snapshot
    if (changed) writeFileSync(path, snapshot)
    results.push({ name, changed, path })
  }
  return results
}
