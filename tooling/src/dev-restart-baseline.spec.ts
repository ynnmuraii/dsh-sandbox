import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import {
  EMPTY_DIGEST,
  computeDevRestartBaseline,
  aggregateRestartHash,
  restartReasonsForBaseline,
  digestString,
  digestRequiredFile,
  digestOptionalFile,
} from './dev-restart-baseline.js'
import type { DevRestartBaseline } from './dev-restart-baseline.js'

describe('dev restart baseline', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-restart-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function writeSrc(files: Record<string, string>): void {
    for (const [rel, contents] of Object.entries(files)) {
      const path = join(root, 'src', rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, contents)
    }
  }

  it('computes the empty digest for an absent plugin.yaml so absent⇄present is observable', () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.ts'), 'export const live = true\n')
    writeFileSync(join(root, 'package.json'), '{}\n')
    // no .dsh-lab/plugin.yaml
    const baseline = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    expect(baseline.pluginMetadata).toBe(EMPTY_DIGEST)
    expect(baseline.pluginMetadata).toBe(digestString(''))
    expect(baseline.sourceTree).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('digests the entire src tree into sourceTree, including nested files deterministically', () => {
    writeSrc({ 'index.ts': 'export const live = true\n', 'nested/a.ts': 'export const a = 1\n' })
    writeFileSync(join(root, 'package.json'), '{"name":"@f/x"}\n')
    const a = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    const b = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    expect(a.sourceTree).toBe(b.sourceTree)
    expect(a.sourceTree).not.toBe(EMPTY_DIGEST)
  })

  it('a source edit changes only sourceTree and reports source-changed', () => {
    writeSrc({ 'index.ts': 'export const live = true\n' })
    writeFileSync(join(root, 'package.json'), '{"name":"@f/x"}\n')
    const a = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    writeFileSync(join(root, 'src', 'index.ts'), 'export const live = false\n')
    const b = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    expect(b.pluginManifest).toBe(a.pluginManifest)
    expect(b.pluginMetadata).toBe(a.pluginMetadata)
    expect(b.targetPin).toBe(a.targetPin)
    expect(b.sourceTree).not.toBe(a.sourceTree)
    expect(restartReasonsForBaseline(b, a)).toEqual(['source-changed'])
  })

  it('adding and removing a source file changes sourceTree only and is cleanly reversible', () => {
    writeSrc({ 'index.ts': 'export const live = true\n' })
    writeFileSync(join(root, 'package.json'), '{"name":"@f/x"}\n')
    const a = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    writeFileSync(join(root, 'src', 'additional.ts'), 'export const extra = 1\n')
    const b = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    expect(b.pluginManifest).toBe(a.pluginManifest)
    expect(b.sourceTree).not.toBe(a.sourceTree)
    expect(restartReasonsForBaseline(b, a)).toEqual(['source-changed'])
    rmSync(join(root, 'src', 'additional.ts'))
    const c = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    expect(c).toEqual(a)
    expect(restartReasonsForBaseline(c, a)).toEqual([])
  })

  it('ignores non-src plugin files: a root README edit leaves every component unchanged', () => {
    writeSrc({ 'index.ts': 'export const live = true\n' })
    writeFileSync(join(root, 'package.json'), '{"name":"@f/x"}\n')
    writeFileSync(join(root, 'README.md'), 'a\n')
    const a = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    writeFileSync(join(root, 'README.md'), 'b\n')
    const b = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    expect(a).toEqual(b)
  })

  it('reports exactly the components whose digest changed', () => {
    writeSrc({ 'index.ts': 'x\n' })
    writeFileSync(join(root, 'package.json'), '{"name":"@f/x"}\n')
    const base = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    writeFileSync(join(root, 'package.json'), '{"name":"@f/y"}\n')
    const current = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    expect(restartReasonsForBaseline(current, base)).toEqual(['plugin-manifest'])
  })

  it('throws when the required package.json is absent', () => {
    // A temp dir with no package.json is a real ENOENT on every platform.
    expect(() => computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })).toThrow(/ENOENT/)
  })

  it('throws when the required src tree is absent (required source read failure)', () => {
    writeFileSync(join(root, 'package.json'), '{"name":"@f/x"}\n')
    expect(() => computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })).toThrow(/ENOENT|not a directory/i)
  })

  it('does not silently turn a non-ENOENT read failure into empty', () => {
    const eacces = (() => { const e = new Error('EACCES') as NodeJS.ErrnoException; e.code = 'EACCES'; return e })()
    const read = vi.fn<() => string>(() => { throw eacces })
    expect(() => digestOptionalFile('A:/x/plugin.yaml', read)).toThrow(/EACCES/)
    const enoent = (() => { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; return e })()
    expect(digestOptionalFile('A:/x/plugin.yaml', vi.fn<() => string>(() => { throw enoent }))).toBe(EMPTY_DIGEST)
    expect(() => digestRequiredFile('A:/x/package.json', read)).toThrow(/EACCES/)
  })

  it('aggregates deterministically with sourceTree in a fixed order, equal to an independently computed hash', () => {
    const a: DevRestartBaseline = {
      pluginManifest: digestString('manifest'),
      pluginMetadata: digestString('metadata'),
      targetPin: digestString('target'),
      sourceTree: digestString('source'),
    }
    // Opposite construction order — must produce the SAME aggregate.
    const b: DevRestartBaseline = {
      sourceTree: digestString('source'),
      targetPin: digestString('target'),
      pluginMetadata: digestString('metadata'),
      pluginManifest: digestString('manifest'),
    }
    expect(aggregateRestartHash(a)).toBe(aggregateRestartHash(b))
    // Independent expected hash: length-prefixed key:value fields in FIXED order.
    const h = createHash('sha256')
    for (const [key, value] of [
      ['pluginManifest', a.pluginManifest],
      ['pluginMetadata', a.pluginMetadata],
      ['targetPin', a.targetPin],
      ['sourceTree', a.sourceTree],
    ] as const) {
      const byte = Buffer.from(`${key}:${value}`, 'utf8')
      const len = Buffer.alloc(8)
      len.writeBigUInt64BE(BigInt(byte.length))
      h.update(len); h.update(byte)
    }
    expect(aggregateRestartHash(a)).toBe(`sha256:${h.digest('hex')}`)
    expect(aggregateRestartHash(a)).toMatch(/^sha256:[a-f0-9]{64}$/)
  })
})
