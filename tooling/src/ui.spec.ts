import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
import { resolveTsxLoader } from './run.js'
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
    writeSession: vi.fn(opts => writeUiSession(opts)),
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
          updatedAt: state.startedAt,
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
    const stopping = compactForCleanup(state, 'stopping')
    writeUiSession({ runtimeRoot: runtimeRoot(current.root), state: stopping })
    if (action === 'abort') {
      writeUiSession({
        runtimeRoot: runtimeRoot(current.root),
        state: { ...stopping, state: 'aborted', updatedAt: '2026-08-24T12:00:04.000Z' },
      })
    }
    clearUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId })
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
    const binIndex = plan.args.findIndex(arg => /^ui-supervisor-bin\.(?:m?js|ts)$/.test(basename(arg)))
    expect(binIndex).toBeGreaterThanOrEqual(0)
    expect(plan.args.at(-1)).toBe(requestPath)
    if (plan.args[binIndex]!.endsWith('.ts')) {
      expect(plan.args.slice(0, binIndex)).toEqual(['--import', resolveTsxLoader()])
    } else {
      expect(plan.args).toHaveLength(2)
    }
    expect(plan.options).toEqual({ detached: true, shell: false, stdio: 'ignore', windowsHide: true })
  })
})

describe('startUiSession', () => {
  it('retains the directory created exclusively before any service-side claim can adopt a replacement', async () => {
    const current = fixture()
    const bundle = readyStartDependencies(current)
    let replacementDirectory = ''
    let parked = ''
    let replacementState = ''
    const afterSessionCreate = vi.fn((sessionDirectory: string) => {
      replacementDirectory = sessionDirectory
      parked = `${sessionDirectory}.parked`
      replacementState = readFileSync(join(sessionDirectory, 'state.json'), 'utf8')
      renameSync(sessionDirectory, parked)
      mkdirSync(sessionDirectory)
      writeFileSync(join(sessionDirectory, 'state.json'), replacementState)
      writeFileSync(join(sessionDirectory, 'replacement-canary.txt'), 'replacement')
    })
    ;(bundle.deps as UiServiceDependencies & { afterSessionCreate(sessionDirectory: string): void }).afterSessionCreate = afterSessionCreate

    let observed: unknown
    try {
      await startUiSession({ root: current.root, plugin: current.plugin, target: 'next' }, bundle.deps)
    } catch (error) {
      observed = error
    }

    expect(afterSessionCreate).toHaveBeenCalledTimes(1)
    expect(bundle.deps.spawnSupervisor).not.toHaveBeenCalled()
    expect(readFileSync(join(replacementDirectory, 'state.json'), 'utf8')).toBe(replacementState)
    expect(readFileSync(join(replacementDirectory, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(existsSync(join(replacementDirectory, 'request.json'))).toBe(false)
    expect(existsSync(join(parked, 'request.json'))).toBe(false)
    expect(observed).toBeInstanceOf(Error)
    expect((observed as Error).message).toMatch(/identity|changed|swap|ownership|refus/i)
  })

  it('retains the new session identity before publishing request.json', async () => {
    const current = fixture()
    let replacementState = ''
    let replacementDirectory = ''
    let parked = ''
    const beforeRequestWrite = vi.fn((sessionDirectory: string) => {
      replacementDirectory = sessionDirectory
      parked = `${sessionDirectory}.parked`
      replacementState = readFileSync(join(sessionDirectory, 'state.json'), 'utf8')
      renameSync(sessionDirectory, parked)
      mkdirSync(sessionDirectory)
      writeFileSync(join(sessionDirectory, 'state.json'), replacementState)
      writeFileSync(join(sessionDirectory, 'replacement-canary.txt'), 'replacement')
    })
    const bundle = readyStartDependencies(current)
    bundle.deps.beforeRequestWrite = beforeRequestWrite

    await expect(startUiSession({ root: current.root, plugin: current.plugin, target: 'next' }, bundle.deps)).rejects.toThrow(
      /identity|changed|swap|ownership|refus/i,
    )

    expect(beforeRequestWrite).toHaveBeenCalledTimes(1)
    expect(bundle.deps.spawnSupervisor).not.toHaveBeenCalled()
    expect(readFileSync(join(replacementDirectory, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(readFileSync(join(replacementDirectory, 'state.json'), 'utf8')).toBe(replacementState)
    expect(existsSync(join(replacementDirectory, 'request.json'))).toBe(false)
    expect(existsSync(join(parked, 'request.json'))).toBe(false)
  })

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
    expect(bundle.request()!.startedAt).toBe('2026-08-24T12:00:04.000Z')
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
      const stopping = compactForCleanup(state, 'stopping')
      writeUiSession({ runtimeRoot: runtimeRoot(current.root), state: stopping })
      writeUiSession({
        runtimeRoot: runtimeRoot(current.root),
        state: { ...stopping, state: 'aborted', updatedAt: '2026-08-24T12:00:04.000Z' },
      })
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

  it('rejects a forged replacement session that appears ready during an async startup wait', async () => {
    const current = fixture()
    let sessionId = ''
    let replacementState = ''
    let parked = ''
    const bundle = serviceDependencies({
      spawnSupervisor: vi.fn(requestPath => {
        sessionId = (JSON.parse(readFileSync(requestPath, 'utf8')) as { sessionId: string }).sessionId
        return { pid: 7001, unref: vi.fn() }
      }),
      sleep: vi.fn(async () => {
        const directory = join(runtimeRoot(current.root), 'ui-sessions', sessionId)
        parked = `${directory}.parked`
        const owned = readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId })
        const ready: UiSessionStateV1 = {
          ...owned,
          state: 'ready',
          supervisorPid: 9001,
          childPid: 9002,
          url: 'http://127.0.0.1:59999',
          updatedAt: '2026-08-24T12:00:05.000Z',
        }
        replacementState = JSON.stringify(ready, null, 2) + '\n'
        renameSync(directory, parked)
        mkdirSync(directory)
        writeFileSync(join(directory, 'state.json'), replacementState)
        writeFileSync(join(directory, 'replacement-canary.txt'), 'replacement')
      }),
    })

    await expect(startUiSession({ root: current.root, plugin: current.plugin, target: 'next' }, bundle.deps)).rejects.toThrow(
      /identity|changed|swap|ownership|refus/i,
    )

    const replacement = join(runtimeRoot(current.root), 'ui-sessions', sessionId)
    expect(readFileSync(join(replacement, 'state.json'), 'utf8')).toBe(replacementState)
    expect(readFileSync(join(replacement, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(existsSync(join(parked, 'request.json'))).toBe(true)
  })

  it('returns a state that becomes ready exactly at the timeout boundary', async () => {
    const current = fixture()
    let sessionId = ''
    let calls = 0
    const bundle = serviceDependencies({
      spawnSupervisor: vi.fn(requestPath => {
        sessionId = (JSON.parse(readFileSync(requestPath, 'utf8')) as { sessionId: string }).sessionId
        return { pid: 7001, unref: vi.fn() }
      }),
      now: vi.fn(() => {
        calls += 1
        if (calls === 2) {
          const state = readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId })
          writeUiSession({
            runtimeRoot: runtimeRoot(current.root),
            state: {
              ...state,
              state: 'ready',
              supervisorPid: 7001,
              childPid: 7002,
              url: 'http://127.0.0.1:49152',
              updatedAt: '2026-08-24T12:00:00.010Z',
            },
          })
        }
        return `2026-08-24T12:00:00.${String((calls - 1) * 10).padStart(3, '0')}Z`
      }),
      sleep: vi.fn(async () => {}),
    })
    await expect(startUiSession({
      root: current.root,
      plugin: current.plugin,
      target: 'next',
      startupTimeoutMs: 10,
    }, bundle.deps)).resolves.toMatchObject({ state: 'ready', url: 'http://127.0.0.1:49152' })
  })

  it('persists the detached supervisor PID before the first startup wait', async () => {
    const current = fixture()
    let sessionId = ''
    const bundle = serviceDependencies({
      spawnSupervisor: vi.fn(requestPath => {
        sessionId = (JSON.parse(readFileSync(requestPath, 'utf8')) as { sessionId: string }).sessionId
        return { pid: 7001, unref: vi.fn() }
      }),
      sleep: vi.fn(async () => {
        const state = readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId })
        expect(state).toMatchObject({ state: 'starting', supervisorPid: 7001 })
        writeUiSession({
          runtimeRoot: runtimeRoot(current.root),
          state: {
            ...state,
            state: 'crashed',
            error: 'fixture startup stopped',
            updatedAt: '2026-08-24T12:00:01.000Z',
          },
        })
      }),
    })

    await expect(startUiSession({ root: current.root, plugin: current.plugin, target: 'next' }, bundle.deps)).resolves.toMatchObject({
      state: 'crashed',
    })
  })

  it('records a visible cleanup failure when the detached supervisor cannot be spawned', async () => {
    const current = fixture()
    const bundle = serviceDependencies({
      spawnSupervisor: vi.fn(() => { throw new Error('injected spawn failure') }),
    })
    await expect(startUiSession({ root: current.root, plugin: current.plugin, target: 'next' }, bundle.deps)).rejects.toThrow(/spawn failure/i)
    const sessions = readdirSync(join(runtimeRoot(current.root), 'ui-sessions'))
    expect(sessions).toHaveLength(1)
    expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: sessions[0]! })).toMatchObject({
      state: 'crashed',
      cleanup: 'fail',
    })
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

  it('does not latch status drift into a same-name replacement session directory', () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    writeFileSync(join(current.sourcePath, 'src', 'index.ts'), 'export const uiService = "changed"\n')
    const sessionDir = join(runtimeRoot(current.root), 'ui-sessions', SESSION)
    const parked = `${sessionDir}.parked`
    const replacementState = readFileSync(join(sessionDir, 'state.json'))
    let swapped = false
    let observed: unknown

    try {
      getUiSessionStatus({ root: current.root, sessionId: SESSION }, {
        now: () => {
          if (!swapped) {
            swapped = true
            renameSync(sessionDir, parked)
            mkdirSync(sessionDir)
            writeFileSync(join(sessionDir, 'state.json'), replacementState)
            writeFileSync(join(sessionDir, 'replacement-canary.txt'), 'replacement')
          }
          return '2026-08-24T12:00:04.000Z'
        },
        processAlive: vi.fn(() => true),
      })
    } catch (error) {
      observed = error
    }

    expect(readFileSync(join(sessionDir, 'state.json'))).toEqual(replacementState)
    expect(readFileSync(join(sessionDir, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(observed).toBeInstanceOf(Error)
    expect((observed as Error).message).toMatch(/identity|changed|swap|refus/i)
  })

  it.each([
    ['plugin-changed', (current: ReturnType<typeof fixture>) => rmSync(current.sourcePath, { recursive: true, force: true })],
    ['context-changed', (current: ReturnType<typeof fixture>) => rmSync(join(current.root, 'context', 'testing-policy.md'))],
    ['target-changed', (current: ReturnType<typeof fixture>) => writeFileSync(
      join(current.root, 'workbench', 'compatibility.yaml'),
      `targets:\n  master:\n    repository: deepseek-ai/deepseek-harness\n    commit: ${MASTER}\n    pnpm: 11.7.0\n    node: ^22.19.0\n`,
    )],
  ] as const)('classifies missing current identity input as typed %s drift', (reason, removeCurrentInput) => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    removeCurrentInput(current)

    const view = getUiSessionStatus({ root: current.root, sessionId: SESSION }, serviceDependencies().deps)

    expect(view).toMatchObject({ stale: true, staleReasons: [reason] })
    expect(view).not.toHaveProperty('url')
    expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION }).staleReasons).toContain(reason)
  })

  it('does not classify EPERM from the default process probe as a dead owner', () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    vi.spyOn(process, 'kill').mockImplementation(() => { throw denied })

    expect(() => getUiSessionStatus({ root: current.root, sessionId: SESSION })).toThrow(/EPERM|permitted|inspect|process/i)
    expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION }).state).toBe('ready')
  })

  it('keeps a corrupt compatibility manifest as a tooling error instead of target drift', () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const statePath = join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json')
    const before = readFileSync(statePath)
    writeFileSync(join(current.root, 'workbench', 'compatibility.yaml'), 'targets: [broken\n')

    expect(() => getUiSessionStatus({ root: current.root, sessionId: SESSION }, serviceDependencies().deps)).toThrow(
      /compatibility|manifest|yaml|parse|mapping|sequence/i,
    )
    expect(readFileSync(statePath)).toEqual(before)
  })

  it('keeps plugin inspection failures distinct from ordinary plugin disappearance', () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const parked = `${current.sourcePath}.parked`
    const statePath = join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json')
    const before = readFileSync(statePath)
    renameSync(current.sourcePath, parked)
    writeFileSync(current.sourcePath, 'not a plugin directory')

    expect(() => getUiSessionStatus({ root: current.root, sessionId: SESSION }, serviceDependencies().deps)).toThrow(
      /plugin|directory|inspect|notdir|invalid|unsafe/i,
    )
    expect(readFileSync(statePath)).toEqual(before)
  })

  it('does not stale a next session when only the unselected master target is absent', () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    writeFileSync(join(current.root, 'workbench', 'compatibility.yaml'), [
      'targets:',
      '  next:',
      `    dsh: ${NEXT}`,
      '    cordis: 4.0.1',
      '    node: 22.20.0',
      '    pnpm: 11.7.0',
      '',
    ].join('\n'))

    const view = getUiSessionStatus({ root: current.root, sessionId: SESSION }, serviceDependencies().deps)

    expect(view).toMatchObject({ state: 'ready', stale: false, staleReasons: [] })
    expect(view.url).toBe('http://127.0.0.1:49152')
    expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION }).staleReasons).toBeUndefined()
  })

  it.each(['next', 'master'] as const)('treats a missing selected %s identity field as typed target drift', async target => {
    const current = fixture()
    const ready = currentState(current, SESSION, 'ready')
    createUiSession({
      runtimeRoot: runtimeRoot(current.root),
      state: target === 'next' ? ready : { ...ready, target: { name: 'master', commit: MASTER } },
    })
    writeFileSync(join(current.root, 'workbench', 'compatibility.yaml'), target === 'next'
      ? [
          'targets:',
          '  next:',
          '    cordis: 4.0.1',
          '    node: 22.20.0',
          '    pnpm: 11.7.0',
          '  master:',
          '    repository: deepseek-ai/deepseek-harness',
          `    commit: ${MASTER}`,
          '    pnpm: 11.7.0',
          '    node: ^22.19.0',
          '',
        ].join('\n')
      : [
          'targets:',
          '  next:',
          `    dsh: ${NEXT}`,
          '    cordis: 4.0.1',
          '    node: 22.20.0',
          '    pnpm: 11.7.0',
          '  master:',
          '    repository: deepseek-ai/deepseek-harness',
          '    pnpm: 11.7.0',
          '    node: ^22.19.0',
          '',
        ].join('\n'))

    const view = getUiSessionStatus({ root: current.root, sessionId: SESSION }, serviceDependencies().deps)
    expect(view).toMatchObject({ stale: true, staleReasons: ['target-changed'] })

    const bundle = serviceDependencies()
    await expect(finishUiSession({
      root: current.root,
      sessionId: SESSION,
      verdict: 'pass',
      summary: 'selected target identity disappeared',
    }, bundle.deps)).rejects.toMatchObject({ name: 'UiProtocolOutcomeError', outcome: 'stale', exitCode: 2 })
    expect(bundle.deps.publishResult).not.toHaveBeenCalled()
  })

  it('keeps a missing selected target toolchain field as a tooling error', () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const statePath = join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json')
    const before = readFileSync(statePath)
    writeFileSync(join(current.root, 'workbench', 'compatibility.yaml'), [
      'targets:',
      '  next:',
      `    dsh: ${NEXT}`,
      '    cordis: 4.0.1',
      '    node: 22.20.0',
      '  master:',
      '    repository: deepseek-ai/deepseek-harness',
      `    commit: ${MASTER}`,
      '    pnpm: 11.7.0',
      '    node: ^22.19.0',
      '',
    ].join('\n'))

    expect(() => getUiSessionStatus({ root: current.root, sessionId: SESSION }, serviceDependencies().deps)).toThrow(
      /next.*mandatory pin field 'pnpm'|pnpm/i,
    )
    expect(readFileSync(statePath)).toEqual(before)
  })

  it('derives an orphaned crash without killing or rewriting a recorded PID', () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const before = readFileSync(join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json'))
    const bundle = serviceDependencies({ processAlive: vi.fn(() => false) })
    const view = getUiSessionStatus({ root: current.root, sessionId: SESSION }, bundle.deps)
    expect(view).toMatchObject({ state: 'crashed', stale: false })
    expect(view.error).toMatch(/orphan|supervisor|not running/i)
    expect(view.error).toContain(join(runtimeRoot(current.root), 'ui-sessions', SESSION))
    expect(view).not.toHaveProperty('url')
    expect(bundle.deps.processAlive).toHaveBeenCalledWith(7001)
    expect(readFileSync(join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json'))).toEqual(before)
  })

  it('checks a starting supervisor owner and reports the exact orphan runtime without rewriting', () => {
    const current = fixture()
    createUiSession({
      runtimeRoot: runtimeRoot(current.root),
      state: { ...currentState(current, SESSION, 'starting'), supervisorPid: 7001 },
    })
    const statePath = join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json')
    const before = readFileSync(statePath)

    const view = getUiSessionStatus({ root: current.root, sessionId: SESSION }, {
      now: () => '2026-08-24T12:00:04.000Z',
      processAlive: vi.fn(() => false),
    })

    expect(view).toMatchObject({ state: 'crashed' })
    expect(view.error).toMatch(/supervisor|orphan|not running/i)
    expect(view.error).toContain(join(runtimeRoot(current.root), 'ui-sessions', SESSION))
    expect(readFileSync(statePath)).toEqual(before)
  })

  it('reports a pidless starting lease as orphaned instead of live', () => {
    const current = fixture()
    createState(current, SESSION, 'starting')
    const statePath = join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json')
    const before = readFileSync(statePath)
    const processAlive = vi.fn(() => true)

    const view = getUiSessionStatus({ root: current.root, sessionId: SESSION }, {
      now: () => '2026-08-24T12:00:04.000Z',
      processAlive,
    })

    expect(view).toMatchObject({ state: 'crashed' })
    expect(view.error).toMatch(/missing|owner|supervisor|orphan/i)
    expect(view.error).toContain(join(runtimeRoot(current.root), 'ui-sessions', SESSION))
    expect(processAlive).not.toHaveBeenCalled()
    expect(readFileSync(statePath)).toEqual(before)
  })

  it('checks a crashed recovery supervisor and derives an exact orphan path without rewriting', () => {
    const current = fixture()
    createUiSession({
      runtimeRoot: runtimeRoot(current.root),
      state: { ...currentState(current, SESSION, 'crashed'), supervisorPid: 7001 },
    })
    const statePath = join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json')
    const before = readFileSync(statePath)
    const processAlive = vi.fn(() => false)

    const view = getUiSessionStatus({ root: current.root, sessionId: SESSION }, {
      now: () => '2026-08-24T12:00:04.000Z',
      processAlive,
    })

    expect(view).toMatchObject({ state: 'crashed' })
    expect(view.error).toMatch(/recovery|supervisor|orphan|not running/i)
    expect(view.error).toContain(join(runtimeRoot(current.root), 'ui-sessions', SESSION))
    expect(processAlive).toHaveBeenCalledWith(7001)
    expect(readFileSync(statePath)).toEqual(before)
  })

  it('derives current drift for immutable terminal status without rewriting history', () => {
    const current = fixture()
    createState(current, SESSION, 'finished')
    const statePath = join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json')
    const before = readFileSync(statePath)
    writeFileSync(join(current.sourcePath, 'src', 'index.ts'), 'export const uiService = "changed after finish"\n')

    expect(getUiSessionStatus({ root: current.root, sessionId: SESSION }, serviceDependencies().deps)).toMatchObject({
      state: 'finished',
      stale: true,
      staleReasons: ['plugin-changed'],
    })
    expect(readFileSync(statePath)).toEqual(before)
  })

  it('does not expose a ready URL when either recorded process is no longer live', () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const processAlive = vi.fn((pid: number) => pid === 7001)
    const view = getUiSessionStatus({ root: current.root, sessionId: SESSION }, {
      now: () => '2026-08-24T12:00:04.000Z',
      processAlive,
    })
    expect(processAlive.mock.calls).toEqual([[7001], [7002]])
    expect(view).toMatchObject({ state: 'crashed' })
    expect(view.error).toMatch(/child|not running|orphan/i)
    expect(view).not.toHaveProperty('url')
  })

  it('compares target identity structurally instead of by JSON key order', () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const statePath = join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json')
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
    persisted.target = { dsh: NEXT, name: 'next' }
    writeFileSync(statePath, `${JSON.stringify(persisted, null, 2)}\n`)
    expect(getUiSessionStatus({ root: current.root, sessionId: SESSION }, serviceDependencies().deps)).toMatchObject({
      state: 'ready',
      stale: false,
      staleReasons: [],
      url: 'http://127.0.0.1:49152',
    })
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
  it('rejects a replacement session that forges cleaned stopping state during finish wait', async () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const directory = join(runtimeRoot(current.root), 'ui-sessions', SESSION)
    const parked = `${directory}.parked`
    let replacementState = ''
    const bundle = serviceDependencies({
      sleep: vi.fn(async () => {
        const owned = readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })
        const replacement = compactForCleanup(owned, 'stopping')
        replacementState = JSON.stringify(replacement, null, 2) + '\n'
        renameSync(directory, parked)
        mkdirSync(directory)
        writeFileSync(join(directory, 'state.json'), replacementState)
        writeFileSync(join(directory, 'replacement-canary.txt'), 'replacement')
      }),
    })

    await expect(finishUiSession({
      root: current.root,
      sessionId: SESSION,
      verdict: 'pass',
      summary: 'replacement must not publish',
    }, bundle.deps)).rejects.toThrow(/identity|changed|swap|ownership|refus/i)

    expect(bundle.deps.publishResult).not.toHaveBeenCalled()
    expect(readFileSync(join(directory, 'state.json'), 'utf8')).toBe(replacementState)
    expect(readFileSync(join(directory, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(existsSync(join(parked, 'control.json'))).toBe(true)
  })

  it.each(['pass', 'fail'] as const)('publishes %s only after supervisor cleanup and compacts the finished lease', async verdict => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const bundle = serviceDependencies({ sleep: cleanupResponder(current, SESSION, 'finish') })
    bundle.deps.publishResult = vi.fn(opts => {
      expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })).toMatchObject({
        state: 'stopping', cleanup: 'pass',
      })
      expect(readUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })).toBeUndefined()
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
    await expect(finishUiSession({ root: current.root, sessionId: SESSION, verdict: 'pass', summary: 'looks good' }, bundle.deps)).rejects.toMatchObject({
      name: 'UiProtocolOutcomeError',
      outcome: 'stale',
      exitCode: 2,
    })
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

  it('rejects a competing finish that did not own the cleanup control', async () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    let releaseFirst!: () => void
    let sleepEntered!: () => void
    let released = false
    const entered = new Promise<void>(resolve => { sleepEntered = resolve })
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    const firstBundle = serviceDependencies({
      now: vi.fn(() => released ? '2026-08-24T12:03:00.000Z' : '2026-08-24T12:00:04.000Z'),
      sleep: vi.fn(async () => {
        const control = readUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })
        if (control?.action !== 'finish') return
        const state = readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })
        writeFileSync(
          join(runtimeRoot(current.root), 'ui-sessions', SESSION, 'state.json'),
          `${JSON.stringify({ ...state, state: 'stopping', updatedAt: '2026-08-24T12:00:02.000Z' }, null, 2)}\n`,
        )
        sleepEntered()
        await gate
        writeUiSession({ runtimeRoot: runtimeRoot(current.root), state: compactForCleanup(state, 'stopping') })
        clearUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })
      }),
    })
    const first = finishUiSession({ root: current.root, sessionId: SESSION, verdict: 'pass', summary: 'first owner' }, firstBundle.deps)
    void first.catch(() => undefined)
    await entered
    const competitor = serviceDependencies()
    const competing = await finishUiSession({
      root: current.root,
      sessionId: SESSION,
      verdict: 'fail',
      summary: 'competing finisher',
    }, competitor.deps).then(
      value => ({ status: 'resolved' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    )
    released = true
    releaseFirst()
    const original = await first.then(
      value => ({ status: 'resolved' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    )
    expect(competing.status).toBe('rejected')
    if (competing.status === 'rejected') expect(competing.error).toMatchObject({ message: expect.stringMatching(/stopping|owner|phase|ready|crashed/i) })
    expect(competitor.deps.publishResult).not.toHaveBeenCalled()
    expect(original).toMatchObject({ status: 'resolved', value: { verdict: 'pass', summary: 'first owner' } })
  })

  it('returns committed immutable evidence even if terminal lease compaction fails afterward', async () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const bundle = serviceDependencies({ sleep: cleanupResponder(current, SESSION, 'finish') })
    bundle.deps.writeSession = vi.fn(opts => {
      if (opts.state.state === 'finished') throw new Error('injected terminal bookkeeping failure')
      writeUiSession(opts)
    })

    const result = await finishUiSession({
      root: current.root,
      sessionId: SESSION,
      verdict: 'pass',
      summary: 'evidence is the commit point',
    }, bundle.deps)

    expect(result).toMatchObject({ verdict: 'pass', summary: 'evidence is the commit point' })
    expect(loadUiResults({
      uiRunsRoot: join(current.root, '.lab', 'ui-runs'),
      pluginKey: pluginEvidenceKey(current.plugin),
    })).toEqual([result])
    expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })).toMatchObject({
      state: 'stopping',
      cleanup: 'pass',
    })
  })

  it('returns committed evidence and leaves a post-publication replacement lease untouched', async () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const directory = join(runtimeRoot(current.root), 'ui-sessions', SESSION)
    const parked = `${directory}.published-parked`
    let replacementState = ''
    const bundle = serviceDependencies({ sleep: cleanupResponder(current, SESSION, 'finish') })
    bundle.deps.publishResult = vi.fn(opts => {
      const path = publishUiResult(opts)
      replacementState = readFileSync(join(directory, 'state.json'), 'utf8')
      renameSync(directory, parked)
      mkdirSync(directory)
      writeFileSync(join(directory, 'state.json'), replacementState)
      writeFileSync(join(directory, 'replacement-canary.txt'), 'replacement')
      return path
    })

    const result = await finishUiSession({
      root: current.root,
      sessionId: SESSION,
      verdict: 'pass',
      summary: 'immutable evidence already committed',
    }, bundle.deps)

    expect(result).toMatchObject({ verdict: 'pass', summary: 'immutable evidence already committed' })
    expect(loadUiResults({
      uiRunsRoot: join(current.root, '.lab', 'ui-runs'),
      pluginKey: pluginEvidenceKey(current.plugin),
    })).toEqual([result])
    expect(readFileSync(join(directory, 'state.json'), 'utf8')).toBe(replacementState)
    expect(readFileSync(join(directory, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
  })

  it.each([
    ['plugin-changed', (current: ReturnType<typeof fixture>) => rmSync(current.sourcePath, { recursive: true, force: true })],
    ['context-changed', (current: ReturnType<typeof fixture>) => rmSync(join(current.root, 'context', 'testing-policy.md'))],
    ['target-changed', (current: ReturnType<typeof fixture>) => writeFileSync(
      join(current.root, 'workbench', 'compatibility.yaml'),
      `targets:\n  master:\n    repository: deepseek-ai/deepseek-harness\n    commit: ${MASTER}\n    pnpm: 11.7.0\n    node: ^22.19.0\n`,
    )],
  ] as const)('returns typed stale outcome before finish when current %s input is missing', async (reason, removeCurrentInput) => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    removeCurrentInput(current)
    const bundle = serviceDependencies()

    await expect(finishUiSession({
      root: current.root,
      sessionId: SESSION,
      verdict: 'pass',
      summary: 'missing current input',
    }, bundle.deps)).rejects.toMatchObject({
      name: 'UiProtocolOutcomeError',
      outcome: 'stale',
      exitCode: 2,
    })
    expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION }).staleReasons).toContain(reason)
    expect(readUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })).toBeUndefined()
    expect(bundle.deps.publishResult).not.toHaveBeenCalled()
  })

  it('rechecks identity after cleanup and before immutable publication', async () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const bundle = serviceDependencies({
      sleep: vi.fn(async () => {
        const control = readUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })
        if (control?.action !== 'finish') return
        writeFileSync(join(current.sourcePath, 'src', 'index.ts'), 'export const uiService = "changed during cleanup"\n')
        const state = readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })
        clearUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })
        writeUiSession({ runtimeRoot: runtimeRoot(current.root), state: compactForCleanup(state, 'stopping') })
      }),
    })
    await expect(finishUiSession({
      root: current.root,
      sessionId: SESSION,
      verdict: 'pass',
      summary: 'became stale',
    }, bundle.deps)).rejects.toThrow(/stale|changed/i)
    expect(bundle.deps.publishResult).not.toHaveBeenCalled()
    expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION }).staleReasons).toContain('plugin-changed')
  })

  it('rechecks current identity inside the immutable evidence publication boundary', async () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const bundle = serviceDependencies({ sleep: cleanupResponder(current, SESSION, 'finish') })
    bundle.deps.publishResult = vi.fn(opts => {
      writeFileSync(join(current.sourcePath, 'src', 'index.ts'), 'export const uiService = "changed at commit boundary"\n')
      return publishUiResult(opts)
    })

    await expect(finishUiSession({
      root: current.root,
      sessionId: SESSION,
      verdict: 'pass',
      summary: 'commit boundary must remain factual',
    }, bundle.deps)).rejects.toMatchObject({ name: 'UiProtocolOutcomeError', outcome: 'stale', exitCode: 2 })

    expect(loadUiResults({
      uiRunsRoot: join(current.root, '.lab', 'ui-runs'),
      pluginKey: pluginEvidenceKey(current.plugin),
    })).toEqual([])
    expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION }).staleReasons).toContain('plugin-changed')
  })
})

describe('abortUiSession', () => {
  it('rejects a replacement session that forges aborted state during cleanup wait', async () => {
    const current = fixture()
    createState(current, SESSION, 'ready')
    const directory = join(runtimeRoot(current.root), 'ui-sessions', SESSION)
    const parked = `${directory}.parked`
    let replacementState = ''
    const bundle = serviceDependencies({
      sleep: vi.fn(async () => {
        const owned = readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })
        const replacement = compactForCleanup(owned, 'aborted')
        replacementState = JSON.stringify(replacement, null, 2) + '\n'
        renameSync(directory, parked)
        mkdirSync(directory)
        writeFileSync(join(directory, 'state.json'), replacementState)
        writeFileSync(join(directory, 'replacement-canary.txt'), 'replacement')
      }),
    })

    await expect(abortUiSession({ root: current.root, sessionId: SESSION }, bundle.deps)).rejects.toThrow(
      /identity|changed|swap|ownership|refus/i,
    )

    expect(readFileSync(join(directory, 'state.json'), 'utf8')).toBe(replacementState)
    expect(readFileSync(join(directory, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(existsSync(join(parked, 'control.json'))).toBe(true)
    expect(bundle.deps.publishResult).not.toHaveBeenCalled()
  })

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
    }, bundle.deps)).rejects.toMatchObject({
      name: 'UiProtocolOutcomeError',
      outcome: 'cleanup-incomplete',
      exitCode: 2,
    })
    expect(readUiSession({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION }).state).toBe('ready')
    expect(readUiControl({ runtimeRoot: runtimeRoot(current.root), sessionId: SESSION })).toMatchObject({ action: 'abort' })
  })
})
