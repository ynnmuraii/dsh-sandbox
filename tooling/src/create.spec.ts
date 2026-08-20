import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlugin, loadPluginConfig } from './create.js'

describe('createPlugin', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-new-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates an independent git repo with template files', async () => {
    const target = join(dir, 'plugins', 'example')
    const created = await createPlugin({ root: dir, name: 'example' })
    expect(created).toBe(target)
    expect(existsSync(join(target, '.git'))).toBe(true)
    expect(existsSync(join(target, 'src', 'index.ts'))).toBe(true)
    expect(existsSync(join(target, '.dsh-lab', 'shared-context.md'))).toBe(true)
  })

  it('refuses an existing non-empty target', async () => {
    await createPlugin({ root: dir, name: 'example' })
    await expect(createPlugin({ root: dir, name: 'example' })).rejects.toThrow(/exists/i)
  })

  it('refuses a target that already contains .git', async () => {
    const target = join(dir, 'plugins', 'example')
    mkdirSync(join(target, '.git'), { recursive: true })
    await expect(createPlugin({ root: dir, name: 'example' })).rejects.toThrow(/exists/i)
    expect(existsSync(target)).toBe(true)
  })

  it('writes plugin.yaml that round-trips', async () => {
    const created = await createPlugin({ root: dir, name: 'example' })
    const cfg = loadPluginConfig(join(created, '.dsh-lab', 'plugin.yaml'))
    expect(cfg.name).toBe('example')
    expect(cfg.tracking).toBe('local')
    expect(cfg.targets).toContain('next')
  })
})
