import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectPlugin, type InspectionResult } from './inspect.js'
import type { PluginRef } from './plugin-ref.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; plugin: PluginRef } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lab-inspect-'))
  roots.push(root)
  const sourcePath = join(root, 'plugin')
  mkdirSync(join(sourcePath, 'src'), { recursive: true })
  mkdirSync(join(sourcePath, '.dsh-lab'), { recursive: true })
  mkdirSync(join(root, 'workbench'), { recursive: true })
  writeFileSync(
    join(root, 'workbench', 'compatibility.yaml'),
    [
      'targets:',
      '  next:',
      '    dsh: 0.1.1-rc.2',
      '    cordis: 4.0.1',
      '    node: 22.20.0',
      '    pnpm: 11.7.0',
      '  master:',
      '    repository: deepseek-ai/deepseek-harness',
      `    commit: ${'1'.repeat(40)}`,
      '    pnpm: 11.7.0',
      '    node: ^22.19.0',
      '',
    ].join('\n'),
  )
  writePackage(sourcePath, validPackage())
  writeFileSync(join(sourcePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(sourcePath, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(sourcePath, 'cordis.patch.yml'), '- insert:\n    - id: demo\n      name: "@fixture/demo"\n')
  writeFileSync(join(sourcePath, 'src', 'index.ts'), 'export const name = "demo"\n')
  writeFileSync(
    join(sourcePath, '.dsh-lab', 'plugin.yaml'),
    'name: demo\ntracking: local\nmaturity: experiment\ntargets:\n  - next\n',
  )
  return {
    root,
    plugin: {
      sourcePath,
      packageName: '@fixture/demo',
      metadata: { name: 'demo', tracking: 'local', maturity: 'experiment', targets: ['next'] },
    },
  }
}

function validPackage(): Record<string, unknown> {
  return {
    name: '@fixture/demo',
    version: '0.0.0',
    type: 'module',
    packageManager: 'pnpm@11.7.0',
    main: 'lib/index.js',
    types: 'lib/index.d.ts',
    exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' } },
    files: ['lib', 'cordis.patch.yml'],
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
    scripts: {
      build: 'tsc -p tsconfig.build.json',
      typecheck: 'tsc -p tsconfig.json --noEmit',
      test: 'vitest run',
      'pack-smoke': 'node scripts/pack-smoke.mjs',
    },
    peerDependencies: {
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-tools': '0.1.1-rc.2',
    },
    devDependencies: {
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-tools': '0.1.1-rc.2',
    },
  }
}

function writePackage(sourcePath: string, manifest: Record<string, unknown>): void {
  writeFileSync(join(sourcePath, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function manifest(sourcePath: string): Record<string, any> {
  return JSON.parse(readFileSync(join(sourcePath, 'package.json'), 'utf8'))
}

function fileSnapshot(path: string): string[] {
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(path.length + 1).replaceAll('\\', '/'))
    .sort()
}

function codes(result: InspectionResult): Array<[string, string]> {
  return result.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity])
}

describe('inspectPlugin', () => {
  it('accepts a valid standalone host plugin without mutating it', () => {
    const { root, plugin } = fixture()
    const before = fileSnapshot(plugin.sourcePath)

    const result = inspectPlugin({ root, plugin, target: 'next' })

    expect(result).toEqual({
      schemaVersion: 1,
      plugin: { packageName: '@fixture/demo', sourcePath: plugin.sourcePath },
      faces: { host: true, client: 'unknown' },
      diagnostics: [],
      ok: true,
    })
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
    expect(fileSnapshot(plugin.sourcePath)).toEqual(before)
  })

  it.each([
    ['PACKAGE_NOT_ESM', 'error', ({ plugin }: ReturnType<typeof fixture>) => {
      const pkg = manifest(plugin.sourcePath)
      pkg.type = 'commonjs'
      writePackage(plugin.sourcePath, pkg)
    }],
    ['LOCKFILE_MISSING', 'error', ({ plugin }: ReturnType<typeof fixture>) => {
      unlinkSync(join(plugin.sourcePath, 'pnpm-lock.yaml'))
    }],
    ['WORKSPACE_BOUNDARY_MISSING', 'error', ({ plugin }: ReturnType<typeof fixture>) => {
      unlinkSync(join(plugin.sourcePath, 'pnpm-workspace.yaml'))
    }],
    ['SCRIPT_MISSING', 'error', ({ plugin }: ReturnType<typeof fixture>) => {
      const pkg = manifest(plugin.sourcePath)
      delete pkg.scripts.test
      writePackage(plugin.sourcePath, pkg)
    }],
    ['BUNDLE_PATCH_MISSING', 'error', ({ plugin }: ReturnType<typeof fixture>) => {
      unlinkSync(join(plugin.sourcePath, 'cordis.patch.yml'))
    }],
    ['EXPORT_MISMATCH', 'error', ({ plugin }: ReturnType<typeof fixture>) => {
      const pkg = manifest(plugin.sourcePath)
      pkg.exports['.'].default = './lib/other.js'
      writePackage(plugin.sourcePath, pkg)
    }],
    ['PRIVATE_UPSTREAM_IMPORT', 'error', ({ plugin }: ReturnType<typeof fixture>) => {
      writeFileSync(
        join(plugin.sourcePath, 'src', 'index.ts'),
        'import "../../upstream/deepseek-harness/src/private.js"\n',
      )
    }],
    ['DEPENDENCY_PIN_MISMATCH', 'error', ({ plugin }: ReturnType<typeof fixture>) => {
      const pkg = manifest(plugin.sourcePath)
      pkg.peerDependencies['@deepseek-ai/dsh-tools'] = '^0.1.0'
      writePackage(plugin.sourcePath, pkg)
    }],
  ] as const)('reports %s as an %s diagnostic', (code, severity, mutate) => {
    const subject = fixture()
    mutate(subject)

    const result = inspectPlugin({ root: subject.root, plugin: subject.plugin, target: 'next' })

    expect(codes(result)).toContainEqual([code, severity])
    expect(result.ok).toBe(false)
  })

  it('sorts diagnostics by code and then location', () => {
    const subject = fixture()
    unlinkSync(join(subject.plugin.sourcePath, 'pnpm-lock.yaml'))
    const pkg = manifest(subject.plugin.sourcePath)
    pkg.type = 'commonjs'
    writePackage(subject.plugin.sourcePath, pkg)

    const result = inspectPlugin({ root: subject.root, plugin: subject.plugin })

    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      'LOCKFILE_MISSING',
      'PACKAGE_NOT_ESM',
    ])
  })

  it('does not require metadata for structural inspection', () => {
    const subject = fixture()
    delete subject.plugin.metadata

    const result = inspectPlugin({ root: subject.root, plugin: subject.plugin })

    expect(result.ok).toBe(true)
    expect(result.faces.client).toBe('unknown')
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'DEPENDENCY_PIN_MISMATCH' }),
    )
  })
})
