import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  clearUiControl,
  createUiSession,
  createUiSessionId,
  latchUiStaleReasons,
  readUiControl,
  readUiSession,
  writeUiControl,
  writeUiSession,
  type UiControlV1,
  type UiSessionStateV1,
} from './ui-session.js'

const roots: string[] = []
const SESSION = 'ui-20260824T120000000Z-a1b2c3d4'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runtimeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lab-ui-session-'))
  roots.push(root)
  return root
}

function state(overrides: Partial<UiSessionStateV1> = {}): UiSessionStateV1 {
  return {
    schemaVersion: 1,
    sessionId: SESSION,
    state: 'starting',
    plugin: {
      packageName: '@fixture/session',
      sourcePath: 'A:/plugins/session',
      digest: `sha256:${'1'.repeat(64)}`,
    },
    target: { name: 'next', dsh: '0.1.1-rc.2' },
    contextDigest: `sha256:${'2'.repeat(64)}`,
    startedAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:00.000Z',
    ...overrides,
  }
}

describe('UI session identity', () => {
  it('creates the exact portable ID from UTC time and eight lowercase hex digits', () => {
    expect(createUiSessionId(
      new Date('2026-08-24T12:00:00.000Z'),
      () => 'a1b2c3d4',
    )).toBe(SESSION)
  })

  it.each([
    '',
    '.',
    '..',
    '../escape',
    '..\\escape',
    '/absolute',
    'ui-20260824T120000000Z-A1B2C3D4',
    'ui-20260824T120000000Z-a1b2c3',
    'ui-20260824T120000000Z-a1b2c3d4/child',
    'ＣＯＮ',
  ])('rejects unsafe session ID %j without creating a path', sessionId => {
    const root = runtimeRoot()
    expect(() => createUiSession({ runtimeRoot: root, state: state({ sessionId }) })).toThrow(
      /sessionId|invalid|unsafe/i,
    )
    expect(readdirSync(root)).toEqual([])
  })
})

describe('UI session store', () => {
  it('exclusively creates and round-trips an exact starting lease', () => {
    const root = runtimeRoot()
    const value = state()
    const directory = createUiSession({ runtimeRoot: root, state: value })

    expect(directory).toBe(join(root, 'ui-sessions', SESSION))
    expect(readUiSession({ runtimeRoot: root, sessionId: SESSION })).toEqual(value)
    expect(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))).toEqual(value)
    expect(readdirSync(directory)).toEqual(['state.json'])
    expect(() => createUiSession({ runtimeRoot: root, state: value })).toThrow(/exist|already|session/i)
  })

  it('rejects unknown and invalid fields at every lease level', () => {
    const root = runtimeRoot()
    const cases: unknown[] = [
      { ...state(), extra: true },
      { ...state(), schemaVersion: 2 },
      { ...state(), plugin: { ...state().plugin, token: 'secret' } },
      { ...state(), target: { name: 'next', commit: '1'.repeat(40) } },
      { ...state(), contextDigest: 'sha256:ABC' },
      { ...state(), updatedAt: 'not-a-date' },
      { ...state(), updatedAt: '2026-08-24T11:59:59.000Z' },
    ]
    for (const value of cases) {
      expect(() => createUiSession({ runtimeRoot: root, state: value as UiSessionStateV1 })).toThrow()
      expect(existsSync(join(root, 'ui-sessions')) ? readdirSync(join(root, 'ui-sessions')) : []).toEqual([])
    }
  })

  it('enforces phase-specific process, URL, error, and cleanup fields', () => {
    const root = runtimeRoot()
    const invalid: UiSessionStateV1[] = [
      state({ state: 'ready' }),
      state({ state: 'ready', supervisorPid: 10, childPid: 11, url: 'http://0.0.0.0:8000' }),
      state({ state: 'ready', supervisorPid: 0, childPid: 11, url: 'http://127.0.0.1:8000' }),
      state({ state: 'crashed' }),
      state({ state: 'finished', cleanup: 'pass', supervisorPid: 10 }),
      state({ state: 'aborted', cleanup: 'pass', url: 'http://127.0.0.1:8000' }),
      state({ state: 'finished' }),
    ]
    for (const value of invalid) {
      expect(() => createUiSession({ runtimeRoot: root, state: value })).toThrow(/state|pid|url|error|cleanup/i)
      expect(existsSync(join(root, 'ui-sessions')) ? readdirSync(join(root, 'ui-sessions')) : []).toEqual([])
    }

    expect(() => createUiSession({
      runtimeRoot: root,
      state: state({
        state: 'ready',
        supervisorPid: 10,
        childPid: 11,
        url: 'http://127.0.0.1:49152',
        updatedAt: '2026-08-24T12:00:01.000Z',
      }),
    })).not.toThrow()
  })

  it('allows only monotonic lifecycle transitions and identical terminal rewrites', () => {
    const root = runtimeRoot()
    createUiSession({ runtimeRoot: root, state: state() })
    const ready = state({
      state: 'ready',
      supervisorPid: 10,
      childPid: 11,
      url: 'http://127.0.0.1:49152',
      updatedAt: '2026-08-24T12:00:01.000Z',
    })
    writeUiSession({ runtimeRoot: root, state: ready })
    expect(() => writeUiSession({ runtimeRoot: root, state: state({ updatedAt: '2026-08-24T12:00:02.000Z' }) })).toThrow(
      /transition|ready.*starting/i,
    )
    const stopping = state({
      state: 'stopping',
      cleanup: 'pass',
      updatedAt: '2026-08-24T12:00:02.000Z',
    })
    writeUiSession({ runtimeRoot: root, state: stopping })
    const finished = state({
      state: 'finished',
      cleanup: 'pass',
      updatedAt: '2026-08-24T12:00:03.000Z',
    })
    writeUiSession({ runtimeRoot: root, state: finished })
    expect(() => writeUiSession({ runtimeRoot: root, state: { ...finished, updatedAt: '2026-08-24T12:00:04.000Z' } })).toThrow(
      /terminal|immutable|transition/i,
    )
    expect(() => writeUiSession({ runtimeRoot: root, state: finished })).not.toThrow()
  })

  it('latches, deduplicates, and sorts stale reasons irreversibly', () => {
    const current = state()
    const stale = latchUiStaleReasons(
      current,
      ['target-changed', 'plugin-changed', 'target-changed'],
      '2026-08-24T12:00:01.000Z',
    )
    expect(stale.staleReasons).toEqual(['plugin-changed', 'target-changed'])
    expect(latchUiStaleReasons(stale, [], '2026-08-24T12:00:02.000Z').staleReasons).toEqual(
      ['plugin-changed', 'target-changed'],
    )
    expect(current).not.toHaveProperty('staleReasons')
  })

  it('rejects direct state writes that remove an already-latched stale reason', () => {
    const root = runtimeRoot()
    const stale = state({ staleReasons: ['plugin-changed'] })
    createUiSession({ runtimeRoot: root, state: stale })

    expect(() => writeUiSession({
      runtimeRoot: root,
      state: state({
        state: 'ready',
        supervisorPid: 10,
        childPid: 11,
        url: 'http://127.0.0.1:49152',
        updatedAt: '2026-08-24T12:00:01.000Z',
      }),
    })).toThrow(/stale|latched|plugin-changed|remove/i)

    expect(readUiSession({ runtimeRoot: root, sessionId: SESSION }).staleReasons).toEqual([
      'plugin-changed',
    ])
  })

  it('writes, reads, rejects replacement, and explicitly clears exact controls', () => {
    const root = runtimeRoot()
    createUiSession({ runtimeRoot: root, state: state() })
    const control: UiControlV1 = {
      schemaVersion: 1,
      action: 'finish',
      requestedAt: '2026-08-24T12:01:00.000Z',
    }
    writeUiControl({ runtimeRoot: root, sessionId: SESSION, control })
    expect(readUiControl({ runtimeRoot: root, sessionId: SESSION })).toEqual(control)
    expect(() => writeUiControl({
      runtimeRoot: root,
      sessionId: SESSION,
      control: { ...control, action: 'abort' },
    })).toThrow(/exist|control|pending/i)
    clearUiControl({ runtimeRoot: root, sessionId: SESSION })
    expect(readUiControl({ runtimeRoot: root, sessionId: SESSION })).toBeUndefined()
  })

  it('refuses to clear corrupt control content and preserves it for diagnosis', () => {
    const root = runtimeRoot()
    const directory = createUiSession({ runtimeRoot: root, state: state() })
    const path = join(directory, 'control.json')
    writeFileSync(path, '{broken')

    expect(() => clearUiControl({ runtimeRoot: root, sessionId: SESSION })).toThrow(
      new RegExp(escapeRegex(path)),
    )
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })

  it('reports corrupt JSON with its exact path and never creates an unknown session', () => {
    const root = runtimeRoot()
    const unknown = 'ui-20260824T120000000Z-deadbeef'
    expect(() => readUiSession({ runtimeRoot: root, sessionId: unknown })).toThrow(/unknown|not found/i)
    expect(readdirSync(root)).toEqual([])

    const path = join(root, 'ui-sessions', SESSION, 'state.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{broken')
    expect(() => readUiSession({ runtimeRoot: root, sessionId: SESSION })).toThrow(
      new RegExp(escapeRegex(path)),
    )
  })

  it('rejects a symlinked session directory for reads and writes', () => {
    const root = runtimeRoot()
    const outside = runtimeRoot()
    const sessionDirectory = join(root, 'ui-sessions', SESSION)
    mkdirSync(dirname(sessionDirectory), { recursive: true })
    symlinkSync(outside, sessionDirectory, process.platform === 'win32' ? 'junction' : 'dir')

    expect(() => createUiSession({ runtimeRoot: root, state: state() })).toThrow(/symlink|junction|escape/i)
    expect(() => readUiSession({ runtimeRoot: root, sessionId: SESSION })).toThrow(/symlink|junction|escape/i)
    expect(readdirSync(outside)).toEqual([])
  })
})

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
