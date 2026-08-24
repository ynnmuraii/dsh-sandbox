import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginEvidenceKey } from './evidence.js'
import type { PluginRef } from './plugin-ref.js'
import { computePluginDigest } from './plugin-snapshot.js'
import {
  clearUiControl,
  createUiSession,
  readUiControl,
  readUiSession,
  writeUiSession,
  type UiSessionPhase,
  type UiSessionStateV1,
} from './ui-session.js'
import { loadUiResults, publishUiResult } from './ui-evidence.js'
import { computeContextDigest } from './status.js'
import {
  abortUiSession,
  buildUiSupervisorSpawn,
  finishUiSession,
  getUiSessionStatus,
  startUiSession,
  type UiServiceDependencies,
} from './ui.js'

const roots: string[] = []
const NEXT = '0.1.1-rc.2'
const MASTER = '1'.repeat(40)
const SESSION = 'ui-20260824T120000000Z-a1b2c3d4'
const OTHER = 'ui-20260824T120000000Z-deadbeef'

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; plugin: PluginRef; sourcePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lab-ui-service-'))
  roots.push(root)
  const sourcePath = join(root, 'external-plugin')
  mkdirSync(join(sourcePath, 'src'), { recursive: true })
  mkdirSync(join(sourcePath, '.dsh-lab'), { recursive: true })
  mkdirSync(join(root, 'workbench'), { recursive: true })
  mkdirSync(join(root, 'context'), { recursive: true })
  writeCompatibility(root)
  writeFileSync(join(root, 'context', 'harness-contracts.md'), '# Harness\npublic APIs only\n')
  writeFileSync(join(root, 'context', 'testing-policy.md'), '# Testing\nverify facts\n')
  writeFileSync(join(sourcePath, 'package.json'), `${JSON.stringify({
    name: '@fixture/ui-service',
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
      '@deepseek-ai/dsh-tools': NEXT,
    },
    devDependencies: {
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/dsh-tools': NEXT,
    },
  }, null, 2)}\n`)
  writeFileSync(join(sourcePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(sourcePath, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(sourcePath, 'cordis.patch.yml'), '- insert:\n    - id: ui-service\n      name: "@fixture/ui-service"\n')
  writeFileSync(join(sourcePath, 'src', 'index.ts'), 'export const uiService = true\n')
  writeFileSync(
    join(sourcePath, '.dsh-lab', 'plugin.yaml'),
    'name: ui-service\ntracking: local\nmaturity: experiment\ntargets:\n  - next\n',
  )
  return {
    root,
    sourcePath,
    plugin: {
      sourcePath,
      packageName: '@fixture/ui-service',
      metadata: { name: 'ui-service', tracking: 'local', maturity: 'experiment', targets: ['next'] },
    },
  }
}

function writeCompatibility(root: string, next = NEXT): void {
  writeFileSync(join(root, 'workbench', 'compatibility.yaml'), [
    'targets:',
    '  next:',
    `    dsh: ${next}`,
    '    cordis: 4.0.1',
    '    node: 22.20.0',
    '    pnpm: 11.7.0',
    '  master:',
    '    repository: deepseek-ai/deepseek-harness',
    `    commit: ${MASTER}`,
    '    pnpm: 11.7.0',
    '    node: ^22.19.0',
    '',
  ].join('\n'))
}

function runtimeRoot(root: string): string {
  return join(root, '.lab', 'runtime')
}

function currentState(current: ReturnType<typeof fixture>, sessionId: string, phase: UiSessionPhase): UiSessionStateV1 {
  const base: UiSessionStateV1 = {
    schemaVersion: 1,
    sessionId,
    state: phase,
    plugin: {
      packageName: current.plugin.packageName,
      sourcePath: current.plugin.sourcePath,
      digest: computePluginDigest(current.sourcePath).digest,
    },
    target: { name: 'next', dsh: NEXT },
    contextDigest: computeContextDigest(current.root),
    startedAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:00.000Z',
  }
  if (phase === 'ready') return {
    ...base,
    supervisorPid: 7001,
    childPid: 7002,
    url: 'http://127.0.0.1:49152',
  }
  if (phase === 'crashed') return { ...base, error: 'fixture child crashed' }
  if (phase === 'stopping') return { ...base, cleanup: 'pass' }
  if (phase === 'finished' || phase === 'aborted') return { ...base, cleanup: 'pass' }
  return base
}

function createState(current: ReturnType<typeof fixture>, sessionId: string, phase: UiSessionPhase): void {
  createUiSession({ runtimeRoot: runtimeRoot(current.root), state: currentState(current, sessionId, phase) })
}

function serviceDependencies(overrides: Partial<UiServiceDependencies> = {}) {
  const unref = vi.fn()
  const deps: UiServiceDependencies = {
    spawnSupervisor: vi.fn(() => ({ pid: 7001, unref })),
    sleep: vi.fn(async () => {}),
    now: vi.fn(() => '2026-08-24T12:00:04.000Z'),
    processAlive: vi.fn(() => true),
    publishResult: vi.fn(opts => publishUiResult(opts)),
    ...overrides,
  }
  return { deps, unref }
}

function readyStartDependencies(current: ReturnType<typeof fixture>) {
  const unref = vi.fn()
  let request: Record<string, unknown> | undefined
  const bundle = serviceDependencies({
    spawnSupervisor: vi.fn(requestPath => {
      request = JSON.parse(readFileSync(requestPath, 'utf8')) as Record<string, unknown>
      const sessionId = request.sessionId as string
      const state = readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId })
      writeUiSession({
        runtimeRoot: runtimeRoot(current.root),
        state: {
          ...state,
          state: 'ready',
          supervisorPid: 7001,
          childPid: 7002,
          url: 'http://127.0.0.1:49152',
          updatedAt: '2026-08-24T12:00:01.000Z',
        },
      })
      return { pid: 7001, unref }
    }),
  })
  return { ...bundle, unref, request: () => request }
}

function compactForCleanup(state: UiSessionStateV1, phase: 'stopping' | 'aborted'): UiSessionStateV1 {
  const { supervisorPid: _supervisorPid, childPid: _childPid, url: _url, error: _error, ...base } = state
  return {
    ...base,
    state: phase,
    cleanup: 'pass',
    updatedAt: '2026-08-24T12:00:03.000Z',
  }
}

function cleanupResponder(current: ReturnType<typeof fixture>, sessionId: string, action: 'finish' | 'abort') {
  return vi.fn(async () => {
    const control = readUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId })
    if (control?.action !== action) return
    const state = readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId })
    clearUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId })
    writeUiSession({
      runtimeRoot: runtimeRoot(current.root),
      state: compactForCleanup(state, action === 'finish' ? 'stopping' : 'aborted'),
    })
  })
}

function allFileNames(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort()
}

describe('UI supervisor spawn plan', () => {
  it('uses Node, one supervisor bin and request path, detached without a shell or inherited stdio', () => {
    const requestPath = 'A:/forge/.lab/runtime/ui-sessions/ui-20260824T120000000Z-a1b2c3d4/request.json'
    const plan = buildUiSupervisorSpawn(requestPath)
    expect(plan.command).toBe(process.execPath)
    expect(plan.args).toHaveLength(2)
    expect(basename(plan.args[0]!)).toMatch(/^ui-supervisor-bin\.(?:m?js|ts)$/)
    expect(plan.args[1]).toBe(requestPath)
    expect(plan.options).toEqual({ detached: true, shell: false, stdio: 'ignore', windowsHide: true })
  })
})

describe('startUiSession', () => {
  it('captures exact current identities in an environment-free request and waits for ready', async () => {
    const current = fixture()
    const before = computePluginDigest(current.sourcePath)
    const bundle = readyStartDependencies(current)
    const view = await startUiSession({ root: current.root, plugin: current.plugin, target: 'next' }, bundle.deps)
    expect(view).toMatchObject({
      schemaVersion: 1,
      state: 'ready',
      stale: false,
      staleReasons: [],
      url: 'http://127.0.0.1:49152',
      plugin: { packageName: current.plugin.packageName, sourcePath: current.sourcePath, digest: before.digest },
      target: { name: 'next', dsh: NEXT },
      contextDigest: computeContextDigest(current.root),
    })
    expect(view.sessionId).toMatch(/^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$/)
    expect(Object.keys(bundle.request()!).sort()).toEqual(['plugin', 'root', 'schemaVersion', 'sessionId', 'startedAt', 'target'])
    expect(JSON.stringify(bundle.request())).not.toMatch(/env|secret|token|password/i)
    expect(bundle.unref).toHaveBeenCalledTimes(1)
    expect(bundle.deps.sleep).not.toHaveBeenCalled()
    expect(computePluginDigest(current.sourcePath)).toEqual(before)
  })

  it.each([
    ['missing source entry', (current: ReturnType<typeof fixture>) => rmSync(join(current.sourcePath, 'src', 'index.ts'))],
    ['invalid inspection', (current: ReturnType<typeof fixture>) => rmSync(join(current.sourcePath, 'pnpm-lock.yaml'))],
    ['unsafe runtime identity', (current: ReturnType<typeof fixture>) => { current.plugin.metadata!.name = '../escape' }],
    ['undeclared target', (current: ReturnType<typeof fixture>) => { current.plugin.metadata!.targets = ['master'] }],
  ])('rejects %s before creating or spawning', async (_label, breakFixture) => {
    const current = fixture()
    breakFixture(current)
    const bundle = serviceDependencies()
    await expect(startUiSession({ root: current.root, plugin: current.plugin, target: 'next' }, bundle.deps)).rejects.toThrow()
    expect(bundle.deps.spawnSupervisor).not.toHaveBeenCalled()
    expect(existsSync(join(runtimeRoot(current.root), 'ui-sessions')) ? readdirSync(join(runtimeRoot(current.root), 'ui-sessions')) : []).toEqual([])
  })

  it('requests abort and awaits compact cleanup after its bounded startup timeout', async () => {
    const current = fixture()
    let sessionId = ''
    let tick = 0
    const bundle = serviceDependencies({
      now: vi.fn(() => `2026-08-24T12:00:00.${String(tick++ * 20).padStart(3, '0')}Z`),
      spawnSupervisor: vi.fn(requestPath => {
        sessionId = (JSON.parse(readFileSync(requestPath, 'utf8')) as { sessionId: string }).sessionId
        return { pid: 7001, unref: vi.fn() }
      }),
    })
    bundle.deps.sleep = vi.fn(async () => {
      if (!sessionId) return
      const control = readUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId })
      if (control?.action !== 'abort') return
      const state = readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId })
      clearUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId })
      writeUiSession({ runtimeRoot: runtimeRoot(current.root), state: compactForCleanup(state, 'aborted') })
    })
    await expect(startUiSession({
      root: current.root,
      plugin: current.plugin,
      target: 'next',
      startupTimeoutMs: 10,
    }, bundle.deps)).rejects.toThrow(/timeout|timed out|session/i)
    expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId }).state).toBe('aborted')
    expect(bundle.deps.publishResult).not.toHaveBeenCalled()
  })
})

describe('getUiSessionStatus', () => {
  it('latches plugin, context, and exact target changes monotonically and hides a stale URL', () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const bundle = serviceDependencies()
    writeFileSync(join(current.sourcePath, 'src', 'index.ts'), 'export const uiService = "changed"\n')
    expect(getUiSessionStatus({ root: current.root, sessionId: SESSION }, bundle.deps)).toMatchObject({
      stale: true,
      staleReasons: ['plugin-changed'],
    })
    expect(getUiSessionStatus({ root: current.root, sessionId: SESSION }, bundle.deps)).not.toHaveProperty('url')
    writeFileSync(join(current.root, 'context', 'testing-policy.md'), '# Testing\nchanged\n')
    writeCompatibility(current.root, '0.1.1-rc.3')
    const stale = getUiSessionStatus({ root: current.root, sessionId: SESSION }, bundle.deps)
    expect(stale.staleReasons).toEqual(['context-changed', 'plugin-changed', 'target-changed'])

    writeFileSync(join(current.sourcePath, 'src', 'index.ts'), 'export const uiService = true\n')
    writeFileSync(join(current.root, 'context', 'testing-policy.md'), '# Testing\nverify facts\n')
    writeCompatibility(current.root)
    expect(getUiSessionStatus({ root: current.root, sessionId: SESSION }, bundle.deps).staleReasons).toEqual(
      ['context-changed', 'plugin-changed', 'target-changed'],
    )
  })

  it('derives an orphaned crash without killing or rewriting a recorded PID', () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const before = readFileSync(join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json'))
    const bundle = serviceDependencies({ processAlive: vi.fn(() => false) })
    const view = getUiSessionStatus({ root: current.root, sessionId: SESSION }, bundle.deps)
    expect(view).toMatchObject({ state: 'crashed', stale: false })
    expect(view.error).toMatch(/orphan|supervisor|not running/i)
    expect(view).not.toHaveProperty('url')
    expect(bundle.deps.processAlive).toHaveBeenCalledWith(7001)
    expect(readFileSync(join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json'))).toEqual(before)
  })

  it('rejects unknown and traversal IDs without filesystem mutation', () => {
    const current = fixture()
    const before = allFileNames(current.root)
    for (const sessionId of [OTHER, '../escape', '..\\escape']) {
      expect(() => getUiSessionStatus({ root: current.root, sessionId }, serviceDependencies().deps)).toThrow()
    }
    expect(allFileNames(current.root)).toEqual(before)
  })
})

describe('finishUiSession', () => {
  it.each(['pass', 'fail'] as const)('publishes %s only after supervisor cleanup and compacts the finished lease', async verdict => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const bundle = serviceDependencies({ sleep: cleanupResponder(current, SESSION, 'finish') })
    bundle.deps.publishResult = vi.fn(opts => {
      expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })).toMatchObject({
        state: 'stopping', cleanup: 'pass',
      })
      return publishUiResult(opts)
    })
    const result = await finishUiSession({
      root: current.root,
      sessionId: SESSION,
      verdict,
      summary: '  external vision checked the client surface  ',
    }, bundle.deps)
    expect(result).toEqual({
      schemaVersion: 1,
      sessionId: SESSION,
      operation: 'ui',
      verdict,
      plugin: currentState(current, SESSION, 'ready').plugin,
      target: { name: 'next', dsh: NEXT },
      lab: { contextDigest: computeContextDigest(current.root) },
      summary: 'external vision checked the client surface',
      cleanup: 'pass',
      startedAt: '2026-08-24T12:00:00.000Z',
      finishedAt: '2026-08-24T12:00:04.000Z',
    })
    const terminal = readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })
    expect(terminal).toMatchObject({ state: 'finished', cleanup: 'pass' })
    for (const key of ['url', 'supervisorPid', 'childPid', 'error']) expect(terminal).not.toHaveProperty(key)
    expect(loadUiResults({
      uiRunsRoot: join(current.root, '.lab', 'ui-runs'),
      pluginKey: pluginEvidenceKey(current.plugin),
    })).toEqual([result])
  })

  it('allows fail from crashed but rejects pass before readiness and validates summary before control', async () => {
    const current = fixture()
    createState(current, SESSION, 'starting')
    const bundle = serviceDependencies()
    await expect(finishUiSession({ root: current.root, sessionId: SESSION, verdict: 'pass', summary: 'not ready' }, bundle.deps)).rejects.toThrow(/ready/i)
    await expect(finishUiSession({ root: current.root, sessionId: SESSION, verdict: 'fail', summary: '   ' }, bundle.deps)).rejects.toThrow(/summary|empty/i)
    expect(readUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })).toBeUndefined()

    createState(current, OTHER, 'crashed')
    const crashBundle = serviceDependencies({ sleep: cleanupResponder(current, OTHER, 'finish') })
    await expect(finishUiSession({ root: current.root, sessionId: OTHER, verdict: 'fail', summary: 'child crashed' }, crashBundle.deps)).resolves.toMatchObject({ verdict: 'fail' })
  })

  it('refuses stale finalization without control or evidence', async () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    writeFileSync(join(current.sourcePath, 'src', 'index.ts'), 'export const uiService = "stale"\n')
    const bundle = serviceDependencies()
    await expect(finishUiSession({ root: current.root, sessionId: SESSION, verdict: 'pass', summary: 'looks good' }, bundle.deps)).rejects.toThrow(/stale|changed/i)
    expect(readUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })).toBeUndefined()
    expect(bundle.deps.publishResult).not.toHaveBeenCalled()
    expect(existsSync(join(current.root, '.lab', 'ui-runs'))).toBe(false)
  })

  it('leaves cleaned stopping diagnosable when publication fails or immutable evidence exists', async () => {
    for (const preexisting of [false, true]) {
      const current = fixture()
      createState(current, SESSION, 'ready')
      const captured = currentState(current, SESSION, 'ready')
      if (preexisting) {
        publishUiResult({
          uiRunsRoot: join(current.root, '.lab', 'ui-runs'),
          result: {
            schemaVersion: 1,
            sessionId: SESSION,
            operation: 'ui',
            verdict: 'fail',
            plugin: captured.plugin,
            target: captured.target,
            lab: { contextDigest: captured.contextDigest },
            summary: 'existing result',
            cleanup: 'pass',
            startedAt: captured.startedAt,
            finishedAt: '2026-08-24T12:00:01.000Z',
          },
        })
      }
      const bundle = serviceDependencies({ sleep: cleanupResponder(current, SESSION, 'finish') })
      if (!preexisting) bundle.deps.publishResult = vi.fn(() => { throw new Error('injected publication failure') })
      await expect(finishUiSession({ root: current.root, sessionId: SESSION, verdict: 'pass', summary: 'cannot publish' }, bundle.deps)).rejects.toThrow(/publish|exist|immutable|injected/i)
      expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })).toMatchObject({
        state: 'stopping', cleanup: 'pass',
      })
    }
  })
})

describe('abortUiSession', () => {
  it.each(['starting', 'ready', 'crashed'] as const)('aborts %s without evidence and is idempotent', async phase => {
    const current = fixture()
    createState(current, SESSION, phase)
    const bundle = serviceDependencies({ sleep: cleanupResponder(current, SESSION, 'abort') })
    const aborted = await abortUiSession({ root: current.root, sessionId: SESSION }, bundle.deps)
    expect(aborted).toMatchObject({ state: 'aborted', cleanup: 'pass' })
    expect(bundle.deps.publishResult).not.toHaveBeenCalled()
    expect(existsSync(join(current.root, '.lab', 'ui-runs'))).toBe(false)
    await expect(abortUiSession({ root: current.root, sessionId: SESSION }, bundle.deps)).resolves.toEqual(aborted)
    expect(readUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })).toBeUndefined()
  })

  it('rejects finished and exposes cleanup failure without screenshot-like artifacts', async () => {
    const current = fixture()
    createState(current, SESSION, 'finished')
    const bundle = serviceDependencies()
    await expect(abortUiSession({ root: current.root, sessionId: SESSION }, bundle.deps)).rejects.toThrow(/finished|immutable/i)

    createState(current, OTHER, 'ready')
    const failureBundle = serviceDependencies({
      sleep: vi.fn(async () => {
        const control = readUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId: OTHER })
        if (control?.action !== 'abort') return
        const state = readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: OTHER })
        const { url: _url, ...base } = state
        writeUiSession({
          runtimeRoot: runtimeRoot(current.root),
          state: {
            ...base,
            state: 'crashed',
            error: 'cleanup failed',
            cleanup: 'fail',
            updatedAt: '2026-08-24T12:00:03.000Z',
          },
        })
      }),
    })
    await expect(abortUiSession({ root: current.root, sessionId: OTHER, stopTimeoutMs: 10 }, failureBundle.deps)).rejects.toThrow(/cleanup|fail/i)
    expect(allFileNames(join(current.root, '.lab')).filter(path => /screen|\.png$|\.jpe?g$/i.test(path))).toEqual([])
  })

  it('keeps a timed-out abort visible instead of claiming terminal cleanup', async () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    let tick = 0
    const bundle = serviceDependencies({
      now: vi.fn(() => `2026-08-24T12:00:00.${String(tick++ * 20).padStart(3, '0')}Z`),
      sleep: vi.fn(async () => {}),
    })
    await expect(abortUiSession({
      root: current.root,
      sessionId: SESSION,
      stopTimeoutMs: 10,
    }, bundle.deps)).rejects.toThrow(/timeout|timed out|cleanup/i)
    expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION }).state).toBe('ready')
    expect(readUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })).toMatchObject({ action: 'abort' })
  })
})
