import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspectPlugin } from '../inspect.js'
import { derivePluginStatus, computeContextDigest } from '../status.js'
import { doctor } from '../doctor.js'
import { pluginEvidenceKey, publishRunResult, type VerifyRunResultV1 } from '../evidence.js'
import { publishUiResult, type UiResultV1 } from '../ui-evidence.js'
import { computePluginDigest } from '../plugin-snapshot.js'
import { handleInspect, handleStatus, handleDoctor, handleGetEvidence, handleListPlugins, handleUiAbort, handleUiFinish, handleUiStart, handleUiStatus, handleVerify, ToolError } from './handlers.js'
import { loadRunResults } from '../evidence.js'
import { resolvePluginRef } from '../plugin-ref.js'
import { clearUiControl, createUiSession, readUiControl, readUiSession, writeUiSession, type UiSessionPhase, type UiSessionStateV1 } from '../ui-session.js'
import type { UiServiceDependencies } from '../ui.js'

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
        types: 'lib/index.d.ts',
        exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' } },
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

const UI_SESSION = 'ui-20260824T120000000Z-a1b2c3d4'
const UI_OTHER = 'ui-20260824T120000000Z-deadbeef'
const UI_NOW = '2026-08-24T12:00:04.000Z'

function uiRuntimeRoot(root: string): string {
  return join(root, '.lab', 'runtime')
}

function uiState(root: string, pluginPath: string, sessionId: string, phase: UiSessionPhase): UiSessionStateV1 {
  const base: UiSessionStateV1 = {
    schemaVersion: 1,
    sessionId,
    state: phase,
    plugin: { packageName: '@fixture/demo', sourcePath: pluginPath, digest: computePluginDigest(pluginPath).digest },
    target: { name: 'next', dsh: NEXT },
    contextDigest: computeContextDigest(root),
    startedAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:00.000Z',
  }
  if (phase === 'ready') return { ...base, supervisorPid: 7001, childPid: 7002, url: 'http://127.0.0.1:49152' }
  if (phase === 'crashed') return { ...base, error: 'fixture child crashed' }
  if (phase === 'finished' || phase === 'aborted' || phase === 'stopping') return { ...base, cleanup: 'pass' }
  return base
}

function createUiState(root: string, pluginPath: string, sessionId: string, phase: UiSessionPhase): void {
  createUiSession({ runtimeRoot: uiRuntimeRoot(root), state: uiState(root, pluginPath, sessionId, phase) })
}

function uiServiceDependencies(overrides: Partial<UiServiceDependencies> = {}): { deps: UiServiceDependencies; unref: () => void } {
  const unref = vi.fn()
  const deps: UiServiceDependencies = {
    spawnSupervisor: vi.fn(() => ({ pid: 7001, unref })),
    sleep: vi.fn(async () => {}),
    now: vi.fn(() => UI_NOW),
    processAlive: vi.fn(() => true),
    publishResult: vi.fn(opts => publishUiResult(opts)),
    writeSession: vi.fn(opts => writeUiSession(opts)),
    ...overrides,
  }
  return { deps, unref }
}

function readyStartDependencies(root: string): { deps: UiServiceDependencies; unref: () => void } {
  const unref = vi.fn()
  const bundle = uiServiceDependencies({
    spawnSupervisor: vi.fn(requestPath => {
      const request = JSON.parse(readFileSync(requestPath, 'utf8')) as { sessionId: string }
      const runtimeRoot = uiRuntimeRoot(root)
      const state = readUiSession({ runtimeRoot, sessionId: request.sessionId })
      writeUiSession({
        runtimeRoot,
        state: { ...state, state: 'ready', supervisorPid: 7001, childPid: 7002, url: 'http://127.0.0.1:49152', updatedAt: state.startedAt },
      })
      return { pid: 7001, unref }
    }),
  })
  return { deps: bundle.deps, unref }
}

function cleanupResponder(root: string, sessionId: string, action: 'finish' | 'abort') {
  return vi.fn(async () => {
    const runtimeRoot = uiRuntimeRoot(root)
    const control = readUiControl({ runtimeRoot, sessionId })
    if (control?.action !== action) return
    const state = readUiSession({ runtimeRoot, sessionId })
    const { supervisorPid: _supervisorPid, childPid: _childPid, url: _url, error: _error, ...base } = state
    const stopping: UiSessionStateV1 = { ...base, state: 'stopping', cleanup: 'pass', updatedAt: '2026-08-24T12:00:03.000Z' }
    writeUiSession({ runtimeRoot, state: stopping })
    if (action === 'abort') {
      writeUiSession({ runtimeRoot, state: { ...stopping, state: 'aborted', updatedAt: UI_NOW } })
    }
    clearUiControl({ runtimeRoot, sessionId })
  })
}

describe('mcp UI handlers', () => {
  it('ui_start reaches a ready view with url and parity fields via injected deps', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const bundle = readyStartDependencies(root)
    const view = await handleUiStart(root, { path: pluginPath, target: 'next' }, bundle.deps)
    expect(view).toMatchObject({
      schemaVersion: 1,
      state: 'ready',
      stale: false,
      staleReasons: [],
      url: 'http://127.0.0.1:49152',
      plugin: { packageName: '@fixture/demo', sourcePath: resolve(pluginPath) },
      target: { name: 'next', dsh: NEXT },
    })
    expect(view.sessionId).toMatch(/^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$/)
    expect(view.contextDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(bundle.unref).toHaveBeenCalledTimes(1)
  })

  it('rejects a malformed sessionId as INVALID_SELECTOR before any fs work', async () => {
    const { root } = mkRootWithPlugin()
    const now = vi.fn()
    const processAlive = vi.fn()
    expect(() => handleUiStatus(root, { sessionId: '../escape' }, { now, processAlive })).toThrowError(expect.objectContaining({ code: 'INVALID_SELECTOR' }))
    await expect(handleUiFinish(root, { sessionId: 'ui-not-valid', verdict: 'pass', summary: 'x' }, {})).rejects.toMatchObject({ code: 'INVALID_SELECTOR' })
    await expect(handleUiAbort(root, { sessionId: '..\\escape' }, {})).rejects.toMatchObject({ code: 'INVALID_SELECTOR' })
    expect(now).not.toHaveBeenCalled()
    expect(processAlive).not.toHaveBeenCalled()
    expect(existsSync(join(root, '.lab'))).toBe(false)
  })

  it('ui_status maps a fixture state to a view and surfaces UI_NOT_FOUND for a missing id', () => {
    const { root, pluginPath } = mkRootWithPlugin()
    createUiState(root, pluginPath, UI_SESSION, 'ready')
    const deps = { now: vi.fn(() => UI_NOW), processAlive: vi.fn(() => true) }
    const view = handleUiStatus(root, { sessionId: UI_SESSION }, deps)
    expect(view).toMatchObject({
      sessionId: UI_SESSION,
      state: 'ready',
      stale: false,
      staleReasons: [],
      url: 'http://127.0.0.1:49152',
      plugin: { packageName: '@fixture/demo' },
      target: { name: 'next', dsh: NEXT },
    })
    expect(() => handleUiStatus(root, { sessionId: UI_OTHER }, deps)).toThrowError(expect.objectContaining({ code: 'UI_NOT_FOUND' }))
  })

  it('ui_status returns an orphan view normally when the supervisor is gone', () => {
    const { root, pluginPath } = mkRootWithPlugin()
    createUiState(root, pluginPath, UI_SESSION, 'ready')
    const deps = { now: vi.fn(() => UI_NOW), processAlive: vi.fn(() => false) }
    const view = handleUiStatus(root, { sessionId: UI_SESSION }, deps)
    expect(view).toMatchObject({ state: 'crashed', orphan: true })
    expect(view.error).toMatch(/orphan|supervisor|not running/i)
    expect(deps.processAlive).toHaveBeenCalledWith(7001)
  })

  it('ui_finish returns a UiResultV1 with parity fields', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    createUiState(root, pluginPath, UI_SESSION, 'ready')
    const bundle = uiServiceDependencies({ sleep: cleanupResponder(root, UI_SESSION, 'finish') })
    const result = await handleUiFinish(root, { sessionId: UI_SESSION, verdict: 'pass', summary: 'looks good' }, bundle.deps)
    expect(result).toMatchObject({
      schemaVersion: 1,
      sessionId: UI_SESSION,
      operation: 'ui',
      verdict: 'pass',
      summary: 'looks good',
      cleanup: 'pass',
      plugin: { packageName: '@fixture/demo', sourcePath: resolve(pluginPath) },
      target: { name: 'next', dsh: NEXT },
    })
    expect(result.lab.contextDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(bundle.deps.publishResult).toHaveBeenCalledTimes(1)
  })

  it('ui_finish rejects summary over 500 code points as INVALID_SUMMARY', async () => {
    const { root } = mkRootWithPlugin()
    await expect(handleUiFinish(root, { sessionId: UI_SESSION, verdict: 'pass', summary: 'x'.repeat(501) }, {})).rejects.toMatchObject({ code: 'INVALID_SUMMARY' })
  })

  it('maps UiProtocolOutcomeError stale to UI_STALE', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    createUiState(root, pluginPath, UI_SESSION, 'ready')
    const runtimeRoot = uiRuntimeRoot(root)
    const state = readUiSession({ runtimeRoot, sessionId: UI_SESSION })
    writeUiSession({ runtimeRoot, state: { ...state, staleReasons: ['plugin-changed'] } })
    const bundle = uiServiceDependencies()
    await expect(handleUiFinish(root, { sessionId: UI_SESSION, verdict: 'pass', summary: 'x' }, bundle.deps)).rejects.toMatchObject({
      code: 'UI_STALE',
      message: expect.stringMatching(/stale|plugin-changed/i),
    })
    expect(bundle.deps.publishResult).not.toHaveBeenCalled()
  })

  it('maps UiProtocolOutcomeError cleanup-incomplete to UI_CLEANUP_INCOMPLETE', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    createUiState(root, pluginPath, UI_SESSION, 'crashed')
    const runtimeRoot = uiRuntimeRoot(root)
    const state = readUiSession({ runtimeRoot, sessionId: UI_SESSION })
    writeUiSession({ runtimeRoot, state: { ...state, state: 'crashed', cleanup: 'fail' } })
    await expect(handleUiAbort(root, { sessionId: UI_SESSION }, {})).rejects.toMatchObject({ code: 'UI_CLEANUP_INCOMPLETE' })
  })

  it('ui_abort passes a terminal view through as a normal result', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    createUiState(root, pluginPath, UI_SESSION, 'aborted')
    const view = await handleUiAbort(root, { sessionId: UI_SESSION }, {})
    expect(view).toMatchObject({ sessionId: UI_SESSION, state: 'aborted', cleanup: 'pass' })
  })
})
