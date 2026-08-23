import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { computePluginDigest, createPluginSnapshot } from './plugin-snapshot.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function fixture(): string {
  const source = temporaryRoot('dsh-lab-snapshot-source-')
  write(join(source, 'package.json'), '{"name":"@fixture/demo"}\n')
  write(join(source, 'src', 'tracked.ts'), 'export const version = 2\n')
  write(join(source, 'src', 'untracked.ts'), 'export const newFile = true\n')
  write(join(source, 'tests', 'plugin.spec.ts'), 'test("plugin", () => {})\n')
  for (const excluded of [
    ['.git', 'config'],
    ['node_modules', 'dependency.js'],
    ['.lab', 'runtime.txt'],
    ['lib', 'index.js'],
    ['dist', 'index.js'],
    ['coverage', 'coverage.json'],
  ]) write(join(source, ...excluded), 'excluded\n')
  write(join(source, '.env'), 'SECRET=one\n')
  write(join(source, '.env.local'), 'SECRET=two\n')
  return source
}

describe('computePluginDigest', () => {
  it('includes current tracked-like and untracked files but excludes derived, runtime, VCS, and secret inputs', () => {
    const source = fixture()

    const result = computePluginDigest(source)

    expect(result.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(result.files).toEqual([
      'package.json',
      'src/tracked.ts',
      'src/untracked.ts',
      'tests/plugin.spec.ts',
    ])
    expect(result.files.every(path => !path.includes('\\'))).toBe(true)
  })

  it('is independent of absolute root and timestamps but changes for bytes or added files', () => {
    const first = temporaryRoot('dsh-lab-digest-first-')
    const second = temporaryRoot('dsh-lab-digest-second-')
    for (const root of [first, second]) {
      write(join(root, 'package.json'), '{"name":"same"}\n')
      write(join(root, 'src', 'index.ts'), 'export const same = true\n')
    }
    utimesSync(join(second, 'src', 'index.ts'), new Date(1_000), new Date(2_000))

    const baseline = computePluginDigest(first)
    expect(computePluginDigest(second)).toEqual(baseline)

    write(join(second, 'src', 'index.ts'), 'export const same = false\n')
    expect(computePluginDigest(second).digest).not.toBe(baseline.digest)

    write(join(first, 'src', 'new.ts'), 'export const added = true\n')
    expect(computePluginDigest(first).digest).not.toBe(baseline.digest)
  })

  it('hashes safe internal symlinks deterministically and rejects external or unresolved links', () => {
    const first = temporaryRoot('dsh-lab-links-first-')
    const second = temporaryRoot('dsh-lab-links-second-')
    const outside = temporaryRoot('dsh-lab-links-outside-')
    write(join(outside, 'secret.txt'), 'outside\n')
    for (const root of [first, second]) {
      write(join(root, 'src', 'target.txt'), 'inside\n')
      try {
        symlinkSync('src/target.txt', join(root, 'internal.txt'), 'file')
      } catch (error) {
        if (isSymlinkUnavailable(error)) return
        throw error
      }
    }

    expect(computePluginDigest(second)).toEqual(computePluginDigest(first))

    symlinkSync(relative(first, join(outside, 'secret.txt')), join(first, 'external.txt'), 'file')
    expect(() => computePluginDigest(first)).toThrow(/symlink.*escape|outside/i)
    rmSync(join(first, 'external.txt'))

    symlinkSync('missing.txt', join(first, 'unresolved.txt'), 'file')
    expect(() => computePluginDigest(first)).toThrow(/symlink.*unresolved|missing/i)
  })
})

describe('createPluginSnapshot', () => {
  it('copies exactly the deterministic current-content traversal into a unique temporary workspace', () => {
    const sourcePath = fixture()
    const runtimeRoot = temporaryRoot('dsh-lab-runtime-')

    const snapshot = createPluginSnapshot({ sourcePath, runtimeRoot })

    expect(snapshot.runRoot).toMatch(new RegExp(`${escapeRegex(runtimeRoot)}[\\\\/]verify-`))
    expect(snapshot.workspacePath).toBe(join(snapshot.runRoot, 'workspace'))
    expect(snapshot.files).toEqual(computePluginDigest(sourcePath).files)
    expect(snapshot.digest).toBe(computePluginDigest(sourcePath).digest)
    for (const path of snapshot.files) {
      expect(readFileSync(join(snapshot.workspacePath, ...path.split('/')), 'utf8')).toBe(
        readFileSync(join(sourcePath, ...path.split('/')), 'utf8'),
      )
    }
    expect(existsSync(join(snapshot.workspacePath, '.git'))).toBe(false)
    expect(existsSync(join(snapshot.workspacePath, '.env'))).toBe(false)
  })

  it('preserves a safe internal symlink without following it', () => {
    const sourcePath = temporaryRoot('dsh-lab-copy-link-')
    const runtimeRoot = temporaryRoot('dsh-lab-copy-runtime-')
    write(join(sourcePath, 'src', 'target.txt'), 'inside\n')
    try {
      symlinkSync('src/target.txt', join(sourcePath, 'internal.txt'), 'file')
    } catch (error) {
      if (isSymlinkUnavailable(error)) return
      throw error
    }

    const snapshot = createPluginSnapshot({ sourcePath, runtimeRoot })
    const copied = join(snapshot.workspacePath, 'internal.txt')

    expect(lstatSync(copied).isSymbolicLink()).toBe(true)
    expect(readlinkSync(copied)).toBe('src/target.txt')
  })

  it('cleanup removes runRoot and is idempotent', () => {
    const snapshot = createPluginSnapshot({
      sourcePath: fixture(),
      runtimeRoot: temporaryRoot('dsh-lab-cleanup-runtime-'),
    })

    snapshot.cleanup()
    expect(existsSync(snapshot.runRoot)).toBe(false)
    expect(() => snapshot.cleanup()).not.toThrow()
  })

  it('reports the exact runRoot when injected removal fails', () => {
    const snapshot = createPluginSnapshot({
      sourcePath: fixture(),
      runtimeRoot: temporaryRoot('dsh-lab-cleanup-failure-'),
      removeRunRoot(path) {
        throw new Error(`locked: ${path}`)
      },
    })

    expect(() => snapshot.cleanup()).toThrow(new RegExp(escapeRegex(snapshot.runRoot)))
    expect(existsSync(snapshot.runRoot)).toBe(true)
  })
})

function isSymlinkUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP'
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
