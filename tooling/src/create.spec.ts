import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlugin, loadPluginConfig } from './create.js'
import { loadCatalogFromFile } from './schemas.js'

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

  it('registers the new plugin in the catalog (creating it when absent)', async () => {
    await createPlugin({ root: dir, name: 'example' })
    const catalog = loadCatalogFromFile(join(dir, 'catalog.yaml'))
    const entry = catalog.plugins['example']!
    expect(entry.path).toBe('plugins/example')
    expect(entry.tracking).toBe('local')
    expect(entry.maturity).toBe('experiment')
  })

  it('adds to an existing catalog without dropping other plugins', async () => {
    mkdirSync(join(dir, 'plugins', 'other'), { recursive: true })
    writeFileSync(
      join(dir, 'catalog.yaml'),
      ['plugins:', '  other:', '    path: plugins/other', '    tracking: local', '    maturity: stable'].join('\n') + '\n',
    )
    await createPlugin({ root: dir, name: 'example' })
    const catalog = loadCatalogFromFile(join(dir, 'catalog.yaml'))
    expect(catalog.plugins['other']).toBeTruthy()
    expect(catalog.plugins['example']).toBeTruthy()
  })

  it('scaffolds a package.json carrying the runnable standalone dev deps', async () => {
    await createPlugin({ root: dir, name: 'example' })
    const pkg = JSON.parse(readFileSync(join(dir, 'plugins', 'example', 'package.json'), 'utf8'))
    for (const dep of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', 'vitest', 'typescript', '@types/node', 'tsx']) {
      expect(pkg.devDependencies[dep]).toBeTruthy()
    }
    expect(pkg.peerDependencies['@deepseek-ai/cordis']).toBeTruthy()
  })
})
