import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUiSession, readUiSession, type UiSessionStateV1 } from './ui-session.js'
import { runSupervisorBin, type UiSupervisorBinDependencies } from './ui-supervisor-bin.js'
import type { UiSupervisorRequestV1 } from './ui-supervisor.js'

const roots: string[] = []
const SESSION = 'ui-20260824T120000000Z-a1b2c3d4'

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lab-ui-supervisor-bin-'))
  roots.push(root)
  const runtimeRoot = join(root, '.lab', 'runtime')
  const state: UiSessionStateV1 = {
    schemaVersion: 1,
    sessionId: SESSION,
    state: 'starting',
    plugin: {
      packageName: '@fixture/supervisor-bin',
      sourcePath: join(root, 'plugin'),
      digest: `sha256:${'1'.repeat(64)}`,
    },
    target: { name: 'next', dsh: '0.1.1-rc.2' },
    contextDigest: `sha256:${'2'.repeat(64)}`,
    startedAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:00.000Z',
  }
  const sessionDir = createUiSession({ runtimeRoot, state })
  const request: UiSupervisorRequestV1 = {
    schemaVersion: 1,
    root,
    sessionId: SESSION,
    plugin: {
      packageName: state.plugin.packageName,
      sourcePath: state.plugin.sourcePath,
      runtimeName: 'supervisor-bin',
    },
    target: 'next',
    startedAt: state.startedAt,
  }
  const requestPath = join(sessionDir, 'request.json')
  writeFileSync(requestPath, JSON.stringify(request))
  return { root, runtimeRoot, request, requestPath }
}

function dependencies(runSupervisor = vi.fn(async () => {})): UiSupervisorBinDependencies {
  return {
    runSupervisor,
    stderr: vi.fn(),
    now: () => '2026-08-24T12:00:01.000Z',
  }
}

describe('runSupervisorBin', () => {
  it('runs one exact contained request without accepting command or environment fields', async () => {
    const current = fixture()
    const deps = dependencies()
    await expect(runSupervisorBin([current.requestPath], deps)).resolves.toBe(0)
    expect(deps.runSupervisor).toHaveBeenCalledWith(current.request)
    expect(deps.stderr).not.toHaveBeenCalled()

    writeFileSync(current.requestPath, JSON.stringify({ ...current.request, env: { SECRET: 'nope' } }))
    await expect(runSupervisorBin([current.requestPath], deps)).resolves.toBe(1)
    expect(deps.runSupervisor).toHaveBeenCalledTimes(1)
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringMatching(/unexpected|env|request/i))
  })

  it('rejects a valid-looking request outside its owned session path before execution', async () => {
    const current = fixture()
    const outside = join(current.root, 'outside-request.json')
    writeFileSync(outside, JSON.stringify(current.request))
    const deps = dependencies()
    await expect(runSupervisorBin([outside], deps)).resolves.toBe(1)
    expect(deps.runSupervisor).not.toHaveBeenCalled()
    expect(readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION }).state).toBe('starting')
  })

  it('rejects a regular request-file replacement between inspection and descriptor open', async () => {
    const current = fixture()
    const parked = `${current.requestPath}.parked`
    const forged = {
      ...current.request,
      plugin: { ...current.request.plugin, sourcePath: join(current.root, 'forged-plugin') },
    }
    let seamCalled = false
    const deps = {
      ...dependencies(),
      beforeRequestOpen(path: string) {
        seamCalled = true
        expect(path).toBe(current.requestPath)
        renameSync(current.requestPath, parked)
        writeFileSync(current.requestPath, JSON.stringify(forged))
      },
    } as UiSupervisorBinDependencies & { beforeRequestOpen(path: string): void }

    await expect(runSupervisorBin([current.requestPath], deps)).resolves.toBe(1)
    expect(seamCalled).toBe(true)
    expect(deps.runSupervisor).not.toHaveBeenCalled()
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringMatching(/identity|changed|replaced|request|refus/i))
  })

  it('retains the request parent identity from reading through session-owner claim', async () => {
    const current = fixture()
    const sessionDir = join(current.runtimeRoot, 'ui-sessions', SESSION)
    const parked = `${sessionDir}.request-read-parked`
    const replacementState = readFileSync(join(sessionDir, 'state.json'))
    let seamCalled = false
    const deps = {
      ...dependencies(),
      afterRequestRead(path: string) {
        seamCalled = true
        expect(path).toBe(current.requestPath)
        renameSync(sessionDir, parked)
        mkdirSync(sessionDir)
        writeFileSync(join(sessionDir, 'state.json'), replacementState)
        writeFileSync(join(sessionDir, 'request.json'), JSON.stringify(current.request))
        writeFileSync(join(sessionDir, 'replacement-canary.txt'), 'replacement')
      },
    } as UiSupervisorBinDependencies & { afterRequestRead(path: string): void }

    await expect(runSupervisorBin([current.requestPath], deps)).resolves.toBe(1)
    expect(seamCalled).toBe(true)
    expect(deps.runSupervisor).not.toHaveBeenCalled()
    expect(readFileSync(join(sessionDir, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringMatching(/identity|changed|replacement|request|session|refus/i))
  })

  it('does not reacquire a replacement after the pinned request reader returns', async () => {
    const current = fixture()
    const sessionDir = join(current.runtimeRoot, 'ui-sessions', SESSION)
    const parked = `${sessionDir}.before-owner-claim-parked`
    const replacementState = readFileSync(join(sessionDir, 'state.json'))
    let seamCalled = false
    const deps = {
      ...dependencies(),
      beforeSessionOwnerClaim(path: string) {
        seamCalled = true
        expect(path).toBe(sessionDir)
        renameSync(sessionDir, parked)
        mkdirSync(sessionDir)
        writeFileSync(join(sessionDir, 'state.json'), replacementState)
        writeFileSync(join(sessionDir, 'request.json'), JSON.stringify(current.request))
        writeFileSync(join(sessionDir, 'replacement-canary.txt'), 'replacement')
      },
    } as UiSupervisorBinDependencies & { beforeSessionOwnerClaim(path: string): void }

    await expect(runSupervisorBin([current.requestPath], deps)).resolves.toBe(1)
    expect(seamCalled).toBe(true)
    expect(deps.runSupervisor).not.toHaveBeenCalled()
    expect(readFileSync(join(sessionDir, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringMatching(/identity|changed|replacement|request|session|refus/i))
  })

  it('reports an execution failure into only the safely matched lease', async () => {
    const current = fixture()
    const deps = dependencies(vi.fn(async () => { throw new Error('injected supervisor failure\nSECRET') }))
    await expect(runSupervisorBin([current.requestPath], deps)).resolves.toBe(1)
    const failed = readUiSession({ runtimeRoot: current.runtimeRoot, sessionId: SESSION })
    expect(failed).toMatchObject({ state: 'crashed', error: 'injected supervisor failure SECRET' })
    expect(failed).not.toHaveProperty('cleanup')
    expect(deps.stderr).toHaveBeenCalledWith('ui supervisor: injected supervisor failure SECRET')
  })

  it('does not report a supervisor failure into a same-name replacement lease', async () => {
    const current = fixture()
    const sessionDir = join(current.runtimeRoot, 'ui-sessions', SESSION)
    const parked = `${sessionDir}.parked`
    const replacementState = readFileSync(join(sessionDir, 'state.json'))
    const deps = dependencies(vi.fn(async () => {
      renameSync(sessionDir, parked)
      mkdirSync(sessionDir)
      writeFileSync(join(sessionDir, 'state.json'), replacementState)
      writeFileSync(join(sessionDir, 'replacement-canary.txt'), 'replacement')
      throw new Error('supervisor rejected changed session identity')
    }))

    await expect(runSupervisorBin([current.requestPath], deps)).resolves.toBe(1)

    expect(readFileSync(join(sessionDir, 'state.json'))).toEqual(replacementState)
    expect(readFileSync(join(sessionDir, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringMatching(/identity|changed|supervisor/i))
  })

  it('does not reacquire a replacement between the retained bin guard and failure-state write', async () => {
    const current = fixture()
    const sessionDir = join(current.runtimeRoot, 'ui-sessions', SESSION)
    const parked = `${sessionDir}.failure-write-parked`
    const replacementState = readFileSync(join(sessionDir, 'state.json'))
    const beforeFailureWrite = vi.fn(() => {
      renameSync(sessionDir, parked)
      mkdirSync(sessionDir)
      writeFileSync(join(sessionDir, 'state.json'), replacementState)
      writeFileSync(join(sessionDir, 'replacement-canary.txt'), 'replacement')
    })
    const deps = {
      ...dependencies(vi.fn(async () => { throw new Error('injected supervisor failure') })),
      beforeFailureWrite,
    } as UiSupervisorBinDependencies & { beforeFailureWrite(): void }

    await expect(runSupervisorBin([current.requestPath], deps)).resolves.toBe(1)

    expect(beforeFailureWrite).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(sessionDir, 'state.json'))).toEqual(replacementState)
    expect(readFileSync(join(sessionDir, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(existsSync(join(sessionDir, '.state.lock'))).toBe(false)
  })
})
