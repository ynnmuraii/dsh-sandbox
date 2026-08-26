import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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

  it('computes the empty digest for an absent plugin.yaml so absent⇄present is observable', () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{}\n')
    // no .dsh-lab/plugin.yaml
    const baseline = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    expect(baseline.pluginMetadata).toBe(EMPTY_DIGEST)
    expect(baseline.pluginMetadata).toBe(digestString(''))
  })

  it('excludes src/** and non-restart files: only package.json, plugin.yaml, targetPin feed the hash', () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'index.ts'), 'export const live = true\n')
    writeFileSync(join(root, 'package.json'), '{"name":"@f/x"}\n')
    mkdirSync(join(root, '.dsh-lab'), { recursive: true })
    writeFileSync(join(root, '.dsh-lab', 'plugin.yaml'), 'name: x\ntargets:\n  - next\n')
    const a = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    // Editing src/** must leave every component unchanged.
    writeFileSync(join(root, 'src', 'index.ts'), 'export const live = false\n')
    const b = computeDevRestartBaseline({ pluginSourcePath: root, targetPin: '0.1.1-rc.2' })
    expect(a).toEqual(b)
  })

  it('reports exactly the components whose digest changed', () => {
    mkdirSync(join(root, 'src'), { recursive: true })
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

  it('does not silently turn a non-ENOENT read failure into empty', () => {
    const eacces = (() => { const e = new Error('EACCES') as NodeJS.ErrnoException; e.code = 'EACCES'; return e })()
    const read = vi.fn<() => string>(() => { throw eacces })
    expect(() => digestOptionalFile('A:/x/plugin.yaml', read)).toThrow(/EACCES/)
    const enoent = (() => { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; return e })()
    expect(digestOptionalFile('A:/x/plugin.yaml', vi.fn<() => string>(() => { throw enoent }))).toBe(EMPTY_DIGEST)
    expect(() => digestRequiredFile('A:/x/package.json', read)).toThrow(/EACCES/)
  })

  it('aggregates deterministically: same values regardless of literal key order, equal to an independently computed hash', () => {
    const a: DevRestartBaseline = {
      pluginManifest: digestString('manifest'),
      pluginMetadata: digestString('metadata'),
      targetPin: digestString('target'),
    }
    // Opposite construction order — must produce the SAME aggregate.
    const b: DevRestartBaseline = {
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
