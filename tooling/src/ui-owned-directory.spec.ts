import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { claimOwnedUiDirectory, type OwnedUiDirectoryHooks } from './ui-owned-directory.js'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
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
})
