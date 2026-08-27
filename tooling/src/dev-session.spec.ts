import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startDevSession,
  getDevSessionStatus,
  stopDevSession,
  buildDevSupervisorSpawn,
  type DevServiceDependencies,
} from './dev-session.js'
import {
  clearDevControl,
  createOwnedDevSession,
  readDevControl,
  readDevSession,
  writeDevSession,
  type DevSessionPhase,
  type DevSessionStateV1,
} from './dev-session-state.js'
import { aggregateRestartHash, computeDevRestartBaseline, digestString } from './dev-restart-baseline.js'
import { resolveTsxLoader } from './run.js'
import type { PluginRef } from './plugin-ref.js'

const NEXT = '0.1.1-rc.2'
const MASTER = '1'.repeat(40)
const SESSION = 'dev-20260824T120000000Z-a1b2c3d4'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeCompatibility(root: string, next = NEXT): void {
  writeFileSync(join(root, 'workbench', 'compatibility.yaml'), [
    'targets:',
    '  next:',
    `    dsh: ${next}`,
    '    cordis: 4.0.1',
    '    node: 22.20.0',
    '    pnpm: 11.7.0',
    '    allowBuilds:',
    '      esbuild: true',
    '  master:',
    '    repository: deepseek-ai/deepseek-harness',
    `    commit: ${MASTER}`,
    '    pnpm: 11.7.0',
    '    node: ^22.19.0',
    '',
  ].join('\n'))
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dev-session-'))
  roots.push(root)
  mkdirSync(join(root, 'workbench'), { recursive: true })
  writeCompatibility(root)
  const plugin: PluginRef = {
    sourcePath: join(root, 'plugins', 'x'),
    packageName: '@f/x',
    metadata: { name: 'x', tracking: 'local', maturity: 'experiment', targets: ['next'] },
  }
  mkdirSync(join(plugin.sourcePath, 'src'), { recursive: true })
  writeFileSync(join(plugin.sourcePath, 'src', 'index.ts'), 'export const live = true\n')
  writeFileSync(join(plugin.sourcePath, 'package.json'), '{"name":"@f/x","dsh":{"bundle":{"patch":"cordis.patch.yml"}}}\n')
  mkdirSync(join(plugin.sourcePath, '.dsh-lab'), { recursive: true })
  writeFileSync(join(plugin.sourcePath, '.dsh-lab', 'plugin.yaml'), 'name: x\ntracking: local\nmaturity: experiment\ntargets:\n  - next\n')
  return { root, plugin }
}

// The DI mock below simulates the detached supervisor writing a `ready` state
// into the session dir on spawn, so the orchestration poll observes `ready`
// without launching any real dsh/pnpm process.
function readyDeps(f: ReturnType<typeof fixture>): DevServiceDependencies {
  return {
    spawnSupervisor: vi.fn((requestPath: string) => {
      const sessionDir = requestPath.replace(/[\\/]request\.json$/, '')
      const sessionId = sessionDir.split(/[\\/]/).pop()!
      writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({
        schemaVersion: 1, sessionId, state: 'ready',
        plugin: { packageName: f.plugin.packageName, sourcePath: f.plugin.sourcePath, runtimeName: 'x' },
        target: { name: 'next', dsh: NEXT },
        restartBaseline: { pluginManifest: digestString('a'), pluginMetadata: digestString('b'), targetPin: digestString('c') },
        restartHash: digestString('d'), restartRequired: false,
        supervisorPid: 99, childPid: 100, url: 'http://127.0.0.1:49152',
        startedAt: '2026-08-24T12:00:00.000Z', updatedAt: '2026-08-24T12:00:00.000Z',
      }, null, 2) + '\n')
      return { pid: 99, unref: vi.fn() }
    }),
    sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 2))),
    now: () => '2026-08-24T12:00:00.000Z',
    processAlive: () => true,
    writeSession: vi.fn(),
    afterSessionCreate: vi.fn(),
    beforeRequestWrite: vi.fn(),
  }
}

function runtimeRoot(root: string): string {
  return join(root, '.lab', 'runtime')
}

function devState(current: ReturnType<typeof fixture>, sessionId: string, phase: DevSessionPhase, extras: Partial<DevSessionStateV1> = {}): DevSessionStateV1 {
  const baseline = computeDevRestartBaseline({ pluginSourcePath: current.plugin.sourcePath, targetPin: NEXT })
  const base: DevSessionStateV1 = {
    schemaVersion: 1,
    sessionId,
    state: phase,
    plugin: { packageName: current.plugin.packageName, sourcePath: current.plugin.sourcePath, runtimeName: 'x' },
    target: { name: 'next', dsh: NEXT },
    restartBaseline: baseline,
    restartHash: aggregateRestartHash(baseline),
    restartRequired: false,
    startedAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:00.000Z',
  }
  if (phase === 'ready') return { ...base, supervisorPid: 7001, childPid: 7002, url: 'http://127.0.0.1:49152', ...extras }
  if (phase === 'crashed') return { ...base, error: 'fixture child crashed', ...extras }
  if (phase === 'stopping') return { ...base, cleanup: 'pass', ...extras }
  if (phase === 'stopped') return { ...base, cleanup: 'pass', ...extras }
  return { ...base, ...extras }
}

function createDevState(current: ReturnType<typeof fixture>, sessionId: string, phase: DevSessionPhase, extras: Partial<DevSessionStateV1> = {}): void {
  createOwnedDevSession({ runtimeRoot: runtimeRoot(current.root), state: devState(current, sessionId, phase, extras) })
}

function statusDeps(overrides: Partial<Pick<DevServiceDependencies, 'now' | 'processAlive'>> = {}) {
  return {
    now: vi.fn(() => '2026-08-24T12:00:04.000Z'),
    processAlive: vi.fn(() => true),
    ...overrides,
  }
}

function serviceDeps(overrides: Partial<DevServiceDependencies> = {}) {
  const unref = vi.fn()
  const deps: DevServiceDependencies = {
    spawnSupervisor: vi.fn(() => ({ pid: 7001, unref })),
    sleep: vi.fn(async () => {}),
    now: vi.fn(() => '2026-08-24T12:00:04.000Z'),
    processAlive: vi.fn(() => true),
    writeSession: vi.fn(opts => writeDevSession(opts)),
    ...overrides,
  }
  return { deps, unref }
}

function advancingNow(start = '2026-08-24T12:00:00.000Z', stepMs = 100) {
  let t = Date.parse(start)
  return vi.fn(() => {
    const value = new Date(t).toISOString()
    t += stepMs
    return value
  })
}

function deadlineStopSupervisor(current: ReturnType<typeof fixture>) {
  let sessionId = ''
  let stopped = false
  const runtimeRootValue = runtimeRoot(current.root)
  return serviceDeps({
    spawnSupervisor: vi.fn((requestPath: string) => {
      sessionId = requestPath.replace(/[\\/]request\.json$/, '').split(/[\\/]/).pop()!
      return { pid: 7001, unref: vi.fn() }
    }),
    sleep: vi.fn(async () => {
      if (sessionId && !stopped) {
        const control = readDevControl({ runtimeRoot: runtimeRootValue, sessionId })
        if (control?.action === 'stop') {
          const state = readDevSession({ runtimeRoot: runtimeRootValue, sessionId })
          const { supervisorPid: _s, childPid: _c, url: _u, error: _e, ...stoppingBase } = state
          writeDevSession({ runtimeRoot: runtimeRootValue, state: { ...stoppingBase, state: 'stopping', cleanup: 'pass', updatedAt: '2026-08-24T12:00:12.000Z' } })
          writeDevSession({ runtimeRoot: runtimeRootValue, state: { ...stoppingBase, state: 'stopped', cleanup: 'pass', updatedAt: '2026-08-24T12:00:12.000Z' } })
          clearDevControl({ runtimeRoot: runtimeRootValue, sessionId })
          stopped = true
        }
      }
    }),
    now: advancingNow(),
  })
}

describe('buildDevSupervisorSpawn', () => {
  it('uses Node, the dev supervisor bin, and the request path detached without a shell or inherited stdio', () => {
    const requestPath = 'A:/forge/.lab/runtime/dev-sessions/dev-20260824T120000000Z-a1b2c3d4/request.json'
    const plan = buildDevSupervisorSpawn(requestPath)
    expect(plan.command).toBe(process.execPath)
    const binIndex = plan.args.findIndex(a => /dev-supervisor-bin\.(?:m?js|ts)$/.test(a.split(/[\\/]/).pop()!))
    expect(binIndex).toBeGreaterThanOrEqual(0)
    if (plan.args[binIndex]!.endsWith('.ts')) expect(plan.args.slice(0, binIndex)).toEqual(['--import', resolveTsxLoader()])
    expect(plan.args.at(-1)).toBe(requestPath)
    expect(plan.options).toEqual({ detached: true, shell: false, stdio: 'ignore', windowsHide: true })
  })
})

describe('startDevSession', () => {
  let f: ReturnType<typeof fixture>
  beforeEach(() => { f = fixture() })

  it('returns a ready view when the supervisor reaches ready', async () => {
    const view = await startDevSession({ root: f.root, plugin: f.plugin, target: 'next', startupTimeoutMs: 5000 }, readyDeps(f))
    expect(view.sessionId).toMatch(/^dev-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$/)
    expect(view.state).toBe('ready')
    expect(view.url).toBe('http://127.0.0.1:49152')
    expect(view.restartRequired).toBe(false)
    // (A `waitUntilStopped`-style idempotent-stop assertion lives in Task 6.)
  })

  it('marks the session crashed and rethrows when the supervisor cannot spawn', async () => {
    const deps = serviceDeps({ spawnSupervisor: vi.fn(() => { throw new Error('spawn boom') }) })
    await expect(startDevSession({ root: f.root, plugin: f.plugin, target: 'next', startupTimeoutMs: 5 }, deps.deps)).rejects.toThrow(/spawn boom/)
    const sessionId = readdirSync(join(runtimeRoot(f.root), 'dev-sessions'))[0]!
    const state = readDevSession({ runtimeRoot: runtimeRoot(f.root), sessionId })
    expect(state.state).toBe('crashed')
    expect(state.cleanup).toBe('fail')
    expect(state.error).toMatch(/spawn boom/)
  })

  it('returns the stopped view after a post-deadline stop completes instead of throwing', async () => {
    const deps = deadlineStopSupervisor(f)
    const view = await startDevSession({ root: f.root, plugin: f.plugin, target: 'next', startupTimeoutMs: 5 }, deps.deps)
    expect(view.state).toBe('stopped')
    expect(view.cleanup).toBe('pass')
  })
})

describe('getDevSessionStatus', () => {
  let f: ReturnType<typeof fixture>
  beforeEach(() => { f = fixture() })

  it('latches each restart component monotonically and hides a stale URL', () => {
    createDevState(f, SESSION, 'ready')
    const initial = getDevSessionStatus({ root: f.root, sessionId: SESSION }, statusDeps())
    expect(initial).toMatchObject({ state: 'ready', restartRequired: false, restartReasons: [] })
    expect(initial.url).toBe('http://127.0.0.1:49152')

    writeFileSync(join(f.plugin.sourcePath, 'package.json'), '{"name":"@f/x","version":"0.0.1","dsh":{"bundle":{"patch":"cordis.patch.yml"}}}\n')
    const manifestView = getDevSessionStatus({ root: f.root, sessionId: SESSION }, statusDeps())
    expect(manifestView.restartRequired).toBe(true)
    expect(manifestView.restartReasons).toContain('plugin-manifest')
    expect(manifestView).not.toHaveProperty('url')

    writeFileSync(join(f.plugin.sourcePath, '.dsh-lab', 'plugin.yaml'), 'name: x\ntracking: local\nmaturity: experimental\ntargets:\n  - next\n')
    const metadataView = getDevSessionStatus({ root: f.root, sessionId: SESSION }, statusDeps())
    expect(metadataView.restartReasons).toEqual(expect.arrayContaining(['plugin-manifest', 'plugin-metadata']))

    writeCompatibility(f.root, '0.1.1-rc.3')
    const targetView = getDevSessionStatus({ root: f.root, sessionId: SESSION }, statusDeps())
    expect(targetView.restartReasons).toEqual(['plugin-manifest', 'plugin-metadata', 'target-pin'])
    expect(targetView).not.toHaveProperty('url')

    const again = getDevSessionStatus({ root: f.root, sessionId: SESSION }, statusDeps())
    expect(again.restartReasons).toEqual(['plugin-manifest', 'plugin-metadata', 'target-pin'])
    expect(again).not.toHaveProperty('url')
  })

  it('treats dev sessions as live source: edits to src never trigger a restart reason', () => {
    createDevState(f, SESSION, 'ready')
    writeFileSync(join(f.plugin.sourcePath, 'src', 'index.ts'), 'export const live = false\n')
    const view = getDevSessionStatus({ root: f.root, sessionId: SESSION }, statusDeps())
    expect(view).toMatchObject({ state: 'ready', restartRequired: false, restartReasons: [] })
    expect(view.url).toBe('http://127.0.0.1:49152')
  })

  it('reports a ready session whose supervisor/child died as an orphan', () => {
    createDevState(f, SESSION, 'ready')
    const view = getDevSessionStatus({ root: f.root, sessionId: SESSION }, statusDeps({ processAlive: vi.fn(() => false) }))
    expect(view.state).toBe('crashed')
    expect(view.orphan).toBe(true)
    expect(view.error).toMatch(/orphan|not running/i)
    expect(view.error).toContain(join(runtimeRoot(f.root), 'dev-sessions', SESSION))
  })

  it('reports a starting session with no owner as an orphan', () => {
    createDevState(f, SESSION, 'starting')
    const view = getDevSessionStatus({ root: f.root, sessionId: SESSION }, statusDeps())
    expect(view.state).toBe('crashed')
    expect(view.orphan).toBe(true)
    expect(view.error).toMatch(/owner is missing|orphan/i)
  })

  it('reports a crashed session with a dead recovery supervisor as an orphan', () => {
    createDevState(f, SESSION, 'crashed', { supervisorPid: 7001 })
    const view = getDevSessionStatus({ root: f.root, sessionId: SESSION }, statusDeps({ processAlive: vi.fn(() => false) }))
    expect(view.state).toBe('crashed')
    expect(view.orphan).toBe(true)
    expect(view.error).toMatch(/recovery supervisor is not running|orphan/i)
  })

  it('returns a stopping session view without reporting it as an orphan', () => {
    createDevState(f, SESSION, 'stopping')
    const view = getDevSessionStatus({ root: f.root, sessionId: SESSION }, statusDeps())
    expect(view.state).toBe('stopping')
    expect(view.orphan).toBeUndefined()
  })

  it('returns the stored stopped view after a lived manifest change, without mutating the tombstone', () => {
    createDevState(f, SESSION, 'stopped')
    rmSync(join(f.plugin.sourcePath, 'package.json'))
    const view = getDevSessionStatus({ root: f.root, sessionId: SESSION }, statusDeps())
    expect(view.state).toBe('stopped')
    expect(view.cleanup).toBe('pass')
    expect(view.restartRequired).toBe(false)
    expect(view.restartReasons).toEqual([])
  })

  it('surfaces a lost compatibility manifest as a configuration error, not a plugin change', () => {
    createDevState(f, SESSION, 'ready')
    rmSync(join(f.root, 'workbench', 'compatibility.yaml'))
    expect(() => getDevSessionStatus({ root: f.root, sessionId: SESSION }, statusDeps())).toThrow(/compatibility|manifest|yaml|ENOENT/i)
  })
})

describe('stopDevSession', () => {
  let f: ReturnType<typeof fixture>
  beforeEach(() => { f = fixture() })

  it('returns an orphan view without writing a stop control when the supervisor pid is dead', async () => {
    createDevState(f, SESSION, 'ready')
    const deps = serviceDeps({ processAlive: vi.fn(() => false) })
    const view = await stopDevSession({ root: f.root, sessionId: SESSION, stopTimeoutMs: 5000 }, deps.deps)
    expect(view.state).toBe('crashed')
    expect(view.orphan).toBe(true)
    expect(readDevControl({ runtimeRoot: runtimeRoot(f.root), sessionId: SESSION })).toBeUndefined()
  })

  it('returns an orphan view without launching recovery for a crashed session with no owner', async () => {
    createDevState(f, SESSION, 'crashed')
    const deps = serviceDeps({ processAlive: vi.fn(() => false) })
    const view = await stopDevSession({ root: f.root, sessionId: SESSION, stopTimeoutMs: 5000 }, deps.deps)
    expect(view.state).toBe('crashed')
    expect(view.orphan).toBe(true)
    expect(readDevControl({ runtimeRoot: runtimeRoot(f.root), sessionId: SESSION })).toBeUndefined()
  })

  it('treats a stopped session as an idempotent tombstone', async () => {
    createDevState(f, SESSION, 'stopped')
    const deps = serviceDeps()
    const first = await stopDevSession({ root: f.root, sessionId: SESSION }, deps.deps)
    expect(first).toMatchObject({ state: 'stopped', cleanup: 'pass' })
    const second = await stopDevSession({ root: f.root, sessionId: SESSION }, deps.deps)
    expect(second).toEqual(first)
    expect(readDevControl({ runtimeRoot: runtimeRoot(f.root), sessionId: SESSION })).toBeUndefined()
  })

  it('rejects a stop on a session that is already stopping', async () => {
    createDevState(f, SESSION, 'stopping')
    await expect(stopDevSession({ root: f.root, sessionId: SESSION }, serviceDeps().deps)).rejects.toThrow(/already stopping/i)
  })

  it('rejects a stop on a crashed session whose cleanup already failed', async () => {
    createDevState(f, SESSION, 'crashed', { cleanup: 'fail' })
    await expect(stopDevSession({ root: f.root, sessionId: SESSION }, serviceDeps().deps)).rejects.toThrow(/cleanup|fail/i)
  })

  it('times out when the supervisor never reaches stopped', async () => {
    createDevState(f, SESSION, 'ready')
    const deps = serviceDeps({ now: advancingNow() })
    await expect(stopDevSession({ root: f.root, sessionId: SESSION, stopTimeoutMs: 5 }, deps.deps)).rejects.toThrow(/cleanup( timed out| failed)|cleanup-incomplete/i)
    expect(readDevControl({ runtimeRoot: runtimeRoot(f.root), sessionId: SESSION })).toBeDefined()
    expect(readDevSession({ runtimeRoot: runtimeRoot(f.root), sessionId: SESSION }).state).toBe('ready')
  })
})
