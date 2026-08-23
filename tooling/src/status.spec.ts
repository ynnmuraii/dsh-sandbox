import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginEvidenceKey, publishRunResult, type VerifyRunResultV1 } from './evidence.js'
import { computePluginDigest } from './plugin-snapshot.js'
import type { PluginRef } from './plugin-ref.js'
import { derivePluginStatus } from './status.js'

const roots: string[] = []
const NEXT = '0.1.1-rc.2'
const MASTER = '1'.repeat(40)

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(client: boolean | 'unknown' = false): {
  root: string
  runsRoot: string
  plugin: PluginRef
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lab-status-'))
  roots.push(root)
  const sourcePath = join(root, 'plugin')
  const runsRoot = join(root, '.lab', 'runs')
  mkdirSync(join(sourcePath, 'src'), { recursive: true })
  mkdirSync(join(root, 'workbench'), { recursive: true })
  mkdirSync(join(root, 'context'), { recursive: true })
  writeFileSync(join(sourcePath, 'src', 'index.ts'), 'export const plugin = true\n')
  writeFileSync(join(sourcePath, 'cordis.patch.yml'), '- insert:\n    - id: fixture\n')
  writeFileSync(join(sourcePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(sourcePath, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(
    join(sourcePath, 'package.json'),
    `${JSON.stringify({
      name: '@fixture/status',
      version: '0.0.0',
      type: 'module',
      packageManager: 'pnpm@11.7.0',
      main: 'lib/index.js',
      exports: { '.': './lib/index.js' },
      files: ['lib', 'cordis.patch.yml'],
      dsh: {
        bundle: { patch: 'cordis.patch.yml' },
        ...(client === 'unknown' ? {} : { client }),
      },
      scripts: {
        build: 'tsc',
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
        'pack-smoke': 'node scripts/pack-smoke.mjs',
      },
      peerDependencies: {
        '@deepseek-ai/cordis': '4.0.1',
        '@deepseek-ai/dsh-tools': NEXT,
      },
      devDependencies: {
        '@deepseek-ai/cordis': '4.0.1',
        '@deepseek-ai/dsh-tools': NEXT,
      },
    }, null, 2)}\n`,
  )
  writeCompatibility(root, NEXT, MASTER)
  return {
    root,
    runsRoot,
    plugin: { sourcePath, packageName: '@fixture/status' },
  }
}

function writeCompatibility(root: string, next = NEXT, master = MASTER): void {
  writeFileSync(join(root, 'workbench', 'compatibility.yaml'), [
    'targets:',
    '  next:',
    `    dsh: ${next}`,
    '    cordis: 4.0.1',
    '    node: 22.20.0',
    '    pnpm: 11.7.0',
    '  master:',
    '    repository: deepseek-ai/deepseek-harness',
    `    commit: ${master}`,
    '    pnpm: 11.7.0',
    '    node: ^22.19.0',
    '',
  ].join('\n'))
}

function currentContextDigest(root: string): `sha256:${string}` {
  const contextRoot = join(root, 'context')
  const hash = createHash('sha256')
  const files = readdirSync(contextRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
  for (const path of files) {
    hash.update(path.slice(contextRoot.length + 1).replaceAll('\\', '/'))
    hash.update(readFileSync(path))
  }
  return `sha256:${hash.digest('hex')}`
}

function publishCurrentRun(opts: {
  root: string
  runsRoot: string
  plugin: PluginRef
  runId?: string
  finishedAt?: string
  next?: 'pass' | 'fail'
  master?: 'pass' | 'fail'
  bundle?: 'pass' | 'fail'
}): VerifyRunResultV1 {
  const digest = computePluginDigest(opts.plugin.sourcePath).digest
  const bundle = opts.bundle ?? 'pass'
  const targets: VerifyRunResultV1['targets'] = {}
  if (opts.next) targets.next = { dsh: NEXT, result: opts.next }
  if (opts.master) targets.master = { commit: MASTER, result: opts.master }
  const runId = opts.runId ?? 'verify-current'
  const result: VerifyRunResultV1 = {
    schemaVersion: 1,
    runId,
    operation: 'verify',
    result: bundle === 'fail' || Object.values(targets).some(target => target.result === 'fail') ? 'fail' : 'pass',
    plugin: { ...opts.plugin, digest },
    targets,
    lab: { contextDigest: currentContextDigest(opts.root) },
    environment: { node: 'v22.20.0', pnpm: '11.7.0', platform: process.platform },
    steps: [
      { id: 'inspect', status: 'pass', durationMs: 1 },
      { id: 'install', status: 'pass', durationMs: 1 },
      { id: 'typecheck', status: 'pass', durationMs: 1 },
      { id: 'test', status: 'pass', durationMs: 1 },
      { id: 'build', status: 'pass', durationMs: 1 },
      { id: 'pack', status: 'pass', durationMs: 1 },
      { id: 'pack-smoke', status: bundle, durationMs: 1 },
    ],
    cleanup: 'pass',
    startedAt: '2026-08-23T10:00:00.000Z',
    finishedAt: opts.finishedAt ?? '2026-08-23T10:00:01.000Z',
  }
  publishRunResult({ runsRoot: opts.runsRoot, result })
  return result
}

describe('derivePluginStatus', () => {
  it('returns not-run claims without evidence and does not create runtime state', () => {
    const { root, runsRoot, plugin } = fixture()
    const before = computePluginDigest(plugin.sourcePath)

    const status = derivePluginStatus({ root, runsRoot, plugin })

    expect(status.plugin).toEqual({ ...plugin, digest: before.digest })
    expect(status.structure).toEqual({ state: 'not-run' })
    expect(status.bundle).toEqual({ state: 'not-run' })
    expect(status.targets).toEqual({ next: { state: 'not-run' }, master: { state: 'not-run' } })
    expect(status.ui).toEqual({ state: 'not-applicable' })
    expect(computePluginDigest(plugin.sourcePath)).toEqual(before)
    expect(() => readdirSync(runsRoot)).toThrow()
  })

  it('derives current pass and fail claims with their source run ID', () => {
    const current = fixture()
    publishCurrentRun({ ...current, next: 'pass', master: 'fail', bundle: 'fail' })

    const status = derivePluginStatus(current)

    expect(status.structure).toEqual({ state: 'pass', runId: 'verify-current' })
    expect(status.bundle).toEqual({ state: 'fail', runId: 'verify-current' })
    expect(status.targets.next).toEqual({ state: 'pass', runId: 'verify-current' })
    expect(status.targets.master).toEqual({ state: 'fail', runId: 'verify-current' })
  })

  it.each([
    ['plugin bytes', (root: string, plugin: PluginRef) => writeFileSync(join(plugin.sourcePath, 'src', 'index.ts'), 'changed\n'), 'PLUGIN_CONTENT_CHANGED'],
    ['next pin', (root: string) => writeCompatibility(root, '0.1.1-rc.3', MASTER), 'TARGET_PIN_CHANGED'],
    ['master pin', (root: string) => writeCompatibility(root, NEXT, '2'.repeat(40)), 'TARGET_PIN_CHANGED'],
    ['context', (root: string) => writeFileSync(join(root, 'context', 'rule.md'), 'changed\n'), 'LAB_CONTEXT_CHANGED'],
  ] as const)('marks claims stale when %s changes', (_label, mutate, reason) => {
    const current = fixture()
    publishCurrentRun({ ...current, next: 'pass', master: 'pass' })
    mutate(current.root, current.plugin)

    const status = derivePluginStatus(current)

    if (reason === 'TARGET_PIN_CHANGED') {
      const changed = _label === 'next pin' ? status.targets.next : status.targets.master
      expect(changed).toEqual({ state: 'stale', runId: 'verify-current', reasons: [reason] })
    } else {
      expect(status.structure).toEqual({ state: 'stale', runId: 'verify-current', reasons: [reason] })
      expect(status.bundle).toEqual({ state: 'stale', runId: 'verify-current', reasons: [reason] })
      expect(status.targets.next).toEqual({ state: 'stale', runId: 'verify-current', reasons: [reason] })
    }
  })

  it('sorts and deduplicates multiple stale reasons', () => {
    const current = fixture()
    publishCurrentRun({ ...current, next: 'pass' })
    writeFileSync(join(current.plugin.sourcePath, 'src', 'index.ts'), 'changed\n')
    writeCompatibility(current.root, '0.1.1-rc.3', MASTER)
    writeFileSync(join(current.root, 'context', 'rule.md'), 'changed\n')

    expect(derivePluginStatus(current).targets.next).toEqual({
      state: 'stale',
      runId: 'verify-current',
      reasons: ['LAB_CONTEXT_CHANGED', 'PLUGIN_CONTENT_CHANGED', 'TARGET_PIN_CHANGED'],
    })
  })

  it('selects the newest relevant evidence independently for each claim', () => {
    const current = fixture()
    publishCurrentRun({ ...current, runId: 'older-master', finishedAt: '2026-08-23T10:00:01.000Z', master: 'pass' })
    publishCurrentRun({ ...current, runId: 'newer-next', finishedAt: '2026-08-23T11:00:01.000Z', next: 'fail' })

    const status = derivePluginStatus(current)

    expect(status.targets.next).toEqual({ state: 'fail', runId: 'newer-next' })
    expect(status.targets.master).toEqual({ state: 'pass', runId: 'older-master' })
    expect(status.structure.runId).toBe('newer-next')
    expect(status.bundle.runId).toBe('newer-next')
  })

  it('only reports UI not-applicable when inspection safely proves no client face', () => {
    const withoutClient = fixture(false)
    const unknownClient = fixture('unknown')

    expect(derivePluginStatus(withoutClient).ui).toEqual({ state: 'not-applicable' })
    expect(derivePluginStatus(unknownClient).ui).toEqual({ state: 'not-run' })
  })

  it('reports corrupt finalized evidence as an explicit error containing its path', () => {
    const current = fixture()
    const key = pluginEvidenceKey(current.plugin)
    const resultPath = join(current.runsRoot, key, 'broken-run', 'result.json')
    mkdirSync(join(resultPath, '..'), { recursive: true })
    writeFileSync(resultPath, '{broken')

    expect(() => derivePluginStatus(current)).toThrow(new RegExp(`Corrupt finalized evidence.*result\\.json`, 'i'))
  })
})
