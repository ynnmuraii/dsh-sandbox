import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createDevSessionId,
  createOwnedDevSession,
  readDevSession,
  writeDevSession,
  writeDevSessionRequest,
  writeDevControl,
  readDevControl,
  clearDevControl,
  canTransition,
  latchDevRestartReasons,
  viewFromDevState,
  validateDevSessionId,
  type DevSessionStateV1,
} from './dev-session-state.js'
import { digestString } from './dev-restart-baseline.js'

const SESSION = 'dev-20260824T120000000Z-a1b2c3d4'

function state(overrides: Partial<DevSessionStateV1> = {}): DevSessionStateV1 {
  return {
    schemaVersion: 1,
    sessionId: SESSION,
    state: 'starting',
    plugin: { packageName: '@f/x', sourcePath: 'A:/p', runtimeName: 'x' },
    target: { name: 'next', dsh: '0.1.1-rc.2' },
    restartBaseline: {
      pluginManifest: digestString('a'),
      pluginMetadata: digestString('b'),
      targetPin: digestString('c'),
      sourceTree: digestString('src'),
    },
    restartHash: digestString('d'),
    restartRequired: false,
    startedAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:00.000Z',
    ...overrides,
  }
}

describe('dev session id', () => {
  it('creates the exact portable ID from UTC time and eight lowercase hex digits', () => {
    expect(createDevSessionId(new Date('2026-08-24T12:00:00.000Z'), () => 'a1b2c3d4')).toBe(SESSION)
  })
  it('rejects an unsafe id', () => {
    expect(() => validateDevSessionId('../../etc')).toThrow(/invalid|unsafe/i)
  })
})

describe('dev session transitions (tombstone semantics)', () => {
  it('allows every non-terminal edge and forbids leaving stopped', () => {
    expect(canTransition('starting', 'ready')).toBe(true)
    expect(canTransition('starting', 'stopping')).toBe(true)
    expect(canTransition('ready', 'crashed')).toBe(true)
    expect(canTransition('stopping', 'stopped')).toBe(true)
    expect(canTransition('stopping', 'crashed')).toBe(true)
    expect(canTransition('stopped', 'ready')).toBe(false)
    expect(canTransition('ready', 'starting')).toBe(false)
  })
})

describe('dev session validation (target and timestamps)', () => {
  let root: string
  let runtimeRoot: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-devstate-'))
    runtimeRoot = join(root, '.lab', 'runtime')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('rejects an unknown target name', () => {
    const bad = state({ target: { name: 'other', x: 1 } as unknown as DevSessionStateV1['target'] })
    expect(() => createOwnedDevSession({ runtimeRoot, state: bad })).toThrow(/target/i)
  })
  it('rejects a missing target', () => {
    const bad = { ...state(), target: undefined } as unknown as DevSessionStateV1
    expect(() => createOwnedDevSession({ runtimeRoot, state: bad })).toThrow(/target/i)
  })
  it('rejects a master commit that is not 40 lowercase hex chars', () => {
    const bad = state({ target: { name: 'master', commit: 'not-a-commit' } })
    expect(() => createOwnedDevSession({ runtimeRoot, state: bad })).toThrow(/commit/i)
  })
  it('rejects an empty next dsh', () => {
    const bad = state({ target: { name: 'next', dsh: '   ' } })
    expect(() => createOwnedDevSession({ runtimeRoot, state: bad })).toThrow(/dsh|non-empty|target/i)
  })
  it('rejects a non-ISO startedAt', () => {
    const bad = state({ startedAt: 'not-a-date' })
    expect(() => createOwnedDevSession({ runtimeRoot, state: bad })).toThrow(/ISO|timestamp|startedAt/i)
  })
  it('rejects a non-ISO updatedAt', () => {
    const bad = state({ updatedAt: 'also-not-a-date' })
    expect(() => createOwnedDevSession({ runtimeRoot, state: bad })).toThrow(/ISO|timestamp|updatedAt/i)
  })
  it('rejects updatedAt earlier than startedAt', () => {
    const bad = state({ startedAt: '2026-08-24T12:00:05.000Z', updatedAt: '2026-08-24T12:00:00.000Z' })
    expect(() => createOwnedDevSession({ runtimeRoot, state: bad })).toThrow(/earlier|backward|updatedAt/i)
  })
  it('rejects a non-ISO latch now', () => {
    const s = state({ state: 'ready', supervisorPid: 12, childPid: 34, url: 'http://127.0.0.1:49152' })
    expect(() => latchDevRestartReasons(s, ['plugin-manifest'], 'not-a-time')).toThrow(/ISO|timestamp|now/i)
  })
})

describe('dev session store', () => {
  let root: string
  let runtimeRoot: string
  let outside: string | undefined
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-devstate-'))
    runtimeRoot = join(root, '.lab', 'runtime')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    if (outside !== undefined) rmSync(outside, { recursive: true, force: true })
  })

  it('creates the session dir exclusively, then reads back the same state', () => {
    const { sessionDir, ownedSession } = createOwnedDevSession({ runtimeRoot, state: state() })
    ownedSession.assertCurrent()
    expect(existsSync(join(sessionDir, 'state.json'))).toBe(true)
    expect(readDevSession({ runtimeRoot, sessionId: SESSION }).sessionId).toBe(SESSION)
  })

  it('writes a stop control, reads it, and clears it', () => {
    const { ownedSession } = createOwnedDevSession({ runtimeRoot, state: state() })
    writeDevControl({ runtimeRoot, sessionId: SESSION, control: { schemaVersion: 1, action: 'stop', requestedAt: '2026-08-24T12:00:01.000Z' }, ownedSession })
    expect(readDevControl({ runtimeRoot, sessionId: SESSION })?.action).toBe('stop')
    clearDevControl({ runtimeRoot, sessionId: SESSION, ownedSession })
    expect(readDevControl({ runtimeRoot, sessionId: SESSION })).toBeUndefined()
  })

  it('latches restart reasons and never shrinks them', () => {
    const s = state({ state: 'ready', supervisorPid: 12, childPid: 34, url: 'http://127.0.0.1:49152' })
    const latched = latchDevRestartReasons(s, ['plugin-manifest'], '2026-08-24T12:00:02.000Z')
    expect(latched.restartRequired).toBe(true)
    expect(latched.restartReasons).toEqual(['plugin-manifest'])
    const again = latchDevRestartReasons(latched, ['plugin-metadata'], '2026-08-24T12:00:03.000Z')
    expect(again.restartReasons).toEqual(['plugin-manifest', 'plugin-metadata'])
  })

  it('keeps a stopped session compact (no url/pids/error) and immutable', () => {
    const stopped = state({ state: 'stopped', cleanup: 'pass' })
    const { ownedSession } = createOwnedDevSession({ runtimeRoot, state: stopped })
    expect(() => writeDevSession({ runtimeRoot, ownedSession, state: { ...stopped, updatedAt: '2026-08-24T12:00:05.000Z' } })).toThrow(/immutable/)
  })

  it('writes a session request file and returns its path', () => {
    const { ownedSession } = createOwnedDevSession({ runtimeRoot, state: state() })
    const requestPath = writeDevSessionRequest({ runtimeRoot, sessionId: SESSION, request: { schemaVersion: 1, sessionId: SESSION }, ownedSession })
    expect(requestPath).toBe(join(runtimeRoot, 'dev-sessions', SESSION, 'request.json'))
    expect(existsSync(requestPath)).toBe(true)
  })

  it('omits a clean url from the view once a restart is latched', () => {
    const clean = state({ state: 'ready', supervisorPid: 12, childPid: 34, url: 'http://127.0.0.1:49152' })
    expect(viewFromDevState(clean).url).toBe('http://127.0.0.1:49152')
    const latched = latchDevRestartReasons(clean, ['plugin-manifest'], '2026-08-24T12:00:02.000Z')
    const view = viewFromDevState(latched)
    expect(view.restartRequired).toBe(true)
    expect(view.restartReasons).toEqual(['plugin-manifest'])
    expect(view.url).toBeUndefined()
    expect(view.restartHash).toBe(clean.restartHash)
    expect(view.orphan).toBeUndefined()
  })

  it('does not create a session outside the runtime root when dev-sessions is a symlink', () => {
    outside = mkdtempSync(join(tmpdir(), 'dsh-devstate-outside-'))
    mkdirSync(runtimeRoot, { recursive: true })
    const sessionsRoot = join(runtimeRoot, 'dev-sessions')
    symlinkSync(outside, sessionsRoot, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => createOwnedDevSession({ runtimeRoot, state: state() })).toThrow(/symlink|junction|escape|unsafe/i)
    expect(readdirSync(outside)).toEqual([])
  })
})
