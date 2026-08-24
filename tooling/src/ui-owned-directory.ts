import { lstatSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

export interface UiDirectoryIdentity {
  dev: number
  ino: number
}

export interface OwnedUiDirectoryHooks {
  beforeMutation?(operation: 'quarantine' | 'remove' | 'remove-file', path: string): void
  afterQuarantine?(path: string): void
}

export interface ClaimOwnedUiDirectoryOptions {
  root: string
  directory: string
  expectedIdentity?: UiDirectoryIdentity
  identity?: (path: string) => UiDirectoryIdentity | undefined
  hooks?: OwnedUiDirectoryHooks
}

export interface OwnedUiDirectory {
  assertCurrent(): void
  removeDirectoryLeaf(name: string): void
  removeFileLeaf(name: string): void
}

export function claimOwnedUiDirectory(opts: ClaimOwnedUiDirectoryOptions): OwnedUiDirectory {
  if (!isNonEmptyPath(opts.root) || !isNonEmptyPath(opts.directory)) throw new Error('owned UI directory paths must be non-empty')
  const root = resolve(opts.root)
  const directory = resolve(opts.directory)
  assertContained(root, directory)
  assertNoSymlinkComponents(root, 'owned UI directory root')
  assertNoSymlinkComponents(directory, 'owned UI directory')
  assertDirectory(directory, 'owned UI directory')
  const identify = opts.identity ?? stableIdentity
  const rootAnchor = identify(root)
  const directoryAnchor = identify(directory)
  if (opts.expectedIdentity !== undefined &&
      (directoryAnchor === undefined || directoryAnchor.dev !== opts.expectedIdentity.dev || directoryAnchor.ino !== opts.expectedIdentity.ino)) {
    throw new Error(`owned UI directory identity changed or does not match the retained authority at ${directory}`)
  }

  function assertAnchors(): void {
    assertNoSymlinkComponents(root, 'owned UI directory root')
    assertNoSymlinkComponents(directory, 'owned UI directory')
    assertIdentity(root, rootAnchor, 'owned UI directory root', identify)
    assertIdentity(directory, directoryAnchor, 'owned UI directory', identify)
  }

  return {
    assertCurrent(): void {
      assertAnchors()
    },
    removeDirectoryLeaf(name: string): void {
      if (!isSingleComponent(name)) throw new Error(`unsafe owned UI directory leaf ${JSON.stringify(name)}`)
      assertAnchors()
      const leaf = join(directory, name)
      assertContained(directory, leaf)
      if (!exists(leaf)) return
      assertNoSymlinkComponents(leaf, 'owned UI directory leaf')
      const leafAnchor = identify(leaf)
      if (leafAnchor === undefined) throw new Error(`stable identity unavailable for owned UI directory leaf ${leaf}`)
      const leafStat = lstatSync(leaf)
      if (leafStat.isSymbolicLink() || !leafStat.isDirectory()) throw new Error(`owned UI directory leaf is not a regular directory at ${leaf}`)
      opts.hooks?.beforeMutation?.('quarantine', leaf)
      assertAnchors()
      assertIdentity(leaf, leafAnchor, `owned UI directory leaf ${leaf} changed before quarantine`, identify)
      const quarantine = `${leaf}.cleanup-${process.pid}-${Math.random().toString(16).slice(2)}`
      if (exists(quarantine)) throw new Error(`quarantine path already exists at ${quarantine}`)
      renameSync(leaf, quarantine)
      try {
        opts.hooks?.afterQuarantine?.(quarantine)
        assertAnchors()
        assertIdentity(quarantine, leafAnchor, `owned UI quarantine ${quarantine} changed before removal`, identify)
        opts.hooks?.beforeMutation?.('remove', quarantine)
        assertAnchors()
        assertIdentity(quarantine, leafAnchor, `owned UI quarantine ${quarantine} changed before removal`, identify)
        rmSync(quarantine, { recursive: true, force: false })
      } catch (error) {
        throw error
      }
    },
    removeFileLeaf(name: string): void {
      if (!isSingleComponent(name)) throw new Error(`unsafe owned UI directory leaf ${JSON.stringify(name)}`)
      assertAnchors()
      const leaf = join(directory, name)
      assertContained(directory, leaf)
      if (!exists(leaf)) return
      assertNoSymlinkComponents(leaf, 'owned UI file leaf')
      const leafAnchor = identify(leaf)
      if (leafAnchor === undefined) throw new Error(`stable identity unavailable for owned UI file leaf ${leaf}`)
      assertRegularFileLeaf(leaf, 'owned UI file leaf')
      opts.hooks?.beforeMutation?.('remove-file', leaf)
      assertAnchors()
      assertIdentity(leaf, leafAnchor, `owned UI file leaf ${leaf} changed before removal`, identify)
      assertRegularFileLeaf(leaf, 'owned UI file leaf')
      unlinkSync(leaf)
    },
  }
}

function stableIdentity(path: string): UiDirectoryIdentity | undefined {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !Number.isInteger(stat.dev) || !Number.isInteger(stat.ino) || stat.dev <= 0 || stat.ino <= 0) return undefined
    return { dev: stat.dev, ino: stat.ino }
  } catch {
    return undefined
  }
}

function assertIdentity(path: string, expected: UiDirectoryIdentity | undefined, label: string, identify = stableIdentity): void {
  if (expected === undefined) throw new Error(`stable identity unavailable for ${label}`)
  const current = identify(path)
  if (current === undefined || current.dev !== expected.dev || current.ino !== expected.ino) throw new Error(`${label} identity changed or cannot be proven safe`)
}

function assertDirectory(path: string, label: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a regular directory at ${path}`)
}

function assertRegularFileLeaf(path: string, label: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error(`${label} is not a unique regular file at ${path}`)
}

function assertContained(root: string, candidate: string): void {
  const outside = relative(resolve(root), resolve(candidate))
  if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) throw new Error('owned UI directory escapes root')
}

function assertNoSymlinkComponents(path: string, label: string): void {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink or junction at ${current}`)
  }
}

function exists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function isSingleComponent(value: string): boolean {
  return isNonEmptyPath(value) && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..'
}

function isNonEmptyPath(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
