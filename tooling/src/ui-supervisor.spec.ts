import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  createUiSession,
  readUiSession,
  writeUiControl,
  type UiSessionStateV1,
} from './ui-session.js'
import type { UiRuntimePlan, UiRuntimePlugin } from './ui-runtime.js'
import {
  parseDshReadyUrl,
  openBoundedSupervisorLog,
  posixProcessGroup,
  runUiSupervisor,
  stopOwnedChildTree,
  windowsTreeKillArgs,
  type UiChildExit,
  type UiChildHandle,
  type UiDiagnosticLog,
  type UiProcessTreeDependencies,
  type UiSupervisorDependencies,
  type UiSupervisorRequestV1,
} from './ui-supervisor.js'

const roots: string[] = []
const SESSION = 'ui-20260824T120000000Z-a1b2c3d4'
const OTHER = 'ui-20260824T120000000Z-deadbeef'

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(sessionId = SESSION, existingRoot?: string) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), 'dsh-lab-ui-supervisor-'))
  if (existingRoot === undefined) roots.push(root)
  const runtimeRoot = join(root, '.lab', 'runtime')
  const plugin: UiRuntimePlugin = {
    packageName: '@fixture/supervisor',
    sourcePath: join(root, 'plugin'),
    runtimeName: 'supervisor',
  }
  const initial: UiSessionStateV1 = {
    schemaVersion: 1,
    sessionId,
    state: 'starting',
    plugin: {
      packageName: plugin.packageName,
      sourcePath: plugin.sourcePath,
      digest: `sha256:${'1'.repeat(64)}`,
    },
    target: { name: 'next', dsh: '0.1.1-rc.2' },
    contextDigest: `sha256:${'2'.repeat(64)}`,
    startedAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:00.000Z',
  }
  const sessionDir = createUiSession({ runtimeRoot, state: initial })
  const plan: UiRuntimePlan = {
    sessionDir,
    runtimeHome: join(sessionDir, 'home'),
    profileName: `supervisor-next-ui-${sessionId}`,
    profileDir: join(sessionDir, 'home', 'profiles', `supervisor-next-ui-${sessionId}`),
    overlayPath: join(sessionDir, 'overlay', 'cordis.patch.yml'),
    launcher: { cmd: process.execPath, args: ['fixture-dsh.js'] },
    argv: ['fixture-dsh.js', '--profile', `supervisor-next-ui-${sessionId}`, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    cwd: join(sessionDir, 'home'),
  }
  mkdirSync(plan.profileDir, { recursive: true })
  mkdirSync(join(plan.overlayPath, '..'), { recursive: true })
  writeFileSync(plan.overlayPath, 'overlay')
  const request: UiSupervisorRequestV1 = {
    schemaVersion: 1,
    root,
    sessionId,
    plugin,
    target: 'next',
    startedAt: initial.startedAt,
  }
  return { root, runtimeRoot, sessionDir, plan, request }
}

function fakeChild(pid = 4242) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let leaderExited = false
  let resolveExit!: (value: UiChildExit) => void
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

function dependencies(plan: UiRuntimePlan, child = fakeChild()) {
  let tick = 0
  const stopChildTree = vi.fn(async () => {
    child.exit({ code: 0, signal: 'SIGTERM' })
  })
  const deps: UiSupervisorDependencies = {
    prepareRuntime: vi.fn(async () => plan),
    spawnChild: vi.fn(() => child.handle),
    stopChildTree,
    openLog: openBoundedSupervisorLog,
    now: () => `2026-08-24T12:00:${String(++tick).padStart(2, '0')}.000Z`,
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 2))),
    pollIntervalMs: 1,
    maxLogBytes: 64 * 1024,
  }
  return { deps, child, stopChildTree }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

describe('parseDshReadyUrl', () => {
  it.each([
    ['dsh web: http://127.0.0.1:49152', 'http://127.0.0.1:49152'],
    ['dsh web: http://127.0.0.1:8080 (LAN: http://192.168.1.2:8080)', 'http://127.0.0.1:8080'],
  ])('captures only the loopback URL from %j', (line, expected) => {
    expect(parseDshReadyUrl(line)).toBe(expected)
  })

  it.each([
    'prefix dsh web: http://127.0.0.1:8000',
    'dsh web: http://0.0.0.0:8000',
    'dsh web: http://localhost:8000',
    'dsh web: https://127.0.0.1:8000',
    'dsh web: http://user@127.0.0.1:8000',
    'dsh web: http://127.0.0.1:0',
    'dsh web: http://127.0.0.1:65536',
    'dsh web: http://127.0.0.1:8000/path',
    'dsh web: http://127.0.0.1:8000 (broken)',
  ])('rejects unsafe or malformed readiness line %j', line => {
    expect(parseDshReadyUrl(line)).toBeUndefined()
  })

  it('builds only validated platform-owned process-tree identifiers', () => {
    expect(windowsTreeKillArgs(4242)).toEqual(['/PID', '4242', '/T', '/F'])
    expect(posixProcessGroup(4242)).toBe(-4242)
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      expect(() => windowsTreeKillArgs(pid)).toThrow(/pid|positive|integer/i)
      expect(() => posixProcessGroup(pid)).toThrow(/pid|positive|integer/i)
    }
  })

  it('escalates an owned POSIX process group and fails if close stays unconfirmed', async () => {
    const child = fakeChild().handle
    const signalGroup = vi.fn()
    const waitForExit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const deps: UiProcessTreeDependencies = {
      platform: 'posix',
      taskkill: vi.fn(),
      signalGroup,
      waitForExit,
      termGraceMs: 5,
      killGraceMs: 5,
    }
    await stopOwnedChildTree(child, deps)
    expect(signalGroup.mock.calls).toEqual([
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
    ])

    waitForExit.mockReset()
    waitForExit.mockResolvedValue(false)
    await expect(stopOwnedChildTree(child, deps)).rejects.toThrow(/close|exit|timeout|terminate/i)
  })

  it('proves the owned process tree is absent even after the direct child has exited', async () => {
    const child = fakeChild()
    child.exit({ code: 0, signal: null })
    const treeAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const signalGroup = vi.fn()
    const deps = {
      platform: 'posix' as const,
      taskkill: vi.fn(),
      signalGroup,
      waitForExit: vi.fn(async () => true),
      treeAlive,
      termGraceMs: 5,
      killGraceMs: 5,
    } as UiProcessTreeDependencies & { treeAlive(pid: number): boolean }

    await stopOwnedChildTree(child.handle, deps)

    expect(treeAlive).toHaveBeenCalledWith(-child.handle.pid)
    expect(signalGroup).toHaveBeenCalledWith(-child.handle.pid, 'SIGTERM')
  })

  it('fails Windows cleanup without targeting a potentially reused PID after leader exit', async () => {
    const child = fakeChild()
    child.exit({ code: 0, signal: null })
    const deps = {
      platform: 'windows' as const,
      taskkill: vi.fn(async () => undefined),
      signalGroup: vi.fn(),
      waitForExit: vi.fn(async () => true),
      treeAlive: vi.fn(() => false),
      termGraceMs: 5,
      killGraceMs: 5,
    } as UiProcessTreeDependencies & { treeAlive(pid: number): boolean }

    await expect(stopOwnedChildTree(child.handle, deps)).rejects.toThrow(/tree|descendant|absence|prove|cleanup/i)
    expect(deps.taskkill).not.toHaveBeenCalled()
  })

  it('terminates a Windows tree while its owned leader is still live', async () => {
    const child = fakeChild()
    const deps = {
      platform: 'windows' as const,
      taskkill: vi.fn(async () => { child.exit({ code: 1, signal: null }) }),
      signalGroup: vi.fn(),
      waitForExit: vi.fn(async () => true),
      treeAlive: vi.fn(() => false),
      termGraceMs: 5,
      killGraceMs: 5,
    } as UiProcessTreeDependencies & { treeAlive(pid: number): boolean }

    await stopOwnedChildTree(child.handle, deps)

    expect(deps.taskkill).toHaveBeenCalledWith(['/PID', String(child.handle.pid), '/T', '/F'])
  })

  it('refuses to open a bounded log through an externally linked file', () => {
    const current = fixture()
    const canary = join(current.root, 'outside.log')
    const log = join(current.sessionDir, 'supervisor.log')
    writeFileSync(canary, 'do-not-change')
    linkSync(canary, log)
    expect(() => openBoundedSupervisorLog(current.sessionDir, 32)).toThrow(/exist|link|unsafe|regular/i)
    expect(readFileSync(canary, 'utf8')).toBe('do-not-change')
  })
})

describe('runUiSupervisor', () => {
  it('retains its startup session identity before opening the diagnostic log', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    const parked = `${current.sessionDir}.parked`
    let replacementState = ''
    bundle.deps.prepareRuntime = vi.fn(async () => {
      const ownedState = readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })
      const terminal: UiSessionStateV1 = {
        ...ownedState,
        state: 'finished',
        cleanup: 'pass',
        updatedAt: '2026-08-24T12:00:59.000Z',
      }
      delete terminal.supervisorPid
      delete terminal.childPid
      delete terminal.url
      delete terminal.error
      replacementState = JSON.stringify(terminal, null, 2) + '\n'
      renameSync(current.sessionDir, parked)
      mkdirSync(current.sessionDir)
      writeFileSync(join(current.sessionDir, 'state.json'), replacementState)
      writeFileSync(join(current.sessionDir, 'replacement-canary.txt'), 'replacement')
      return current.plan
    })
    bundle.deps.openLog = vi.fn((sessionDir, maxBytes) => {
      const log = openBoundedSupervisorLog(sessionDir, maxBytes)
      log.close()
      throw new Error('replacement diagnostic log was opened')
    })

    await expect(runUiSupervisor(current.request, bundle.deps)).rejects.toThrow(/identity|changed|swap|refus/i)

    expect(bundle.deps.openLog).not.toHaveBeenCalled()
    expect(existsSync(join(current.sessionDir, 'supervisor.log'))).toBe(false)
    expect(readFileSync(join(current.sessionDir, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(readFileSync(join(current.sessionDir, 'state.json'), 'utf8')).toBe(replacementState)
    expect(existsSync(join(parked, 'home'))).toBe(true)
  })

  it('reconstructs fragmented readiness, ignores stderr lookalikes, and finishes after cleanup', async () => {
    const current = fixture()
    const { deps, child, stopChildTree } = dependencies(current.plan)
    const running = runUiSupervisor(current.request, deps)
    child.stderr.write('dsh web: http://127.0.0.1:9999\n')
    child.stdout.write('dsh web: http://127.')
    child.stdout.write('0.0.1:49152\n')
    await waitFor(() => readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).state === 'ready', 'ready')
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).url).toBe('http://127.0.0.1:49152')

    writeUiControl({
      runtimeRoot: current.runtimeRoot,
      sessionId: SESSION,
      control: { schemaVersion: 1, action: 'finish', requestedAt: '2026-08-24T12:01:00.000Z' },
    })
    await running

    const terminal = readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })
    expect(terminal).toMatchObject({ state: 'stopping', cleanup: 'pass' })
    expect(terminal).not.toHaveProperty('url')
    expect(terminal).not.toHaveProperty('childPid')
    expect(terminal).not.toHaveProperty('supervisorPid')
    expect(stopChildTree).toHaveBeenCalledTimes(1)
    expect(existsSync(current.plan.runtimeHome)).toBe(false)
    expect(existsSync(join(current.sessionDir, 'overlay'))).toBe(false)
    expect(existsSync(join(current.sessionDir, 'control.json'))).toBe(false)
    expect(existsSync(join(current.sessionDir, 'supervisor.log'))).toBe(false)
  })

  it('retains its startup session identity through child stop and descendant cleanup', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    const parked = `${current.sessionDir}.parked`
    let replacementState = ''
    bundle.deps.stopChildTree = vi.fn(async () => {
      bundle.child.exit({ code: 0, signal: 'SIGTERM' })
      replacementState = readFileSync(join(current.sessionDir, 'state.json'), 'utf8')
      renameSync(current.sessionDir, parked)
      mkdirSync(join(current.sessionDir, 'home'), { recursive: true })
      mkdirSync(join(current.sessionDir, 'overlay'), { recursive: true })
      writeFileSync(join(current.sessionDir, 'home', 'replacement-canary.txt'), 'replacement home')
      writeFileSync(join(current.sessionDir, 'overlay', 'replacement-canary.txt'), 'replacement overlay')
      writeFileSync(join(current.sessionDir, 'supervisor.log'), 'replacement log')
      writeFileSync(join(current.sessionDir, 'state.json'), replacementState)
    })
    const running = runUiSupervisor(current.request, bundle.deps)
    bundle.child.stdout.write('dsh web: http://127.0.0.1:49152\n')
    await waitFor(() => readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).state === 'ready', 'ready')
    writeUiControl({
      runtimeRoot: current.runtimeRoot,
      sessionId: SESSION,
      control: { schemaVersion: 1, action: 'abort', requestedAt: '2026-08-24T12:01:00.000Z' },
    })

    await expect(running).rejects.toThrow(/identity|changed|swap|refus|cleanup/i)

    expect(readFileSync(join(current.sessionDir, 'home', 'replacement-canary.txt'), 'utf8')).toBe('replacement home')
    expect(readFileSync(join(current.sessionDir, 'overlay', 'replacement-canary.txt'), 'utf8')).toBe('replacement overlay')
    expect(readFileSync(join(current.sessionDir, 'supervisor.log'), 'utf8')).toBe('replacement log')
    expect(readFileSync(join(current.sessionDir, 'state.json'), 'utf8')).toBe(replacementState)
    expect(existsSync(join(parked, 'home'))).toBe(true)
    expect(existsSync(join(parked, 'control.json'))).toBe(true)
  })

  it('aborts without publishing evidence and is isolated to its own session', async () => {
    const current = fixture()
    const { deps, child } = dependencies(current.plan)
    const running = runUiSupervisor(current.request, deps)
    child.stdout.write('dsh web: http://127.0.0.1:49152\n')
    await waitFor(() => readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).state === 'ready', 'ready')
    writeUiControl({
      runtimeRoot: current.runtimeRoot,
      sessionId: SESSION,
      control: { schemaVersion: 1, action: 'abort', requestedAt: '2026-08-24T12:01:00.000Z' },
    })
    await running
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })).toMatchObject({
      state: 'aborted',
      cleanup: 'pass',
    })
    expect(existsSync(join(current.root, '.lab', 'ui-runs'))).toBe(false)
  })

  it.each(['before', 'after'] as const)('records a child crash %s readiness and still proves tree cleanup on abort', async when => {
    const current = fixture()
    const { deps, child, stopChildTree } = dependencies(current.plan)
    const running = runUiSupervisor(current.request, deps)
    if (when === 'after') {
      child.stdout.write('dsh web: http://127.0.0.1:49152\n')
      await waitFor(() => readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).state === 'ready', 'ready')
    }
    child.exit({ code: 7, signal: null })
    await waitFor(() => readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).state === 'crashed', 'crashed')
    const crashed = readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })
    writeUiControl({
      runtimeRoot: current.runtimeRoot,
      sessionId: SESSION,
      control: { schemaVersion: 1, action: 'abort', requestedAt: '2026-08-24T12:01:00.000Z' },
    })
    await running
    expect(crashed.error).toMatch(/exit|code 7|crash/i)
    expect(crashed.supervisorPid).toBe(process.pid)
    expect(crashed).not.toHaveProperty('childPid')
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).state).toBe('aborted')
    expect(stopChildTree).toHaveBeenCalledTimes(1)
  })

  it('records cleanup failure when a later supervisor error cannot prove a naturally exited tree absent', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    bundle.deps.stopChildTree = vi.fn(async () => { throw new Error('surviving descendant could not be stopped') })
    const running = runUiSupervisor(current.request, bundle.deps)
    void running.catch(() => undefined)
    bundle.child.exit({ code: 7, signal: null })
    await waitFor(() => readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).state === 'crashed', 'natural child crash')
    writeFileSync(join(current.sessionDir, 'control.json'), '{broken')

    await expect(running).rejects.toThrow(/control|corrupt|json|descendant|cleanup/i)

    expect(bundle.deps.stopChildTree).toHaveBeenCalledWith(bundle.child.handle)
    expect(bundle.deps.stopChildTree).toHaveBeenCalledTimes(1)
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })).toMatchObject({
      state: 'crashed',
      supervisorPid: process.pid,
      cleanup: 'fail',
      error: expect.stringMatching(/descendant|cleanup|stop|tree/i),
    })
    expect(existsSync(current.plan.runtimeHome)).toBe(true)
  })

  it('owns and cancels startup preparation before a child exists', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    bundle.deps.prepareRuntime = vi.fn(async (opts: Parameters<UiSupervisorDependencies['prepareRuntime']>[0] & { signal?: AbortSignal }): Promise<UiRuntimePlan> => {
      expect(opts.signal).toBeInstanceOf(AbortSignal)
      return await new Promise<UiRuntimePlan>((_resolve, reject) => {
        opts.signal!.addEventListener('abort', () => {
          const error = new Error('preparation aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    })
    const running = runUiSupervisor(current.request, bundle.deps)
    void running.catch(() => undefined)

    await waitFor(() => readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).supervisorPid === process.pid, 'starting supervisor ownership')
    writeUiControl({
      runtimeRoot: current.runtimeRoot,
      sessionId: SESSION,
      control: { schemaVersion: 1, action: 'abort', requestedAt: '2026-08-24T12:01:00.000Z' },
    })

    await expect(running).resolves.toBeUndefined()
    expect(bundle.deps.spawnChild).not.toHaveBeenCalled()
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })).toMatchObject({
      state: 'aborted',
      cleanup: 'pass',
    })
    expect(existsSync(join(current.sessionDir, 'control.json'))).toBe(false)
    expect(existsSync(current.plan.runtimeHome)).toBe(false)
  })

  it('honors a control published as preparation settles before opening a log or spawning a child', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    bundle.deps.openLog = vi.fn(openBoundedSupervisorLog)
    bundle.deps.prepareRuntime = vi.fn(async () => {
      writeUiControl({
        runtimeRoot: current.runtimeRoot,
        sessionId: SESSION,
        control: { schemaVersion: 1, action: 'abort', requestedAt: '2026-08-24T12:01:00.000Z' },
      })
      return current.plan
    })

    await expect(runUiSupervisor(current.request, bundle.deps)).resolves.toBeUndefined()

    expect(bundle.deps.openLog).not.toHaveBeenCalled()
    expect(bundle.deps.spawnChild).not.toHaveBeenCalled()
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })).toMatchObject({
      state: 'aborted',
      cleanup: 'pass',
    })
  })

  it('never reports abort success when preparation tree cancellation itself fails', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    bundle.deps.prepareRuntime = vi.fn(async (opts: Parameters<UiSupervisorDependencies['prepareRuntime']>[0] & { signal?: AbortSignal }): Promise<UiRuntimePlan> => {
      return await new Promise<UiRuntimePlan>((_resolve, reject) => {
        opts.signal!.addEventListener('abort', () => reject(new Error('owned preparation process group remained alive')), { once: true })
      })
    })
    const running = runUiSupervisor(current.request, bundle.deps)
    void running.catch(() => undefined)
    await waitFor(() => readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).supervisorPid === process.pid, 'starting supervisor ownership')
    writeUiControl({
      runtimeRoot: current.runtimeRoot,
      sessionId: SESSION,
      control: { schemaVersion: 1, action: 'abort', requestedAt: '2026-08-24T12:01:00.000Z' },
    })

    await expect(running).rejects.toThrow(/process group|cleanup|cancel|alive/i)
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })).toMatchObject({
      state: 'crashed',
      cleanup: 'fail',
      error: expect.stringMatching(/process group|cleanup|cancel|alive/i),
    })
    expect(existsSync(join(current.sessionDir, 'control.json'))).toBe(true)
    expect(existsSync(current.plan.runtimeHome)).toBe(true)
  })

  it('keeps a recovery owner after preparation failure until explicit abort cleans partial runtime', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    bundle.deps.prepareRuntime = vi.fn(async () => { throw new Error('profile install failed') })
    const running = runUiSupervisor(current.request, bundle.deps)
    void running.catch(() => undefined)

    await waitFor(() => {
      const state = readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })
      return state.state === 'crashed' && state.supervisorPid === process.pid && state.cleanup === undefined
    }, 'crashed startup recovery owner')
    writeUiControl({
      runtimeRoot: current.runtimeRoot,
      sessionId: SESSION,
      control: { schemaVersion: 1, action: 'abort', requestedAt: '2026-08-24T12:01:00.000Z' },
    })

    await expect(running).resolves.toBeUndefined()
    expect(bundle.deps.spawnChild).not.toHaveBeenCalled()
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })).toMatchObject({
      state: 'aborted',
      cleanup: 'pass',
    })
    expect(existsSync(current.plan.runtimeHome)).toBe(false)
  })

  it('bounds the live diagnostic log to the newest configured bytes', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    bundle.deps.maxLogBytes = 32
    const running = runUiSupervisor(current.request, bundle.deps)
    bundle.child.stderr.write('a'.repeat(80))
    bundle.child.stdout.write('dsh web: http://127.0.0.1:49152\n')
    const log = join(current.sessionDir, 'supervisor.log')
    await waitFor(
      () => readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).state === 'ready',
      'ready after bounded log write',
    )
    expect(existsSync(log)).toBe(true)
    expect(readFileSync(log).length).toBe(32)
    writeUiControl({
      runtimeRoot: current.runtimeRoot,
      sessionId: SESSION,
      control: { schemaVersion: 1, action: 'abort', requestedAt: '2026-08-24T12:01:00.000Z' },
    })
    await running
  })

  it('retains diagnostic runtime and marks cleanup failure without claiming terminal success', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    bundle.deps.stopChildTree = vi.fn(async () => { throw new Error('injected stop failure') })
    const running = runUiSupervisor(current.request, bundle.deps)
    bundle.child.stdout.write('dsh web: http://127.0.0.1:49152\n')
    await waitFor(() => readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).state === 'ready', 'ready')
    writeUiControl({
      runtimeRoot: current.runtimeRoot,
      sessionId: SESSION,
      control: { schemaVersion: 1, action: 'finish', requestedAt: '2026-08-24T12:01:00.000Z' },
    })
    await expect(running).rejects.toThrow(/injected stop failure|cleanup/i)
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })).toMatchObject({
      state: 'crashed',
      cleanup: 'fail',
    })
    expect(existsSync(current.plan.runtimeHome)).toBe(true)
  })

  it('turns an asynchronous diagnostic-log failure into owned cleanup failure', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    const log: UiDiagnosticLog = {
      write: vi.fn(() => { throw new Error('injected log failure') }),
      close: vi.fn(),
    }
    bundle.deps.openLog = vi.fn(() => log)
    const running = runUiSupervisor(current.request, bundle.deps)
    const fallback = setTimeout(() => {
      try {
        writeUiControl({
          runtimeRoot: current.runtimeRoot,
          sessionId: SESSION,
          control: { schemaVersion: 1, action: 'abort', requestedAt: '2026-08-24T12:01:00.000Z' },
        })
      } catch {
        // The expected failure path may already have made the lease diagnostic-only.
      }
    }, 50)
    bundle.child.stderr.write('trigger log write\n')
    await expect(running).rejects.toThrow(/log failure|diagnostic|cleanup/i)
    clearTimeout(fallback)
    expect(bundle.stopChildTree).toHaveBeenCalledTimes(1)
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })).toMatchObject({
      state: 'crashed',
      cleanup: 'fail',
    })
    expect(existsSync(current.plan.runtimeHome)).toBe(true)
  })

  it('ignores output arriving after control cleanup has taken ownership', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    bundle.deps.stopChildTree = vi.fn(async () => {
      await stopGate
      bundle.child.exit({ code: 0, signal: 'SIGTERM' })
    })
    const log: UiDiagnosticLog = { write: vi.fn(), close: vi.fn() }
    bundle.deps.openLog = vi.fn(() => log)
    const running = runUiSupervisor(current.request, bundle.deps)
    await waitFor(() => vi.mocked(bundle.deps.spawnChild).mock.calls.length === 1, 'child spawn')
    writeUiControl({
      runtimeRoot: current.runtimeRoot,
      sessionId: SESSION,
      control: { schemaVersion: 1, action: 'finish', requestedAt: '2026-08-24T12:01:00.000Z' },
    })
    await waitFor(() => vi.mocked(bundle.deps.stopChildTree).mock.calls.length === 1, 'control cleanup')
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })).toMatchObject({
      state: 'stopping',
      supervisorPid: process.pid,
      childPid: bundle.child.handle.pid,
    })
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).cleanup).toBeUndefined()
    expect(existsSync(join(current.sessionDir, 'control.json'))).toBe(true)
    bundle.child.stderr.write('late output must be ignored\n')
    releaseStop()
    await expect(running).resolves.toBeUndefined()
    expect(log.write).not.toHaveBeenCalled()
    expect(log.close).toHaveBeenCalledTimes(1)
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })).toMatchObject({
      state: 'stopping',
      cleanup: 'pass',
    })
  })

  it('lets an active diagnostic failure own cleanup ahead of a pending control', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    let releasePoll!: () => void
    let releaseStop!: () => void
    const pollGate = new Promise<void>(resolve => { releasePoll = resolve })
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    bundle.deps.sleep = vi.fn(() => pollGate)
    bundle.deps.stopChildTree = vi.fn(async () => {
      await stopGate
      bundle.child.exit({ code: 0, signal: 'SIGTERM' })
    })
    const log: UiDiagnosticLog = {
      write: vi.fn(() => { throw new Error('active log failure') }),
      close: vi.fn(),
    }
    bundle.deps.openLog = vi.fn(() => log)
    const running = runUiSupervisor(current.request, bundle.deps)
    await waitFor(() => vi.mocked(bundle.deps.sleep).mock.calls.length === 1, 'poll wait')
    bundle.child.stderr.write('trigger active failure\n')
    await waitFor(() => vi.mocked(bundle.deps.stopChildTree).mock.calls.length === 1, 'diagnostic cleanup')
    writeUiControl({
      runtimeRoot: current.runtimeRoot,
      sessionId: SESSION,
      control: { schemaVersion: 1, action: 'finish', requestedAt: '2026-08-24T12:01:00.000Z' },
    })
    releasePoll()
    await new Promise(resolve => setTimeout(resolve, 10))
    releaseStop()
    await expect(running).rejects.toThrow(/active log failure|diagnostic/i)
    expect(bundle.deps.stopChildTree).toHaveBeenCalledTimes(1)
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })).toMatchObject({
      state: 'crashed',
      cleanup: 'fail',
    })
    expect(existsSync(current.plan.runtimeHome)).toBe(true)
  })

  it('stops an owned child when lease publication fails immediately after spawn', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    bundle.deps.spawnChild = vi.fn(() => {
      writeFileSync(join(current.sessionDir, 'state.json'), '{corrupt')
      return bundle.child.handle
    })
    await expect(runUiSupervisor(current.request, bundle.deps)).rejects.toThrow(/state|json|corrupt/i)
    expect(bundle.deps.stopChildTree).toHaveBeenCalledWith(bundle.child.handle)
    expect(bundle.deps.stopChildTree).toHaveBeenCalledTimes(1)
    expect(existsSync(current.plan.runtimeHome)).toBe(true)
  })

  it('records cleanup failure when recovery cannot stop a child after a post-spawn setup error', async () => {
    const current = fixture()
    const bundle = dependencies(current.plan)
    bundle.deps.spawnChild = vi.fn(() => ({ ...bundle.child.handle, pid: 0 }))
    bundle.deps.stopChildTree = vi.fn(async () => { throw new Error('post-spawn tree cleanup failed') })

    await expect(runUiSupervisor(current.request, bundle.deps)).rejects.toThrow(/pid|cleanup|tree/i)

    expect(bundle.deps.stopChildTree).toHaveBeenCalledTimes(1)
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })).toMatchObject({
      state: 'crashed',
      supervisorPid: process.pid,
      cleanup: 'fail',
      error: expect.stringMatching(/post-spawn|tree|cleanup|stop/i),
    })
    expect(existsSync(current.plan.runtimeHome)).toBe(true)
  })

  it('keeps concurrent supervisors and controls session-local', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-lab-ui-supervisor-pair-'))
    roots.push(root)
    const make = (sessionId: string, port: number) => {
      const current = fixture(sessionId, root)
      const bundle = dependencies(current.plan, fakeChild(port))
      return { current, bundle, running: runUiSupervisor(current.request, bundle.deps) }
    }
    const left = make(SESSION, 5001)
    const right = make(OTHER, 5002)
    left.bundle.child.stdout.write('dsh web: http://127.0.0.1:49151\n')
    right.bundle.child.stdout.write('dsh web: http://127.0.0.1:49152\n')
    await Promise.all([
      waitFor(() => readUiSession({ runtimeRoot: left.current.runtimeRoot, sessionId: SESSION }).state === 'ready', 'left ready'),
      waitFor(() => readUiSession({ runtimeRoot: right.current.runtimeRoot, sessionId: OTHER }).state === 'ready', 'right ready'),
    ])
    for (const item of [left, right]) {
      writeUiControl({
        runtimeRoot: item.current.runtimeRoot,
        sessionId: item.current.request.sessionId,
        control: { schemaVersion: 1, action: 'abort', requestedAt: '2026-08-24T12:01:00.000Z' },
      })
    }
    await Promise.all([left.running, right.running])
    expect(left.bundle.stopChildTree).toHaveBeenCalledWith(left.bundle.child.handle)
    expect(right.bundle.stopChildTree).toHaveBeenCalledWith(right.bundle.child.handle)
  })
})
