import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
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
    const res = await syncContext({ root: dir, names: ['a'], all: false })
    expect(res[0]!.path).toBe(join(dir, 'plugins', 'a', '.dsh-lab', 'shared-context.md'))
    expect(readFileSync(res[0]!.path, 'utf8')).toMatch(/^# Shared context snapshot/)
  })
})
