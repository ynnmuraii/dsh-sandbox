import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { resolvePluginRef } from './plugin-ref.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lab-plugin-ref-'))
  temporaryRoots.push(root)
  return root
}

function writePlugin(path: string, packageName: string, withMetadata = true): void {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name: packageName, type: 'module' }))
  if (withMetadata) {
    mkdirSync(join(path, '.dsh-lab'), { recursive: true })
    writeFileSync(
      join(path, '.dsh-lab', 'plugin.yaml'),
      'name: demo\ntracking: local\nmaturity: experiment\ntargets: [next]\n',
    )
  }
}

describe('resolvePluginRef', () => {
  it('resolves a catalog name with package identity, catalog entry, and metadata', () => {
    const root = fixtureRoot()
    const plugin = join(root, 'plugins', 'demo')
    requireDirectory(plugin)
    writePlugin(plugin, '@fixture/demo')
    writeFileSync(
      join(root, 'catalog.yaml'),
      'plugins:\n  demo:\n    path: plugins/demo\n    tracking: local\n    maturity: experiment\n',
    )

    expect(resolvePluginRef({ root, selector: { name: 'demo' } })).toMatchObject({
      sourcePath: resolve(plugin),
      packageName: '@fixture/demo',
      catalogName: 'demo',
      catalogEntry: {
        path: 'plugins/demo',
        tracking: 'local',
        maturity: 'experiment',
      },
      metadata: {
        name: 'demo',
        tracking: 'local',
        maturity: 'experiment',
        targets: ['next'],
      },
    })
  })

  it('resolves an absolute path to a standalone plugin without metadata', () => {
    const root = fixtureRoot()
    const external = join(root, 'external-plugin')
    requireDirectory(external)
    writePlugin(external, '@fixture/external', false)

    expect(resolvePluginRef({ root, selector: { path: external } })).toMatchObject({
      sourcePath: resolve(external),
      packageName: '@fixture/external',
    })
    expect(resolvePluginRef({ root, selector: { path: external } })).not.toHaveProperty('metadata')
    expect(resolvePluginRef({ root, selector: { path: external } })).not.toHaveProperty('catalogName')
  })

  it('resolves a relative path and normalizes it to an absolute source path', () => {
    const root = fixtureRoot()
    const external = join(root, 'relative-plugin')
    requireDirectory(external)
    writePlugin(external, '@fixture/relative', false)
    const pathFromCwd = relative(process.cwd(), external)

    expect(resolvePluginRef({ root, selector: { path: pathFromCwd } })).toMatchObject({
      sourcePath: resolve(pathFromCwd),
      packageName: '@fixture/relative',
    })
  })

  it.each([
    [{}, /exactly one/i],
    [{ name: 'demo', path: 'plugin' }, /exactly one/i],
  ])('requires exactly one selector identifier: %j', (selector, message) => {
    expect(() => resolvePluginRef({ root: fixtureRoot(), selector })).toThrow(message)
  })

  it('reports a missing catalog name', () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'catalog.yaml'), 'plugins: {}\n')
    expect(() => resolvePluginRef({ root, selector: { name: 'missing' } })).toThrow(
      /plugin 'missing' not found in catalog/i,
    )
  })

  it('reports a missing source directory', () => {
    const root = fixtureRoot()
    const missing = join(root, 'does-not-exist')
    expect(() => resolvePluginRef({ root, selector: { path: missing } })).toThrow(
      new RegExp(resolve(missing).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
  })

  it('includes the resolved source path when package.json is malformed', () => {
    const root = fixtureRoot()
    const plugin = join(root, 'bad-package')
    requireDirectory(plugin)
    writeFileSync(join(plugin, 'package.json'), '{ not json')
    expect(() => resolvePluginRef({ root, selector: { path: plugin } })).toThrow(
      new RegExp(resolve(plugin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
  })

  it('rejects a package.json without a package name and includes its source path', () => {
    const root = fixtureRoot()
    const plugin = join(root, 'unnamed-package')
    requireDirectory(plugin)
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ private: true }))
    expect(() => resolvePluginRef({ root, selector: { path: plugin } })).toThrow(
      new RegExp(resolve(plugin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
  })
})

function requireDirectory(path: string): void {
  mkdirSync(path, { recursive: true })
}
