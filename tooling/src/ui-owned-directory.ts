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

export interface OwnedUiDirectory {
  assertCurrent(): void
  removeDirectoryLeaf(name: string): void
  removeFileLeaf(name: string): void
  removeDirectoryLeafRetrying(name: string, retry: OwnedUiMutationRetry): Promise<void>
  removeFileLeafRetrying(name: string, retry: OwnedUiMutationRetry): Promise<void>
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

  function attemptRemoveDirectoryLeaf(name: string): { quarantine: string, leafAnchor: UiDirectoryIdentity } | undefined {
    if (!isSingleComponent(name)) throw new Error(`unsafe owned UI directory leaf ${JSON.stringify(name)}`)
    assertAnchors()
    const leaf = join(directory, name)
    assertContained(directory, leaf)
    if (!exists(leaf)) return undefined
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
    return { quarantine, leafAnchor }
  }

  function attemptRemoveFileLeaf(name: string): { leaf: string, leafAnchor: UiDirectoryIdentity } | undefined {
    if (!isSingleComponent(name)) throw new Error(`unsafe owned UI directory leaf ${JSON.stringify(name)}`)
    assertAnchors()
    const leaf = join(directory, name)
    assertContained(directory, leaf)
    if (!exists(leaf)) return undefined
    assertNoSymlinkComponents(leaf, 'owned UI file leaf')
    const leafAnchor = identify(leaf)
    if (leafAnchor === undefined) throw new Error(`stable identity unavailable for owned UI file leaf ${leaf}`)
    assertRegularFileLeaf(leaf, 'owned UI file leaf')
    opts.hooks?.beforeMutation?.('remove-file', leaf)
    assertAnchors()
    assertIdentity(leaf, leafAnchor, `owned UI file leaf ${leaf} changed before removal`, identify)
    assertRegularFileLeaf(leaf, 'owned UI file leaf')
    unlinkSync(leaf)
    return { leaf, leafAnchor }
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
      let leafAnchor: UiDirectoryIdentity | undefined
      let quarantine: string | undefined
      let quarantineAnchor: UiDirectoryIdentity | undefined
      let quarantineAttempted = false
      for (let attempt = 0; attempt < retry.attempts; attempt++) {
        try {
          if (!quarantineAttempted) {
            // Need to attempt quarantine phase; if leafAnchor already captured, revalidate against it before attempt
            if (leafAnchor !== undefined) {
              // Full revalidation for quarantine retry is handled in catch block before sleep, but also ensure next attempt validates
              // Here we revalidate again at attempt start to ensure leaf still matches original anchor
              // The catch block already validated before sleep, but swap happened during sleep, so we need to validate again now
              assertAnchors()
              const leaf = join(directory, name)
              // If leaf no longer exists, maybe it was already quarantined? But quarantineAttempted is false, so leaf should exist
              assertNoSymlinkComponents(leaf, 'owned UI directory leaf')
              assertIdentity(leaf, leafAnchor, `owned UI directory leaf ${leaf} changed before quarantine`, identify)
              const leafStat = lstatSync(leaf)
              if (leafStat.isSymbolicLink() || !leafStat.isDirectory()) throw new Error(`owned UI directory leaf is not a regular directory at ${leaf}`)
            }
            // Perform quarantine attempt; this will capture leafAnchor if not already, or reuse if already
            // To avoid duplicate capture logic, we inline the steps with retention
            assertAnchors()
            const leaf = join(directory, name)
            assertContained(directory, leaf)
            if (!exists(leaf)) return
            assertNoSymlinkComponents(leaf, 'owned UI directory leaf')
            const currentAnchor = identify(leaf)
            if (currentAnchor === undefined) throw new Error(`stable identity unavailable for owned UI directory leaf ${leaf}`)
            if (leafAnchor !== undefined) {
              if (currentAnchor.dev !== leafAnchor.dev || currentAnchor.ino !== leafAnchor.ino) {
                throw new Error(`owned UI directory leaf ${leaf} changed before quarantine identity changed or cannot be proven safe`)
              }
            } else {
              leafAnchor = currentAnchor
            }
            const leafStat = lstatSync(leaf)
            if (leafStat.isSymbolicLink() || !leafStat.isDirectory()) throw new Error(`owned UI directory leaf is not a regular directory at ${leaf}`)
            opts.hooks?.beforeMutation?.('quarantine', leaf)
            assertAnchors()
            assertIdentity(leaf, leafAnchor, `owned UI directory leaf ${leaf} changed before quarantine`, identify)
            const nextQuarantine = `${leaf}.cleanup-${process.pid}-${Math.random().toString(16).slice(2)}`
            if (exists(nextQuarantine)) throw new Error(`quarantine path already exists at ${nextQuarantine}`)
            renameSync(leaf, nextQuarantine)
            quarantine = nextQuarantine
            quarantineAnchor = leafAnchor
            quarantineAttempted = true
            // Now attempt rm on the same quarantine
            opts.hooks?.afterQuarantine?.(quarantine)
            assertAnchors()
            assertIdentity(quarantine, quarantineAnchor, `owned UI quarantine ${quarantine} changed before removal`, identify)
            opts.hooks?.beforeMutation?.('remove', quarantine)
            assertAnchors()
            assertIdentity(quarantine, quarantineAnchor, `owned UI quarantine ${quarantine} changed before removal`, identify)
            rmSync(quarantine, { recursive: true, force: false })
            return
          } else {
            // Retry rm on same quarantine
            // Revalidate before rm (also done before sleep, but double-check)
            assertAnchors()
            assertNoSymlinkComponents(quarantine!, 'owned UI quarantine')
            assertIdentity(quarantine!, quarantineAnchor, `owned UI quarantine ${quarantine} changed before removal`, identify)
            opts.hooks?.beforeMutation?.('remove', quarantine!)
            assertAnchors()
            assertIdentity(quarantine!, quarantineAnchor, `owned UI quarantine ${quarantine} changed before removal`, identify)
            rmSync(quarantine!, { recursive: true, force: false })
            return
          }
        } catch (error) {
          const transient = isTransientError(error)
          if (!transient || attempt + 1 >= retry.attempts) throw error
          // Revalidate before sleep
          if (!quarantineAttempted) {
            // Quarantine phase failed transiently (rename)
            // leafAnchor was captured before rename, so validate leaf still matches
            assertAnchors()
            const leaf = join(directory, name)
            assertNoSymlinkComponents(leaf, 'owned UI directory leaf')
            assertIdentity(leaf, leafAnchor, `owned UI directory leaf ${leaf} changed before quarantine`, identify)
            const leafStat = lstatSync(leaf)
            if (leafStat.isSymbolicLink() || !leafStat.isDirectory()) throw new Error(`owned UI directory leaf is not a regular directory at ${leaf}`)
          } else {
            // Rm phase failed transiently
            assertAnchors()
            assertNoSymlinkComponents(quarantine!, 'owned UI quarantine')
            assertIdentity(quarantine!, quarantineAnchor, `owned UI quarantine ${quarantine} changed before removal`, identify)
          }
          await retry.sleep(retry.delayMs(attempt))
          // For quarantine retry, loop will re-attempt quarantine with same leafAnchor retained
          // For rm retry, loop will re-attempt rm on same quarantine
        }
      }
    },
    async removeFileLeafRetrying(name: string, retry: OwnedUiMutationRetry): Promise<void> {
      validateRetryPolicy(retry)
      if (!isSingleComponent(name)) throw new Error(`unsafe owned UI directory leaf ${JSON.stringify(name)}`)
      let leafAnchor: UiDirectoryIdentity | undefined
      let leafPath: string | undefined
      for (let attempt = 0; attempt < retry.attempts; attempt++) {
        try {
          assertAnchors()
          const leaf = join(directory, name)
          leafPath = leaf
          assertContained(directory, leaf)
          if (!exists(leaf)) return
          assertNoSymlinkComponents(leaf, 'owned UI file leaf')
          const currentAnchor = identify(leaf)
          if (currentAnchor === undefined) throw new Error(`stable identity unavailable for owned UI file leaf ${leaf}`)
          if (leafAnchor !== undefined) {
            if (currentAnchor.dev !== leafAnchor.dev || currentAnchor.ino !== leafAnchor.ino) {
              throw new Error(`owned UI file leaf ${leaf} changed before removal identity changed or cannot be proven safe`)
            }
          } else {
            leafAnchor = currentAnchor
          }
          assertRegularFileLeaf(leaf, 'owned UI file leaf')
          opts.hooks?.beforeMutation?.('remove-file', leaf)
          assertAnchors()
          assertIdentity(leaf, leafAnchor, `owned UI file leaf ${leaf} changed before removal`, identify)
          assertRegularFileLeaf(leaf, 'owned UI file leaf')
          unlinkSync(leaf)
          return
        } catch (error) {
          const transient = isTransientError(error)
          if (!transient || attempt + 1 >= retry.attempts) throw error
          // Revalidate before sleep
          assertAnchors()
          assertNoSymlinkComponents(leafPath!, 'owned UI file leaf')
          assertIdentity(leafPath!, leafAnchor, `owned UI file leaf ${leafPath} changed before removal`, identify)
          assertRegularFileLeaf(leafPath!, 'owned UI file leaf')
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
