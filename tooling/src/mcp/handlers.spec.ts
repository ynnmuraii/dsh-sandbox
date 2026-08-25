import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectPlugin } from '../inspect.js'
import { derivePluginStatus } from '../status.js'
import { doctor } from '../doctor.js'
import { pluginEvidenceKey, publishRunResult, type VerifyRunResultV1 } from '../evidence.js'
import { publishUiResult, type UiResultV1 } from '../ui-evidence.js'
import { computePluginDigest } from '../plugin-snapshot.js'
import { handleInspect, handleStatus, handleDoctor, handleGetEvidence, handleListPlugins, handleVerify, ToolError } from './handlers.js'
import { loadRunResults } from '../evidence.js'
import { resolvePluginRef } from '../plugin-ref.js'

const roots: string[] = []
const NEXT = '0.1.1-rc.2'
const MASTER = 'b'.repeat(40)

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRootWithPlugin(): { root: string; pluginPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-handlers-'))
  roots.push(root)
  const pluginPath = join(root, 'plugin')
  mkdirSync(join(pluginPath, 'src'), { recursive: true })
  mkdirSync(join(pluginPath, '.dsh-lab'), { recursive: true })
  mkdirSync(join(root, 'workbench'), { recursive: true })
  mkdirSync(join(root, 'context'), { recursive: true })
  writeFileSync(join(root, 'context', 'a.md'), 'hello')
  writeFileSync(
    join(root, 'workbench', 'compatibility.yaml'),
    [
      'targets:',
      '  next:',
      `    dsh: ${NEXT}`,
      '    cordis: 4.0.1',
      '    node: 22.20.0',
      '    pnpm: 11.7.0',
      '  master:',
      '    repository: deepseek-ai/deepseek-harness',
      `    commit: ${MASTER}`,
      '    pnpm: 11.7.0',
      '    node: ^22.19.0',
    ].join('\n'),
  )
  writeFileSync(join(pluginPath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(pluginPath, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(pluginPath, 'cordis.patch.yml'), '- insert:\n    - id: demo\n      name: "@fixture/demo"\n')
  writeFileSync(join(pluginPath, 'src', 'index.ts'), 'export const name = "demo"\n')
  writeFileSync(
    join(pluginPath, 'package.json'),
    JSON.stringify(
      {
        name: '@fixture/demo',
        version: '0.0.0',
        type: 'module',
        packageManager: 'pnpm@11.7.0',
        main: 'lib/index.js',
        exports: { '.': './lib/index.js' },
        files: ['lib', 'cordis.patch.yml'],
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
        scripts: { build: 'tsc', typecheck: 'tsc --noEmit', test: 'vitest run', 'pack-smoke': 'node scripts/pack-smoke.mjs' },
        peerDependencies: { '@deepseek-ai/cordis': '4.0.1', '@deepseek-ai/dsh-tools': NEXT },
        devDependencies: { '@deepseek-ai/cordis': '4.0.1', '@deepseek-ai/dsh-tools': NEXT },
      },
      null,
      2,
    ) + '\n',
  )
  writeFileSync(join(pluginPath, '.dsh-lab', 'plugin.yaml'), 'name: demo\ntracking: local\nmaturity: experiment\ntargets:\n  - next\n')
  return { root, pluginPath }
}

function makeVerifyRun(opts: {
  root: string
  pluginPath: string
  runId: string
  finishedAt: string
  startedAt?: string
}): VerifyRunResultV1 {
  const digest = computePluginDigest(opts.pluginPath).digest
  const plugin = { packageName: '@fixture/demo', sourcePath: opts.pluginPath, digest }
  const result: VerifyRunResultV1 = {
    schemaVersion: 1,
    runId: opts.runId,
    operation: 'verify',
    result: 'pass',
    plugin,
    targets: { next: { dsh: NEXT, result: 'pass' } },
    lab: { contextDigest: `sha256:${'b'.repeat(64)}` },
    environment: { node: '22.20.0', pnpm: '11.7.0', platform: process.platform },
    steps: [{ id: 'inspect', status: 'pass', durationMs: 1 }],
    cleanup: 'pass',
    startedAt: opts.startedAt ?? opts.finishedAt,
    finishedAt: opts.finishedAt,
  }
  return result
}

function makeUiRun(opts: {
  root: string
  pluginPath: string
  sessionId: string
  finishedAt: string
}): UiResultV1 {
  const digest = computePluginDigest(opts.pluginPath).digest
  const plugin = { packageName: '@fixture/demo', sourcePath: opts.pluginPath, digest }
  return {
    schemaVersion: 1,
    sessionId: opts.sessionId,
    operation: 'ui',
    verdict: 'pass',
    summary: 'looks good',
    plugin,
    target: { name: 'next', dsh: NEXT },
    lab: { contextDigest: `sha256:${'b'.repeat(64)}` },
    startedAt: opts.finishedAt,
    finishedAt: opts.finishedAt,
    cleanup: 'pass',
  } as UiResultV1
}

describe('mcp handlers parity', () => {
  it('inspect handler deep-equals direct inspectPlugin and preserves JSON string', () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const pluginRef = resolvePluginRef({ root, selector: { path: pluginPath } })
    const direct = inspectPlugin({ root, plugin: pluginRef })
    const viaHandler = handleInspect(root, { path: pluginPath })
    expect(viaHandler).toEqual(direct)
    expect(JSON.stringify(viaHandler)).toBe(JSON.stringify(direct))
  })

  it('inspect handler forwards target', () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const pluginRef = resolvePluginRef({ root, selector: { path: pluginPath } })
    const direct = inspectPlugin({ root, plugin: pluginRef, target: 'next' })
    const viaHandler = handleInspect(root, { path: pluginPath, target: 'next' })
    expect(viaHandler).toEqual(direct)
  })

  it('status handler deep-equals derivePluginStatus', () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const pluginRef = resolvePluginRef({ root, selector: { path: pluginPath } })
    const direct = derivePluginStatus({ root, plugin: pluginRef })
    const viaHandler = handleStatus(root, { path: pluginPath })
    expect(viaHandler).toEqual(direct)
    expect(JSON.stringify(viaHandler)).toBe(JSON.stringify(direct))
  })

  it('doctor handler deep-equals direct doctor', async () => {
    const { root } = mkRootWithPlugin()
    const direct = await doctor({ root })
    const viaHandler = await handleDoctor(root)
    expect(viaHandler).toEqual(direct)
    expect(JSON.stringify(viaHandler)).toBe(JSON.stringify(direct))
  })

  it('get_evidence with empty evidence dirs returns empty arrays', () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const result = handleGetEvidence(root, { path: pluginPath })
    expect(result).toEqual({ verify: [], ui: [] })
  })

  it('get_evidence loads newest-first and slices to limit', () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const runsRoot = join(root, '.lab', 'runs')
    const uiRunsRoot = join(root, '.lab', 'ui-runs')
    const pluginRef = resolvePluginRef({ root, selector: { path: pluginPath } })
    const pluginKey = pluginEvidenceKey(pluginRef)

    const r1 = makeVerifyRun({ root, pluginPath, runId: 'run-1', finishedAt: '2026-08-20T10:00:00.000Z', startedAt: '2026-08-20T10:00:00.000Z' })
    const r2 = makeVerifyRun({ root, pluginPath, runId: 'run-2', finishedAt: '2026-08-21T10:00:00.000Z', startedAt: '2026-08-21T10:00:00.000Z' })
    const r3 = makeVerifyRun({ root, pluginPath, runId: 'run-3', finishedAt: '2026-08-22T10:00:00.000Z', startedAt: '2026-08-22T10:00:00.000Z' })
    for (const r of [r1, r2, r3]) publishRunResult({ runsRoot, result: r })

    const u1 = makeUiRun({ root, pluginPath, sessionId: 'ui-20260820T100000000Z-a1b2c3d4', finishedAt: '2026-08-20T12:00:00.000Z' })
    const u2 = makeUiRun({ root, pluginPath, sessionId: 'ui-20260821T100000000Z-a1b2c3d4', finishedAt: '2026-08-21T12:00:00.000Z' })
    for (const u of [u1, u2]) publishUiResult({ uiRunsRoot, result: u })

    const all = handleGetEvidence(root, { path: pluginPath, kind: 'all', limit: 10 })
    expect(all.verify.map(r => r.runId)).toEqual(['run-3', 'run-2', 'run-1'])
    expect(all.ui.map(r => r.sessionId)).toEqual(['ui-20260821T100000000Z-a1b2c3d4', 'ui-20260820T100000000Z-a1b2c3d4'])

    const sliced = handleGetEvidence(root, { path: pluginPath, kind: 'all', limit: 2 })
    expect(sliced.verify).toHaveLength(2)
    expect(sliced.verify[0]!.runId).toBe('run-3')
    expect(sliced.ui).toHaveLength(2)

    const onlyVerify = handleGetEvidence(root, { path: pluginPath, kind: 'verify', limit: 1 })
    expect(onlyVerify.verify).toHaveLength(1)
    expect(onlyVerify.ui).toEqual([])

    const onlyUi = handleGetEvidence(root, { path: pluginPath, kind: 'ui', limit: 1 })
    expect(onlyUi.ui).toHaveLength(1)
    expect(onlyUi.verify).toEqual([])
  })

  it('list_plugins returns catalog entries and [] when missing', () => {
    const { root, pluginPath } = mkRootWithPlugin()
    // missing catalog -> []
    expect(handleListPlugins(root)).toEqual([])
    // create catalog with two entries
    writeFileSync(join(root, 'catalog.yaml'), ['plugins:', '  example:', '    path: plugin', '    tracking: local', '    maturity: experiment', '  alpha:', '    path: plugins/alpha', '    tracking: submodule', '    repository: org/alpha', '    maturity: stable'].join('\n') + '\n')
    const list = handleListPlugins(root)
    expect(list).toEqual([
      { name: 'alpha', path: 'plugins/alpha', tracking: 'submodule', maturity: 'stable' },
      { name: 'example', path: 'plugin', tracking: 'local', maturity: 'experiment' },
    ])
  })

  it('unknown plugin error lists available catalog names', () => {
    const { root } = mkRootWithPlugin()
    writeFileSync(join(root, 'catalog.yaml'), ['plugins:', '  example:', '    path: plugin', '    tracking: local', '  chat-annotations:', '    path: plugins/chat-annotations', '    tracking: submodule', '    repository: org/chat-annotations'].join('\n') + '\n')
    try {
      handleInspect(root, { plugin: 'nonexistent' })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError)
      const msg = (e as Error).message
      expect(msg).toContain('available:')
      expect(msg).toContain('example')
      expect(msg).toContain('chat-annotations')
    }
    // path-based unknown should NOT enrich
    try {
      handleInspect(root, { path: '/nope/missing' })
      throw new Error('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).not.toContain('available:')
    }
  })

  it('verify PASS publishes and is retrievable via get_evidence (reconnect story)', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const deps = {
      inspectPlugin: vi.fn(() => ({ schemaVersion: 1, plugin: { packageName: '@fixture/demo', sourcePath: pluginPath }, faces: { host: true, client: 'unknown' }, diagnostics: [], ok: true })),
      verifyPackage: vi.fn(() => ({
        tarball: join(root, 'dummy.tgz'),
        steps: [
          { id: 'install', status: 'pass' as const, durationMs: 1 },
          { id: 'typecheck', status: 'pass' as const, durationMs: 1 },
          { id: 'test', status: 'pass' as const, durationMs: 1 },
          { id: 'build', status: 'pass' as const, durationMs: 1 },
          { id: 'pack', status: 'pass' as const, durationMs: 1 },
          { id: 'pack-smoke', status: 'pass' as const, durationMs: 1 },
        ],
      })),
      verifyTarget: vi.fn(async () => {}),
      createRunId: vi.fn(() => 'verify-20260823-0001'),
      now: vi.fn(() => new Date('2026-08-23T10:00:00.000Z')),
    }
    const result = await handleVerify(root, { path: pluginPath, target: 'next' }, deps)
    expect(result.result).toBe('pass')
    expect(result.cleanup).toBe('pass')
    expect(result.runId).toBe('verify-20260823-0001')
    // persisted
    const runs = loadRunResults({ runsRoot: join(root, '.lab', 'runs'), pluginKey: pluginEvidenceKey({ packageName: '@fixture/demo', sourcePath: pluginPath }) })
    expect(runs.some(r => r.runId === 'verify-20260823-0001')).toBe(true)
    // fresh handler (reconnect) via get_evidence
    const evidence = handleGetEvidence(root, { path: pluginPath, kind: 'verify', limit: 5 })
    expect(evidence.verify.some(r => r.runId === 'verify-20260823-0001')).toBe(true)
    expect(evidence.verify[0]!.result).toBe('pass')
  })

  it('verify FAIL with coded step is successful tool call (not isError)', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const codedSteps = [
      { id: 'install', status: 'pass' as const, durationMs: 1 },
      { id: 'build', status: 'fail' as const, durationMs: 2, summary: 'build failed', code: 'pnpm.build.fail' as const, detail: 'stderr tail' },
    ]
    const failure = Object.assign(new Error('package failed'), { steps: codedSteps })
    const deps = {
      inspectPlugin: vi.fn(() => ({ schemaVersion: 1, plugin: { packageName: '@fixture/demo', sourcePath: pluginPath }, faces: { host: true, client: 'unknown' }, diagnostics: [], ok: true })),
      verifyPackage: vi.fn(() => { throw failure }),
      verifyTarget: vi.fn(async () => {}),
      createRunId: vi.fn(() => 'verify-fail-0001'),
      now: vi.fn(() => new Date('2026-08-23T10:00:01.000Z')),
    }
    const result = await handleVerify(root, { path: pluginPath, target: 'next' }, deps)
    expect(result.result).toBe('fail')
    expect(result.steps.some(s => (s as any).code === 'pnpm.build.fail')).toBe(true)
    expect(result.steps.find(s => s.id === 'build')?.status).toBe('fail')
  })

  it('verify INVALID_TARGET when plugin declares no targets and no target arg', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    // overwrite plugin.yaml to have no targets
    writeFileSync(join(pluginPath, '.dsh-lab', 'plugin.yaml'), 'name: demo\ntracking: local\nmaturity: experiment\n')
    await expect(handleVerify(root, { path: pluginPath }, {})).rejects.toMatchObject({ code: 'INVALID_TARGET' })
    // also with empty targets array
    writeFileSync(join(pluginPath, '.dsh-lab', 'plugin.yaml'), 'name: demo\ntracking: local\nmaturity: experiment\ntargets: []\n')
    await expect(handleVerify(root, { path: pluginPath }, {})).rejects.toMatchObject({ code: 'INVALID_TARGET' })
  })

  it('handler errors map to ToolError codes', () => {
    const { root } = mkRootWithPlugin()
    try {
      handleInspect(root, { plugin: 'nonexistent' })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError)
      expect((e as ToolError).code).toBe('UNKNOWN_PLUGIN')
    }
    try {
      handleStatus(root, { path: '/nonexistent/path/xyz' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as ToolError).code).toBe('UNKNOWN_PLUGIN')
    }
  })
})
