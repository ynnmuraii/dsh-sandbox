import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotContext, syncContext } from './sync.js'

describe('snapshotContext', () => {
  it('embeds a version hash of the inputs', () => {
    const a = snapshotContext('/root', ['# c1\n'])
    const b = snapshotContext('/root', ['# c1\n'])
    const c = snapshotContext('/root', ['# c1 changed\n'])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^# Shared context snapshot/)
  })
})

describe('syncContext', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-sync-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('writes a snapshot into each plugin repo', async () => {
    writeFileSync(join(dir, 'catalog.yaml'), 'plugins:\n  a:\n    path: plugins/a\n    tracking: local\n')
    writeFileSync(join(dir, 'workbench-compat-stub'), '')
    mkdirSync(join(dir, 'plugins', 'a'), { recursive: true })
    writeFileSync(join(dir, 'plugins', 'a', 'package.json'), '{}')
    execFileSync('git', ['init', '-q'], { cwd: join(dir, 'plugins', 'a') })
    const res = await syncContext({ root: dir, names: ['a'], all: false })
    expect(res[0]!.path).toBe(join(dir, 'plugins', 'a', '.dsh-lab', 'shared-context.md'))
    expect(readFileSync(res[0]!.path, 'utf8')).toMatch(/^# Shared context snapshot/)
  })

  it('refuses to sync when the plugin repo is missing (no manufactured .dsh-lab)', async () => {
    // Cataloged 'a' has no plugins/a directory at all -> must refuse instead of
    // fabricating a standalone repo.
    writeFileSync(join(dir, 'catalog.yaml'), 'plugins:\n  a:\n    path: plugins/a\n    tracking: local\n')
    await expect(syncContext({ root: dir, names: ['a'], all: false })).rejects.toThrow(/missing or not a git repo/)
    expect(existsSync(join(dir, 'plugins', 'a', '.dsh-lab'))).toBe(false)
  })

  it('ignores named targets not in the catalog (incl. prototype keys)', async () => {
    writeFileSync(join(dir, 'catalog.yaml'), 'plugins:\n  a:\n    path: plugins/a\n    tracking: local\n')
    mkdirSync(join(dir, 'plugins', 'a'), { recursive: true })
    const res = await syncContext({ root: dir, names: ['constructor'], all: false })
    expect(res).toHaveLength(0)
  })

  it('does not crash when catalog is missing and a name collides with a prototype key', async () => {
    // No catalog.yaml present -> plugins = {}; 'constructor' must resolve to
    // "not found" rather than the inherited Object constructor.
    mkdirSync(join(dir, 'plugins', 'constructor'), { recursive: true })
    const res = await syncContext({ root: dir, names: ['constructor'], all: false })
    expect(res).toHaveLength(0)
  })
})
