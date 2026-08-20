import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlugin, loadPluginConfig } from './create.js'
import { loadCatalogFromFile } from './schemas.js'
import { snapshotContext } from './sync.js'

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
    // Target dir exists and holds a file, but is NOT in the catalog -> the
    // target-existence guard fires (not the catalog-name guard).
    const target = join(dir, 'plugins', 'example')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'somefile'), 'x')
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

  it('rejects a name already registered in the catalog without touching the target', async () => {
    // Catalog already claims 'example' -> `lab new example` must refuse rather
    // than overwrite the catalog entry / manufacture a fresh scaffold.
    writeFileSync(
      join(dir, 'catalog.yaml'),
      ['plugins:', '  example:', '    path: plugins/example', '    tracking: local', '    maturity: experiment'].join('\n') + '\n',
    )
    await expect(createPlugin({ root: dir, name: 'example' })).rejects.toThrow(/already registered/i)
    expect(existsSync(join(dir, 'plugins', 'example'))).toBe(false)
  })

  it('scaffolds a package.json carrying the runnable standalone dev deps', async () => {
    await createPlugin({ root: dir, name: 'example' })
    const pkg = JSON.parse(readFileSync(join(dir, 'plugins', 'example', 'package.json'), 'utf8'))
    for (const dep of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', 'vitest', 'typescript', '@types/node', 'tsx']) {
      expect(pkg.devDependencies[dep]).toBeTruthy()
    }
    expect(pkg.peerDependencies['@deepseek-ai/cordis']).toBeTruthy()
  })

  it('writes the canonical shared-context snapshot (not a not-synced stub)', async () => {
    mkdirSync(join(dir, 'context'), { recursive: true })
    writeFileSync(join(dir, 'context', 'a.md'), 'hello')
    const canonical = snapshotContext(dir, [readFileSync(join(dir, 'context', 'a.md'), 'utf8')])
    const canonicalHash = /^> context version: (\S+)$/m.exec(canonical)?.[1]
    await createPlugin({ root: dir, name: 'example' })
    const written = readFileSync(join(dir, 'plugins', 'example', '.dsh-lab', 'shared-context.md'), 'utf8')
    expect(canonicalHash).toBeTruthy()
    expect(written).not.toContain('not-synced')
    expect(written).toContain(`context version: ${canonicalHash}`)
  })
})
