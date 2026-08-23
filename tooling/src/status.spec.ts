import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginEvidenceKey, publishRunResult, type VerifyRunResultV1 } from './evidence.js'
import { publishUiResult, type UiResultV1 } from './ui-evidence.js'
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
  uiRunsRoot: string
  plugin: PluginRef
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lab-status-'))
  roots.push(root)
  const sourcePath = join(root, 'plugin')
  const runsRoot = join(root, '.lab', 'runs')
  const uiRunsRoot = join(root, '.lab', 'ui-runs')
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
    uiRunsRoot,
    plugin: { sourcePath, packageName: '@fixture/status' },
  }
}

function publishCurrentUi(opts: {
  root: string
  uiRunsRoot: string
  plugin: PluginRef
  sessionId?: string
  finishedAt?: string
  verdict?: 'pass' | 'fail'
  target?: 'next' | 'master'
}): UiResultV1 {
  const target = opts.target ?? 'next'
  const result: UiResultV1 = {
    schemaVersion: 1,
    sessionId: opts.sessionId ?? 'ui-20260824T120000000Z-a1b2c3d4',
    operation: 'ui',
    verdict: opts.verdict ?? 'pass',
    plugin: { ...opts.plugin, digest: computePluginDigest(opts.plugin.sourcePath).digest },
    target: target === 'next' ? { name: 'next', dsh: NEXT } : { name: 'master', commit: MASTER },
    lab: { contextDigest: currentContextDigest(opts.root) },
    summary: 'External agent verified the rendered client surface.',
    cleanup: 'pass',
    startedAt: '2026-08-24T12:00:00.000Z',
    finishedAt: opts.finishedAt ?? '2026-08-24T12:01:00.000Z',
  }
  publishUiResult({ uiRunsRoot: opts.uiRunsRoot, result })
  return result
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
    expect(() => readdirSync(join(root, '.lab', 'ui-runs'))).toThrow()
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

  it.each(['pass', 'fail'] as const)('derives a current finalized UI %s verdict', verdict => {
    const current = fixture(true)
    const evidence = publishCurrentUi({ ...current, verdict })

    expect(derivePluginStatus(current).ui).toEqual({
      state: verdict,
      sessionId: evidence.sessionId,
    })
  })

  it('selects the newest finalized UI result independently from verify runs', () => {
    const current = fixture(true)
    publishCurrentRun({ ...current, runId: 'verify-newest', finishedAt: '2026-08-24T14:00:00.000Z', next: 'pass' })
    publishCurrentUi({
      ...current,
      sessionId: 'ui-20260824T100000000Z-11111111',
      finishedAt: '2026-08-24T10:01:00.000Z',
      verdict: 'pass',
    })
    const newest = publishCurrentUi({
      ...current,
      sessionId: 'ui-20260824T110000000Z-22222222',
      finishedAt: '2026-08-24T11:01:00.000Z',
      verdict: 'fail',
    })

    const status = derivePluginStatus(current)
    expect(status.ui).toEqual({ state: 'fail', sessionId: newest.sessionId })
    expect(status.targets.next).toEqual({ state: 'pass', runId: 'verify-newest' })
  })

  it.each([
    ['plugin bytes', (root: string, plugin: PluginRef) => writeFileSync(join(plugin.sourcePath, 'src', 'index.ts'), 'changed\n'), 'PLUGIN_CONTENT_CHANGED'],
    ['next pin', (root: string) => writeCompatibility(root, '0.1.1-rc.3', MASTER), 'TARGET_PIN_CHANGED'],
    ['master pin', (root: string) => writeCompatibility(root, NEXT, '2'.repeat(40)), 'TARGET_PIN_CHANGED'],
    ['context', (root: string) => writeFileSync(join(root, 'context', 'rule.md'), 'changed\n'), 'LAB_CONTEXT_CHANGED'],
  ] as const)('marks finalized UI evidence stale when %s changes', (label, mutate, reason) => {
    const current = fixture(true)
    const target = label === 'master pin' ? 'master' : 'next'
    const evidence = publishCurrentUi({ ...current, target })
    mutate(current.root, current.plugin)

    expect(derivePluginStatus(current).ui).toEqual({
      state: 'stale',
      sessionId: evidence.sessionId,
      reasons: [reason],
    })
  })

  it('sorts and deduplicates all finalized UI stale reasons', () => {
    const current = fixture(true)
    const evidence = publishCurrentUi(current)
    writeFileSync(join(current.plugin.sourcePath, 'src', 'index.ts'), 'changed\n')
    writeCompatibility(current.root, '0.1.1-rc.3', MASTER)
    writeFileSync(join(current.root, 'context', 'rule.md'), 'changed\n')

    expect(derivePluginStatus(current).ui).toEqual({
      state: 'stale',
      sessionId: evidence.sessionId,
      reasons: ['LAB_CONTEXT_CHANGED', 'PLUGIN_CONTENT_CHANGED', 'TARGET_PIN_CHANGED'],
    })
  })

  it('keeps status fully read-only while loading UI evidence', () => {
    const current = fixture(true)
    publishCurrentUi(current)
    const before = directorySnapshot(current.root)

    derivePluginStatus(current)

    expect(directorySnapshot(current.root)).toEqual(before)
  })

  it('reports corrupt finalized UI evidence as an explicit error containing its path', () => {
    const current = fixture(true)
    const resultPath = join(
      current.uiRunsRoot,
      pluginEvidenceKey(current.plugin),
      'ui-20260824T120000000Z-deadbeef',
      'result.json',
    )
    mkdirSync(join(resultPath, '..'), { recursive: true })
    writeFileSync(resultPath, '{broken')

    expect(() => derivePluginStatus(current)).toThrow(
      new RegExp(`Corrupt finalized UI evidence.*${escapeRegex(resultPath)}`, 'i'),
    )
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

function directorySnapshot(root: string): Array<[string, string]> {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map(entry => {
      const path = join(entry.parentPath, entry.name)
      const relativePath = path.slice(root.length + 1).replaceAll('\\', '/')
      return [relativePath, entry.isFile() ? readFileSync(path, 'utf8') : '<directory>'] as [string, string]
    })
    .sort(([left], [right]) => left.localeCompare(right))
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
