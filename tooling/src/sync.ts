import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalogFromFile } from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'
import { contextDigest, normalizeGeneratedText } from './skill.js'

export { contextDigest } from './skill.js'

export interface SyncedResult {
  kind: 'plugin-context' | 'agent-skill'
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
  const digest = contextDigest(reads)
  const body = reads
    .map(text => normalizeGeneratedText(text).trimEnd())
    .join('\n\n---\n\n')
  return `${SNAPSHOT_HEADER}\n> context version: ${digest}\n> regenerate with \`lab sync-context\`\n\n${body}\n`
}

export function contextDocuments(root: string): string[] {
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

  // Refuse to "synchronize" a missing plugin repo: creating `.dsh-lab` inside a
  // directory that is not an existing nested git repo would manufacture a
  // partial, untracked plugin rather than refresh an author's real standalone
  // repo. Validate every target's repo up front so we fail before writing any.
  const missing = targets.filter(
    name => !isNestedRepo(join(root, catalog.plugins[name]!.path)),
  )
  if (missing.length > 0) {
    throw new Error(
      `cannot sync-context: plugin repo missing or not a git repo: ${missing.join(', ')}`,
    )
  }

  const results: SyncedResult[] = []
  for (const name of targets) {
    const entry = catalog.plugins[name]!
    const path = join(root, entry.path, '.dsh-lab', 'shared-context.md')
    mkdirSync(join(path, '..'), { recursive: true })
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
    const changed = existing !== snapshot
    if (changed) writeFileSync(path, snapshot)
    results.push({ kind: 'plugin-context', name, changed, path })
  }
  return results
}

// A plugin's `.dsh-lab` lives inside a standalone nested git repo. On a
// submodule the repo's `.git` is a gitlink marker file (`gitdir: …`) rather
// than a directory, so a presence check must accept both.
function isNestedRepo(dir: string): boolean {
  const marker = join(dir, '.git')
  if (!existsSync(marker)) return false
  try {
    const st = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return st.trim().length > 0
  } catch {
    return false
  }
}
