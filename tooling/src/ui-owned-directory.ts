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

export interface OwnedUiMutationRetry {
  /** total mutation attempts, including the first (must be >= 1) */
  attempts: number
  /** backoff delay before retry attempt N (0-based) */
  delayMs: (attempt: number) => number
  sleep: (ms: number) => void | Promise<void>
}

export interface OwnedUiDirectory {
  assertCurrent(): void
  removeDirectoryLeaf(name: string): void
  removeFileLeaf(name: string): void
  removeDirectoryLeafRetrying(name: string, retry: OwnedUiMutationRetry): Promise<void>
  removeFileLeafRetrying(name: string, retry: OwnedUiMutationRetry): Promise<void>
}

const TRANSIENT_CODES: Record<string, true> = {
  EPERM: true,
  EACCES: true,
  EBUSY: true,
  ENOTEMPTY: true,
  ETXTBSY: true,
}

function isTransientError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && typeof (error as NodeJS.ErrnoException).code === 'string' && TRANSIENT_CODES[(error as NodeJS.ErrnoException).code!] === true
}

function validateRetryPolicy(retry: OwnedUiMutationRetry): void {
  if (retry === null || typeof retry !== 'object') throw new Error('retry policy is invalid')
  if (!Number.isInteger(retry.attempts) || retry.attempts < 1) throw new Error('retry attempts must be an integer >= 1')
  if (typeof retry.delayMs !== 'function') throw new Error('retry delayMs must be a function')
  if (typeof retry.sleep !== 'function') throw new Error('retry sleep must be a function')
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

  function quarantineDirectoryLeaf(name: string, retained: UiDirectoryIdentity | undefined): { quarantine: string, leafAnchor: UiDirectoryIdentity } | undefined {
    const leaf = join(directory, name)
    assertAnchors()
    assertContained(directory, leaf)
    if (!exists(leaf)) return undefined
    assertNoSymlinkComponents(leaf, 'owned UI directory leaf')
    const current = identify(leaf)
    if (current === undefined) throw new Error(`stable identity unavailable for owned UI directory leaf ${leaf}`)
    if (retained !== undefined && (current.dev !== retained.dev || current.ino !== retained.ino)) throw new Error(`owned UI directory leaf ${leaf} identity changed or cannot be proven safe`)
    const leafAnchor = retained ?? current
    const stat = lstatSync(leaf)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`owned UI directory leaf is not a regular directory at ${leaf}`)
    opts.hooks?.beforeMutation?.('quarantine', leaf)
    assertAnchors()
    assertIdentity(leaf, leafAnchor, `owned UI directory leaf ${leaf} changed before quarantine`, identify)
    const quarantine = `${leaf}.cleanup-${process.pid}-${Math.random().toString(16).slice(2)}`
    if (exists(quarantine)) throw new Error(`quarantine path already exists at ${quarantine}`)
    renameSync(leaf, quarantine)
    return { quarantine, leafAnchor }
  }

  function removeQuarantine(quarantine: string, leafAnchor: UiDirectoryIdentity): void {
    opts.hooks?.afterQuarantine?.(quarantine)
    assertAnchors()
    assertIdentity(quarantine, leafAnchor, `owned UI quarantine ${quarantine} changed before removal`, identify)
    opts.hooks?.beforeMutation?.('remove', quarantine)
    assertAnchors()
    assertIdentity(quarantine, leafAnchor, `owned UI quarantine ${quarantine} changed before removal`, identify)
    rmSync(quarantine, { recursive: true, force: false })
  }

  function attemptRemoveDirectoryLeaf(name: string): void {
    const captured = quarantineDirectoryLeaf(name, undefined)
    if (captured === undefined) return
    removeQuarantine(captured.quarantine, captured.leafAnchor)
  }

  function removeFileOnce(name: string, retained: UiDirectoryIdentity | undefined): { leaf: string, leafAnchor: UiDirectoryIdentity } | undefined {
    const leaf = join(directory, name)
    assertAnchors()
    assertContained(directory, leaf)
    if (!exists(leaf)) return undefined
    assertNoSymlinkComponents(leaf, 'owned UI file leaf')
    const current = identify(leaf)
    if (current === undefined) throw new Error(`stable identity unavailable for owned UI file leaf ${leaf}`)
    if (retained !== undefined && (current.dev !== retained.dev || current.ino !== retained.ino)) throw new Error(`owned UI file leaf ${leaf} identity changed or cannot be proven safe`)
    const leafAnchor = retained ?? current
    assertRegularFileLeaf(leaf, 'owned UI file leaf')
    opts.hooks?.beforeMutation?.('remove-file', leaf)
    assertAnchors()
    assertIdentity(leaf, leafAnchor, `owned UI file leaf ${leaf} changed before removal`, identify)
    assertRegularFileLeaf(leaf, 'owned UI file leaf')
    unlinkSync(leaf)
    return { leaf, leafAnchor }
  }

  function attemptRemoveFileLeaf(name: string): void {
    removeFileOnce(name, undefined)
  }

  return {
    assertCurrent(): void {
      assertAnchors()
    },
    removeDirectoryLeaf(name: string): void {
      attemptRemoveDirectoryLeaf(name)
    },
    removeFileLeaf(name: string): void {
      attemptRemoveFileLeaf(name)
    },
    async removeDirectoryLeafRetrying(name: string, retry: OwnedUiMutationRetry): Promise<void> {
      validateRetryPolicy(retry)
      if (!isSingleComponent(name)) throw new Error(`unsafe owned UI directory leaf ${JSON.stringify(name)}`)
      let retained: UiDirectoryIdentity | undefined
      let quarantine: string | undefined
      let quarantineAnchor: UiDirectoryIdentity | undefined
      for (let attempt = 0; attempt < retry.attempts; attempt++) {
        try {
          if (quarantine === undefined) {
            if (retained === undefined) {
              const probe = join(directory, name)
              if (exists(probe)) {
                const cur = identify(probe)
                if (cur !== undefined) retained = cur
              }
            }
            const captured = quarantineDirectoryLeaf(name, retained)
            if (captured === undefined) return
            retained = captured.leafAnchor
            quarantine = captured.quarantine
            quarantineAnchor = captured.leafAnchor
            removeQuarantine(quarantine, quarantineAnchor)
            return
          } else {
            removeQuarantine(quarantine, quarantineAnchor!)
            return
          }
        } catch (error) {
          const transient = isTransientError(error)
          if (!transient || attempt + 1 >= retry.attempts) throw error
          if (quarantine === undefined) {
            if (retained === undefined) throw error
            assertAnchors()
            const leaf = join(directory, name)
            assertNoSymlinkComponents(leaf, 'owned UI directory leaf')
            assertIdentity(leaf, retained, `owned UI directory leaf ${leaf} changed before quarantine`, identify)
            const stat = lstatSync(leaf)
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`owned UI directory leaf is not a regular directory at ${leaf}`)
          } else {
            assertAnchors()
            assertNoSymlinkComponents(quarantine, 'owned UI quarantine')
            assertIdentity(quarantine, quarantineAnchor, `owned UI quarantine ${quarantine} changed before removal`, identify)
          }
          await retry.sleep(retry.delayMs(attempt))
        }
      }
    },
    async removeFileLeafRetrying(name: string, retry: OwnedUiMutationRetry): Promise<void> {
      validateRetryPolicy(retry)
      if (!isSingleComponent(name)) throw new Error(`unsafe owned UI directory leaf ${JSON.stringify(name)}`)
      let retained: UiDirectoryIdentity | undefined
      let leafPath: string | undefined
      for (let attempt = 0; attempt < retry.attempts; attempt++) {
        const leaf = join(directory, name)
        leafPath = leaf
        if (retained === undefined && exists(leaf)) {
          const cur = identify(leaf)
          if (cur !== undefined) retained = cur
        }
        try {
          const captured = removeFileOnce(name, retained)
          if (captured === undefined) return
          retained = captured.leafAnchor
          leafPath = captured.leaf
          return
        } catch (error) {
          const transient = isTransientError(error)
          if (!transient || attempt + 1 >= retry.attempts) throw error
          if (retained === undefined || leafPath === undefined) throw error
          assertAnchors()
          assertNoSymlinkComponents(leafPath, 'owned UI file leaf')
          assertIdentity(leafPath, retained, `owned UI file leaf ${leafPath} changed before removal`, identify)
          assertRegularFileLeaf(leafPath, 'owned UI file leaf')
          await retry.sleep(retry.delayMs(attempt))
        }
      }
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
