import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

export interface PluginSnapshot {
  runRoot: string
  workspacePath: string
  digest: `sha256:${string}`
  files: string[]
  cleanup(): void
}

export interface CreatePluginSnapshotOptions {
  sourcePath: string
  runtimeRoot: string
  /** Test seam for asserting cleanup failures without changing Node globals. */
  removeRunRoot?: (runRoot: string) => void
}

type SnapshotEntry = FileEntry | SymlinkEntry

interface BaseEntry {
  absolutePath: string
  relativePath: string
}

interface FileEntry extends BaseEntry {
  kind: 'file'
}

interface SymlinkEntry extends BaseEntry {
  kind: 'symlink'
  linkTarget: string
  digestTarget: string
  linkType: 'file' | 'dir'
}

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  '.lab',
  'lib',
  'dist',
  'coverage',
])

export function computePluginDigest(sourcePath: string): {
  digest: `sha256:${string}`
  files: string[]
} {
  const entries = collectEntries(sourcePath)
  return digestEntries(entries)
}

export function createPluginSnapshot(opts: CreatePluginSnapshotOptions): PluginSnapshot {
  const entries = collectEntries(opts.sourcePath)
  const { digest, files } = digestEntries(entries)

  mkdirSync(opts.runtimeRoot, { recursive: true })

  let runRoot: string | undefined
  try {
    runRoot = mkdtempSync(join(opts.runtimeRoot, 'verify-'))
    const workspacePath = join(runRoot, 'workspace')
    mkdirSync(workspacePath)
    copyEntries(entries, workspacePath)

    let cleaned = false
    const remove = opts.removeRunRoot ?? defaultRemoveRunRoot
    const cleanup = (): void => {
      if (cleaned) return
      if (!existsSync(runRoot!)) {
        cleaned = true
        return
      }
      try {
        remove(runRoot!)
        cleaned = true
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to remove snapshot run root ${runRoot}: ${detail}`)
      }
    }

    return { runRoot, workspacePath, digest, files, cleanup }
  } catch (error) {
    if (runRoot !== undefined) {
      try {
        defaultRemoveRunRoot(runRoot)
      } catch (cleanupError) {
        const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        const original = error instanceof Error ? error.message : String(error)
        throw new Error(
          `Failed to construct plugin snapshot; could not remove run root ${runRoot}: ${detail}; original error: ${original}`,
        )
      }
    }
    throw error
  }
}

function collectEntries(sourcePath: string): SnapshotEntry[] {
  const sourceRoot = realpathSync(sourcePath)
  if (!statSync(sourceRoot).isDirectory()) {
    throw new Error(`Plugin snapshot source is not a directory: ${sourcePath}`)
  }

  const entries: SnapshotEntry[] = []
  visitDirectory(sourceRoot, sourceRoot, entries)
  entries.sort((left, right) => compareStrings(left.relativePath, right.relativePath))
  return entries
}

function visitDirectory(
  sourceRoot: string,
  directoryPath: string,
  entries: SnapshotEntry[],
): void {
  const directoryEntries = lstatSync(directoryPath).isDirectory()
    ? requireDirectoryEntries(directoryPath)
    : []

  for (const directoryEntry of directoryEntries) {
    const name = directoryEntry.name
    if (EXCLUDED_DIRECTORY_NAMES.has(name) || isExcludedEnvironmentFile(name)) continue

    const absolutePath = join(directoryPath, name)
    const relativePath = normalizeRelativePath(relative(sourceRoot, absolutePath))
    const stats = lstatSync(absolutePath)

    if (stats.isDirectory()) {
      visitDirectory(sourceRoot, absolutePath, entries)
      continue
    }

    if (stats.isFile()) {
      entries.push({ absolutePath, relativePath, kind: 'file' })
      continue
    }

    if (stats.isSymbolicLink()) {
      entries.push(validateSymlink(sourceRoot, absolutePath, relativePath))
      continue
    }

    throw new Error(`Unsupported filesystem entry in plugin snapshot: ${relativePath}`)
  }
}

function requireDirectoryEntries(directoryPath: string) {
  return readdirSync(directoryPath, { withFileTypes: true }).sort((left, right) =>
    compareStrings(left.name, right.name),
  )
}

function validateSymlink(
  sourceRoot: string,
  absolutePath: string,
  relativePath: string,
): SymlinkEntry {
  const linkTarget = readlinkSync(absolutePath)
  let resolvedTarget: string
  try {
    resolvedTarget = realpathSync(absolutePath)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Plugin snapshot symlink unresolved: ${relativePath} (${detail})`)
  }

  if (!isWithinRoot(sourceRoot, resolvedTarget)) {
    throw new Error(`Plugin snapshot symlink escapes plugin root: ${relativePath} -> ${linkTarget}`)
  }

  let linkType: 'file' | 'dir'
  try {
    linkType = statSync(absolutePath).isDirectory() ? 'dir' : 'file'
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Plugin snapshot symlink unresolved: ${relativePath} (${detail})`)
  }

  return {
    absolutePath,
    relativePath,
    kind: 'symlink',
    linkTarget,
    digestTarget: isAbsolute(linkTarget)
      ? normalizeRelativePath(relative(sourceRoot, resolvedTarget))
      : normalizeSymlinkTarget(linkTarget),
    linkType,
  }
}

function digestEntries(entries: SnapshotEntry[]): {
  digest: `sha256:${string}`
  files: string[]
} {
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry.relativePath, 'utf8')
    hash.update('\0', 'utf8')
    hash.update(entry.kind, 'utf8')
    hash.update('\0', 'utf8')

    if (entry.kind === 'file') {
      hash.update(readFileSync(entry.absolutePath))
    } else {
      hash.update(entry.digestTarget, 'utf8')
    }
    hash.update('\0', 'utf8')
  }

  return {
    digest: `sha256:${hash.digest('hex')}`,
    files: entries.map(entry => entry.relativePath),
  }
}

function copyEntries(entries: SnapshotEntry[], workspacePath: string): void {
  for (const entry of entries) {
    const destinationPath = join(workspacePath, ...entry.relativePath.split('/'))
    mkdirSync(dirname(destinationPath), { recursive: true })

    if (entry.kind === 'file') {
      copyFileSync(entry.absolutePath, destinationPath)
    } else {
      symlinkSync(entry.linkTarget, destinationPath, entry.linkType)
    }
  }
}

function defaultRemoveRunRoot(runRoot: string): void {
  rmSync(runRoot, { recursive: true, force: true })
}

function isExcludedEnvironmentFile(name: string): boolean {
  return name === '.env' || name.startsWith('.env.')
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const pathRelative = relative(rootPath, targetPath)
  return pathRelative === '' ||
    (!pathRelative.startsWith(`..${sep}`) && pathRelative !== '..' && !isAbsolute(pathRelative))
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/')
}

function normalizeSymlinkTarget(target: string): string {
  return target.split(sep).join('/')
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
