import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const resolveUiLauncherMock = vi.hoisted(() => vi.fn(async () => ({ cmd: process.execPath, args: ['dsh.js'] })))

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock }
})

vi.mock('./run.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./run.js')>()
  return { ...actual, resolveUiLauncher: resolveUiLauncherMock }
})

import { parseDshReadyUrl, type UiChildExit, type UiChildHandle } from './ui-supervisor.js'
import {
  runDevSupervisor,
  validateDevSupervisorRequest,
  defaultDevSupervisorDependencies,
  type DevSupervisorDependencies,
  type DevSupervisorRuntimePlan,
  type DevSupervisorRequestV1,
  type RuntimeLauncher,
} from './dev-supervisor.js'
import { createOwnedDevSession, writeDevControl, readDevSession, readDevControl, type DevSessionStateV1 } from './dev-session-state.js'
import { digestString } from './dev-restart-baseline.js'
import type { Compatibility } from './schemas.js'

const SESSION = 'dev-20260824T120000000Z-a1b2c3d4'

function request(): DevSupervisorRequestV1 {
  return {
    schemaVersion: 1, root: 'A:/forge', sessionId: SESSION,
    plugin: { packageName: '@f/x', sourcePath: 'A:/p', runtimeName: 'x' }, target: 'next',
    startedAt: '2026-08-24T12:00:00.000Z',
    restartBaseline: { pluginManifest: digestString('a'), pluginMetadata: digestString('b'), targetPin: digestString('c') },
  }
}

function launcher(cmd: string = process.execPath, args: string[] = ['dsh.js']): RuntimeLauncher {
  return { cmd, args }
}

function runtimePlan(overrides: Partial<DevSupervisorRuntimePlan> = {}): DevSupervisorRuntimePlan {
  return {
    overlayPath: 'A:/x/overlay/cordis.patch.yml',
    profileDir: 'A:/x/profiles/x-next-dev',
    cwd: 'A:/x/profiles/x-next-dev',
    env: { DSH_HOME: 'A:/x' },
    launcher: launcher(),
    ...overrides,
  }
}

function deps(): DevSupervisorDependencies {
  return {
    prepareRuntime: vi.fn(async () => runtimePlan()),
    spawnChild: vi.fn(),
    resolveLauncher: vi.fn(async () => launcher()),
    stopChildTree: vi.fn(async () => {}),
    openLog: vi.fn(() => ({ write: vi.fn(), close: vi.fn() })),
    now: () => '2026-08-24T12:00:01.000Z',
    sleep: ms => new Promise(r => setTimeout(r, Math.min(ms, 2))),
    pollIntervalMs: 1,
    maxLogBytes: 64 * 1024,
  }
}

function fakeChild(pid = 4242) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let leaderExited = false
  let resolveExit: (value: UiChildExit) => void = () => undefined
  const exited = new Promise<UiChildExit>(resolve => { resolveExit = resolve })
  const handle: UiChildHandle = { pid, stdout, stderr, exited, leaderExited: () => leaderExited }
  return {
    handle,
    stdout,
    stderr,
    exit(value: UiChildExit) {
      if (leaderExited) return
      leaderExited = true
      resolveExit(value)
    },
  }
}

function fakeSpawnObject(pid = 4242) {
  return {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    once: vi.fn(),
    on: vi.fn(),
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

describe('validateDevSupervisorRequest', () => {
  it('rejects a non-object or a bad schemaVersion', () => {
    expect(() => validateDevSupervisorRequest(null)).toThrow(/object/)
    expect(() => validateDevSupervisorRequest({ ...request(), schemaVersion: 2 })).toThrow(/schemaVersion/)
  })
})

describe('runDevSupervisor stop-before-spawn leaves a stopped tombstone', () => {
  let root: string
  let runtimeRoot: string
  let sessionId: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-dev-sup-'))
    runtimeRoot = join(root, '.lab', 'runtime')
    sessionId = SESSION
    const state: DevSessionStateV1 = {
      schemaVersion: 1, sessionId, state: 'starting',
      plugin: { packageName: '@f/x', sourcePath: 'A:/p', runtimeName: 'x' },
      target: { name: 'next', dsh: '0.1.1-rc.2' },
      restartBaseline: { pluginManifest: digestString('a'), pluginMetadata: digestString('b'), targetPin: digestString('c') },
      restartHash: digestString('d'), restartRequired: false,
      startedAt: '2026-08-24T12:00:00.000Z', updatedAt: '2026-08-24T12:00:00.000Z',
    }
    createOwnedDevSession({ runtimeRoot, state })
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('when a stop control is already present, the supervisor stops without spawning and retains a stopped tombstone', async () => {
    writeDevControl({ runtimeRoot, sessionId, control: { schemaVersion: 1, action: 'stop', requestedAt: '2026-08-24T12:00:01.000Z' } })
    const d = deps()
    await runDevSupervisor({ ...request(), root, sessionId }, d)
    const s = readDevSession({ runtimeRoot, sessionId })
    expect(s.state).toBe('stopped')
    expect(s.cleanup).toBe('pass')
    expect(s.supervisorPid).toBeUndefined()
    expect(readDevControl({ runtimeRoot, sessionId })).toBeUndefined()
    expect(d.spawnChild).not.toHaveBeenCalled()
  })

  it('a child that exits before ready writes a crashed state and terminates the supervisor (no endless poll)', async () => {
    const child = fakeChild()
    const d = deps()
    vi.mocked(d.spawnChild).mockReturnValue(child.handle)
    d.resolveLauncher = vi.fn(async () => launcher())
    d.stopChildTree = vi.fn(async () => { child.exit({ code: 1, signal: null }) })
    const running = runDevSupervisor({ ...request(), root, sessionId }, d)
    child.exit({ code: 1, signal: null })
    await expect(running).resolves.toBeUndefined()
    const s = readDevSession({ runtimeRoot, sessionId })
    expect(s.state).toBe('crashed')
    expect(s.error).toMatch(/exited/)
  })

  it('reconstructs a fragmented readiness line across split stdout chunks and records the ready URL', async () => {
    const child = fakeChild()
    const d = deps()
    ;vi.mocked(d.spawnChild).mockReturnValue(child.handle)
    d.resolveLauncher = vi.fn(async () => launcher())
    d.stopChildTree = vi.fn(async () => { child.exit({ code: 0, signal: null }) })
    const running = runDevSupervisor({ ...request(), root, sessionId }, d)
    child.stdout.write('dsh web: http://127.')
    child.stdout.write('0.0.1:49152\n')
    await waitFor(() => readDevSession({ runtimeRoot, sessionId }).state === 'ready', 'ready')
    expect(readDevSession({ runtimeRoot, sessionId }).url).toBe('http://127.0.0.1:49152')

    writeDevControl({ runtimeRoot, sessionId, control: { schemaVersion: 1, action: 'stop', requestedAt: '2026-08-24T12:01:00.000Z' } })
    await running
    const terminal = readDevSession({ runtimeRoot, sessionId })
    expect(terminal.state).toBe('stopped')
    expect(terminal.cleanup).toBe('pass')
  })
})

describe('default spawnDevRuntimeChild boots the resolved launcher with the exact dev argv (no shell)', () => {
  beforeEach(() => { spawnMock.mockReset() })

  it('next launcher: spawn uses launcher.cmd, the profile/source-overlay/loopback args, and shell:false', () => {
    const { spawnChild } = defaultDevSupervisorDependencies()
    spawnMock.mockReturnValue(fakeSpawnObject(4242))
    const plan = runtimePlan({
      overlayPath: 'C:/lab/overlay/cordis.patch.yml',
      profileDir: 'C:/lab/profiles/x-next-dev',
      cwd: 'C:/lab/profiles/x-next-dev',
      env: { DSH_HOME: 'C:/lab' },
      launcher: { cmd: process.execPath, args: ['C:/tools/pnpm.cjs', 'exec', 'dsh'] },
    })
    const handle = spawnChild(plan)
    expect(handle.pid).toBe(4242)
    expect(spawnMock).toHaveBeenCalledWith(process.execPath, [
      'C:/tools/pnpm.cjs', 'exec', 'dsh',
      '--profile', 'x-next-dev',
      '--patch', 'C:/lab/overlay/cordis.patch.yml',
      '--host', '127.0.0.1', '--port', '0', '--no-open',
    ], expect.objectContaining({ shell: false, detached: true, cwd: plan.cwd, env: plan.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }))
  })

  it('master launcher: spawn uses the built upstream bin directly', () => {
    const { spawnChild } = defaultDevSupervisorDependencies()
    spawnMock.mockReturnValue(fakeSpawnObject(4242))
    const plan = runtimePlan({
      overlayPath: 'C:/lab/overlay/cordis.patch.yml',
      profileDir: 'C:/lab/profiles/x-master-dev',
      launcher: { cmd: process.execPath, args: ['C:/lab/upstream/apps/cli/lib/bin.js'] },
    })
    spawnChild(plan)
    expect(spawnMock).toHaveBeenCalledWith(process.execPath, [
      'C:/lab/upstream/apps/cli/lib/bin.js',
      '--profile', 'x-master-dev',
      '--patch', 'C:/lab/overlay/cordis.patch.yml',
      '--host', '127.0.0.1', '--port', '0', '--no-open',
    ], expect.objectContaining({ shell: false }))
  })

  it('paths with spaces remain single argv elements (no shell tokenization)', () => {
    const { spawnChild } = defaultDevSupervisorDependencies()
    spawnMock.mockReturnValue(fakeSpawnObject(4242))
    const plan = runtimePlan({
      overlayPath: 'C:/path with spaces/overlay/cordis.patch.yml',
      profileDir: 'C:/path with spaces/profiles/x-next-dev',
      launcher: { cmd: process.execPath, args: ['C:/path with spaces/tools/pnpm.cjs', 'exec', 'dsh'] },
    })
    spawnChild(plan)
    const call = spawnMock.mock.calls[0] as [string, string[], unknown]
    expect(call[0]).toBe(process.execPath)
    expect(call[1]).toEqual([
      'C:/path with spaces/tools/pnpm.cjs', 'exec', 'dsh',
      '--profile', 'x-next-dev',
      '--patch', 'C:/path with spaces/overlay/cordis.patch.yml',
      '--host', '127.0.0.1', '--port', '0', '--no-open',
    ])
  })
})

describe('resolveLauncher seam threads target, compat, and AbortSignal', () => {
  afterEach(() => { resolveUiLauncherMock.mockClear() })

  it('forwards root/target/compat/signal to resolveUiLauncher', async () => {
    // Minimal compat fixture: the seam only forwards it, never inspects it.
    const compat = { targets: {} } as unknown as Compatibility
    const signal = new AbortController().signal
    const { resolveLauncher } = defaultDevSupervisorDependencies()
    await resolveLauncher('C:/root', 'master', compat, signal)
    expect(resolveUiLauncherMock).toHaveBeenCalledWith('C:/root', 'master', compat, signal)
  })
})

describe('shared reuse (no duplication)', () => {
  it('re-exports the UI process-tree/url/log primitives rather than re-implementing them', async () => {
    const mod = await import('./dev-supervisor.js')
    expect(typeof mod.parseDshReadyUrl).toBe('function')
    expect(typeof mod.openBoundedSupervisorLog).toBe('function')
    expect(typeof mod.stopOwnedChildTree).toBe('function')
    expect(parseDshReadyUrl('dsh web: http://127.0.0.1:49152')).toBe('http://127.0.0.1:49152')
    expect(parseDshReadyUrl('nope')).toBeUndefined()
  })
})
