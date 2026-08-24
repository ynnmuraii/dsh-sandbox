import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const transient = (syscall: string) => Object.assign(new Error(`EPERM: operation not permitted, ${syscall}`), { code: 'EPERM' })
  return {
    ...actual,
    renameSync: ((...args: Parameters<typeof actual.renameSync>) => {
      if (transientFs.renameFail > 0) { transientFs.renameFail -= 1; throw transient('rename') }
      return actual.renameSync(...args)
    }) as typeof actual.renameSync,
    rmSync: ((...args: Parameters<typeof actual.rmSync>) => {
      if (transientFs.rmFail > 0) { transientFs.rmFail -= 1; throw transient('rm') }
      return actual.rmSync(...args)
    }) as typeof actual.rmSync,
    unlinkSync: ((...args: Parameters<typeof actual.unlinkSync>) => {
      if (transientFs.unlinkFail > 0) { transientFs.unlinkFail -= 1; throw transient('unlink') }
      return actual.unlinkSync(...args)
    }) as typeof actual.unlinkSync,
  }
})
const transientFs = vi.hoisted(() => ({ renameFail: 0, rmFail: 0, unlinkFail: 0 }))

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { claimOwnedUiDirectory, type OwnedUiDirectoryHooks, type OwnedUiMutationRetry } from './ui-owned-directory.js'

const roots: string[] = []

beforeEach(() => {
  transientFs.renameFail = 0
  transientFs.rmFail = 0
  transientFs.unlinkFail = 0
})


function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lab-owned-ui-directory-'))
  roots.push(root)
  const sessionDir = join(root, 'ui-sessions', 'ui-20260824T120000000Z-a1b2c3d4')
  const home = join(sessionDir, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'owned.txt'), 'owned runtime')
  return { root, sessionDir, home }
}

describe('claimOwnedUiDirectory', () => {
  it('removes a captured regular file leaf', () => {
    const current = fixture()
    const log = join(current.sessionDir, 'supervisor.log')
    writeFileSync(log, 'owned log')
    const owned = claimOwnedUiDirectory({ root: current.root, directory: current.sessionDir })

    owned.removeFileLeaf('supervisor.log')

    expect(existsSync(log)).toBe(false)
  })

  it('refuses an ordinary session-directory swap immediately before file removal', () => {
    const current = fixture()
    const log = join(current.sessionDir, 'supervisor.log')
    const parked = `${current.sessionDir}.parked`
    const parkedLog = join(parked, 'supervisor.log')
    writeFileSync(log, 'original owned log')
    const owned = claimOwnedUiDirectory({
      root: current.root,
      directory: current.sessionDir,
      hooks: {
        beforeMutation(operation, path) {
          if (operation !== 'remove-file' || path !== log) return
          renameSync(current.sessionDir, parked)
          mkdirSync(current.sessionDir)
          writeFileSync(log, 'replacement canary')
        },
      },
    })

    expect(() => owned.removeFileLeaf('supervisor.log')).toThrow(/identity|changed|swap|refus/i)
    expect(readFileSync(log, 'utf8')).toBe('replacement canary')
    expect(readFileSync(parkedLog, 'utf8')).toBe('original owned log')
  })

  it('quarantines a captured directory leaf before recursively deleting it', () => {
    const current = fixture()
    const quarantines: string[] = []
    const owned = claimOwnedUiDirectory({
      root: current.root,
      directory: current.sessionDir,
      hooks: { afterQuarantine: (path: string) => quarantines.push(path) },
    })

    owned.removeDirectoryLeaf('home')

    expect(existsSync(current.home)).toBe(false)
    expect(quarantines).toHaveLength(1)
    expect(quarantines[0]).toContain(`${basename(current.home)}.cleanup-`)
    expect(existsSync(quarantines[0]!)).toBe(false)
  })

  it('refuses an ordinary same-name leaf swap immediately before quarantine mutation', () => {
    const current = fixture()
    const original = join(current.sessionDir, 'original-home')
    const canary = join(current.home, 'replacement-canary.txt')
    const hooks: OwnedUiDirectoryHooks = {
      beforeMutation(operation: string, path: string) {
        if (operation !== 'quarantine' || path !== current.home) return
        renameSync(current.home, original)
        mkdirSync(current.home)
        writeFileSync(canary, 'do not remove replacement')
      },
    }
    const owned = claimOwnedUiDirectory({ root: current.root, directory: current.sessionDir, hooks })

    expect(() => owned.removeDirectoryLeaf('home')).toThrow(/identity|changed|swap|refus/i)
    expect(readFileSync(canary, 'utf8')).toBe('do not remove replacement')
    expect(readFileSync(join(original, 'owned.txt'), 'utf8')).toBe('owned runtime')
  })

  it('refuses to recursively delete a quarantine path swapped after the atomic rename', () => {
    const current = fixture()
    let saved = ''
    let replacementCanary = ''
    const owned = claimOwnedUiDirectory({
      root: current.root,
      directory: current.sessionDir,
      hooks: {
        afterQuarantine(quarantinePath: string) {
          saved = `${quarantinePath}.saved`
          replacementCanary = join(quarantinePath, 'replacement-canary.txt')
          renameSync(quarantinePath, saved)
          mkdirSync(quarantinePath)
          writeFileSync(replacementCanary, 'do not remove replacement')
        },
      },
    })

    expect(() => owned.removeDirectoryLeaf('home')).toThrow(/identity|changed|swap|refus/i)
    expect(readFileSync(replacementCanary, 'utf8')).toBe('do not remove replacement')
    expect(readFileSync(join(saved, 'owned.txt'), 'utf8')).toBe('owned runtime')
  })

  it('fails closed when stable filesystem identity is unavailable', () => {
    const current = fixture()
    const owned = claimOwnedUiDirectory({
      root: current.root,
      directory: current.sessionDir,
      identity: vi.fn(() => undefined),
    })

    expect(() => owned.removeDirectoryLeaf('home')).toThrow(/identity|unavailable|refus/i)
    expect(readFileSync(join(current.home, 'owned.txt'), 'utf8')).toBe('owned runtime')
  })

  it('never follows a directory junction to an external canary', () => {
    const current = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-lab-owned-ui-canary-'))
    roots.push(outside)
    const canary = join(outside, 'canary.txt')
    writeFileSync(canary, 'outside')
    rmSync(current.home, { recursive: true })
    symlinkSync(outside, current.home, process.platform === 'win32' ? 'junction' : 'dir')
    const owned = claimOwnedUiDirectory({ root: current.root, directory: current.sessionDir })

    expect(() => owned.removeDirectoryLeaf('home')).toThrow(/junction|symlink|identity|refus/i)
    expect(readFileSync(canary, 'utf8')).toBe('outside')
  })

  it('allows only one cleanup claimant to quarantine a captured leaf', () => {
    const current = fixture()
    const quarantines: string[] = []
    const options = {
      root: current.root,
      directory: current.sessionDir,
      hooks: { afterQuarantine: (path: string) => quarantines.push(path) },
    }
    const first = claimOwnedUiDirectory(options)
    const second = claimOwnedUiDirectory(options)

    first.removeDirectoryLeaf('home')
    second.removeDirectoryLeaf('home')

    expect(quarantines).toHaveLength(1)
    expect(existsSync(current.home)).toBe(false)
  })
})

describe('owned UI mutation retry', () => {
  function retryPolicy(attempts: number) {
    return {
      attempts,
      delayMs: (attempt: number) => 50 + attempt * 10,
      sleep: vi.fn(async () => undefined),
    } satisfies OwnedUiMutationRetry
  }

  it('retries a transient quarantine rename and completes directory removal', async () => {
    const current = fixture()
    transientFs.renameFail = 2
    const policy = retryPolicy(5)
    const owned = claimOwnedUiDirectory({ root: current.root, directory: current.sessionDir })

    await owned.removeDirectoryLeafRetrying('home', policy)

    expect(existsSync(current.home)).toBe(false)
    expect(policy.sleep).toHaveBeenCalledTimes(2)
    expect(policy.sleep).toHaveBeenNthCalledWith(1, policy.delayMs(0))
    expect(policy.sleep).toHaveBeenNthCalledWith(2, policy.delayMs(1))
    expect(readdirSync(current.sessionDir).filter(name => name.startsWith('home.cleanup-'))).toEqual([])
  })

  it('retries the quarantine removal itself on a transient rm failure without leftovers', async () => {
    const current = fixture()
    transientFs.rmFail = 1
    const policy = retryPolicy(3)
    const owned = claimOwnedUiDirectory({ root: current.root, directory: current.sessionDir })

    await owned.removeDirectoryLeafRetrying('home', policy)

    expect(existsSync(current.home)).toBe(false)
    expect(policy.sleep).toHaveBeenCalledTimes(1)
    expect(readdirSync(current.sessionDir).filter(name => name.startsWith('home.cleanup-'))).toEqual([])
  })

  it('fails closed after exhausting transient rename retries', async () => {
    const current = fixture()
    transientFs.renameFail = 99
    const policy = retryPolicy(3)
    const owned = claimOwnedUiDirectory({ root: current.root, directory: current.sessionDir })

    await expect(owned.removeDirectoryLeafRetrying('home', policy)).rejects.toThrow(/EPERM|rename|refus/i)

    expect(existsSync(current.home)).toBe(true)
    expect(readFileSync(join(current.home, 'owned.txt'), 'utf8')).toBe('owned runtime')
    expect(policy.sleep).toHaveBeenCalledTimes(2)
  })

  it('revalidates leaf identity between retries and never retries an identity failure', async () => {
    const current = fixture()
    const parked = `${current.home}.parked`
    transientFs.renameFail = 1
    const policy = retryPolicy(5)
    policy.sleep.mockImplementation(async () => {
      renameSync(current.home, parked)
      mkdirSync(current.home)
      writeFileSync(join(current.home, 'replacement-canary.txt'), 'do not remove replacement')
    })
    const owned = claimOwnedUiDirectory({ root: current.root, directory: current.sessionDir })

    await expect(owned.removeDirectoryLeafRetrying('home', policy)).rejects.toThrow(/identity|changed|swap|refus/i)

    expect(policy.sleep).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(current.home, 'replacement-canary.txt'), 'utf8')).toBe('do not remove replacement')
    expect(readFileSync(join(parked, 'owned.txt'), 'utf8')).toBe('owned runtime')
  })

  it('retries a transient file unlink and completes file removal', async () => {
    const current = fixture()
    const log = join(current.sessionDir, 'supervisor.log')
    writeFileSync(log, 'owned log')
    transientFs.unlinkFail = 1
    const policy = retryPolicy(3)
    const owned = claimOwnedUiDirectory({ root: current.root, directory: current.sessionDir })

    await owned.removeFileLeafRetrying('supervisor.log', policy)

    expect(existsSync(log)).toBe(false)
    expect(policy.sleep).toHaveBeenCalledTimes(1)
  })

  it('never retries a validation failure that is not transient', async () => {
    const current = fixture()
    const policy = retryPolicy(3)
    const owned = claimOwnedUiDirectory({ root: current.root, directory: current.sessionDir })

    await expect(owned.removeDirectoryLeafRetrying('../escape', policy)).rejects.toThrow(/unsafe|leaf/i)
    expect(policy.sleep).not.toHaveBeenCalled()
  })
})
