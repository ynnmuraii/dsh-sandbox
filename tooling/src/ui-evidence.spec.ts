import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pluginEvidenceKey } from './evidence.js'
import {
  loadUiResults,
  normalizeUiSummary,
  publishUiResult,
  type UiResultV1,
} from './ui-evidence.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function uiRunsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lab-ui-evidence-'))
  roots.push(root)
  return root
}

function result(overrides: Partial<UiResultV1> = {}): UiResultV1 {
  return {
    schemaVersion: 1,
    sessionId: 'ui-20260824T120000000Z-a1b2c3d4',
    operation: 'ui',
    verdict: 'pass',
    plugin: {
      packageName: '@scope/plugin',
      sourcePath: 'A:/plugins/plugin',
      digest: `sha256:${'1'.repeat(64)}`,
    },
    target: { name: 'next', dsh: '0.1.1-rc.2' },
    lab: { contextDigest: `sha256:${'2'.repeat(64)}` },
    summary: 'Conversation renders and input remains usable.',
    cleanup: 'pass',
    startedAt: '2026-08-24T12:00:00.000Z',
    finishedAt: '2026-08-24T12:01:00.000Z',
    ...overrides,
  }
}

describe('normalizeUiSummary', () => {
  it('trims ordinary outer whitespace without rewriting valid plain text', () => {
    expect(normalizeUiSummary('  Conversation renders and input remains usable.  ')).toBe(
      'Conversation renders and input remains usable.',
    )
  })

  it('counts Unicode code points and rejects empty, control, and overlong input', () => {
    expect(normalizeUiSummary('🙂'.repeat(500))).toBe('🙂'.repeat(500))
    expect(() => normalizeUiSummary('🙂'.repeat(501))).toThrow(/500|summary.*long/i)
    expect(() => normalizeUiSummary('   ')).toThrow(/summary.*empty|1.*500/i)
    expect(() => normalizeUiSummary('line\nbreak')).toThrow(/control|single.line|summary/i)
    expect(() => normalizeUiSummary('tab\tbreak')).toThrow(/control|single.line|summary/i)
    expect(() => normalizeUiSummary(`c1-${String.fromCharCode(0x85)}`)).toThrow(/control|summary/i)
  })
})

describe('publishUiResult', () => {
  it('retains the evidence session identity before publication-lock creation', () => {
    const root = uiRunsRoot()
    const value = result()
    const directory = join(root, pluginEvidenceKey(value.plugin), value.sessionId)
    const parked = `${directory}.parked`

    expect(() => publishUiResult({
      uiRunsRoot: root,
      result: value,
      beforeLockCreate(lockPath: string) {
        expect(lockPath).toBe(join(directory, '.publication.lock'))
        renameSync(directory, parked)
        mkdirSync(directory)
        writeFileSync(join(directory, 'replacement-canary.txt'), 'replacement')
      },
    })).toThrow(/identity|changed|swap|ownership|refus/i)

    expect(readFileSync(join(directory, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(existsSync(join(directory, '.publication.lock'))).toBe(false)
    expect(existsSync(join(parked, '.publication.lock'))).toBe(false)
  })

  it('retains the evidence session identity before temporary evidence creation', () => {
    const root = uiRunsRoot()
    const value = result()
    const directory = join(root, pluginEvidenceKey(value.plugin), value.sessionId)
    const parked = `${directory}.parked`
    const temporary = `${value.sessionId}.tmp`

    expect(() => publishUiResult({
      uiRunsRoot: root,
      result: value,
      beforeTemporaryWrite(path: string) {
        expect(path).toBe(join(directory, temporary))
        renameSync(directory, parked)
        mkdirSync(directory)
        writeFileSync(join(directory, 'replacement-canary.txt'), 'replacement')
      },
    })).toThrow(/identity|changed|swap|ownership|refus/i)

    expect(readFileSync(join(directory, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
    expect(existsSync(join(directory, temporary))).toBe(false)
    expect(existsSync(join(parked, '.publication.lock'))).toBe(true)
  })

  it('round-trips the exact minimal schema with a final newline at the stable path', () => {
    const root = uiRunsRoot()
    const value = result()

    const path = publishUiResult({ uiRunsRoot: root, result: value })

    expect(path).toBe(join(root, pluginEvidenceKey(value.plugin), value.sessionId, 'result.json'))
    expect(basename(path)).toBe('result.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(value)
    expect(readFileSync(path, 'utf8')).toMatch(/\n$/)
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object).sort()).toEqual([
      'cleanup',
      'finishedAt',
      'lab',
      'operation',
      'plugin',
      'schemaVersion',
      'sessionId',
      'startedAt',
      'summary',
      'target',
      'verdict',
    ])
  })

  it.each([
    ['schema version', { schemaVersion: 2 }, /schemaVersion/i],
    ['session id', { sessionId: '../escape' }, /sessionId/i],
    ['operation', { operation: 'verify' }, /operation/i],
    ['verdict', { verdict: 'maybe' }, /verdict/i],
    ['plugin digest', { plugin: { ...result().plugin, digest: 'sha256:ABC' } }, /digest/i],
    ['context digest', { lab: { contextDigest: 'sha256:ABC' } }, /contextDigest/i],
    ['next target shape', { target: { name: 'next', commit: '1'.repeat(40) } }, /target|dsh|commit/i],
    ['master target shape', { target: { name: 'master', dsh: '0.1.1' } }, /target|dsh|commit/i],
    ['cleanup', { cleanup: 'fail' }, /cleanup/i],
    ['started timestamp', { startedAt: 'not-a-date' }, /startedAt/i],
    ['finished timestamp', { finishedAt: 'not-a-date' }, /finishedAt/i],
    [
      'timestamp order',
      { startedAt: '2026-08-24T12:02:00.000Z', finishedAt: '2026-08-24T12:01:00.000Z' },
      /finishedAt|chronolog|before/i,
    ],
    [
      'cross-hour timestamp order',
      { startedAt: '2026-08-24T13:00:00.000Z', finishedAt: '2026-08-24T12:01:00.000Z' },
      /finishedAt|chronolog|before/i,
    ],
  ] as const)('rejects invalid %s', (_label, override, message) => {
    expect(() => publishUiResult({
      uiRunsRoot: uiRunsRoot(),
      result: result(override as unknown as Partial<UiResultV1>),
    })).toThrow(message)
  })

  it.each([
    'url',
    'pid',
    'environment',
    'screenshots',
    'dom',
    'trace',
    'video',
    'browserScript',
    'credentials',
  ])('rejects forbidden or unknown top-level field %s', field => {
    const value = { ...result(), [field]: field === 'screenshots' ? ['shot.png'] : 'secret' }
    expect(() => publishUiResult({ uiRunsRoot: uiRunsRoot(), result: value as UiResultV1 })).toThrow(
      new RegExp(`unexpected.*${field}|${field}.*unexpected`, 'i'),
    )
  })

  it('rejects unknown nested fields instead of creating an extension bag', () => {
    const withPluginLeak = result() as UiResultV1 & { plugin: UiResultV1['plugin'] & { token: string } }
    withPluginLeak.plugin.token = 'secret'
    expect(() => publishUiResult({ uiRunsRoot: uiRunsRoot(), result: withPluginLeak })).toThrow(
      /plugin.*token|unexpected.*token/i,
    )

    const withTargetLeak = result() as UiResultV1 & { target: UiResultV1['target'] & { url: string } }
    withTargetLeak.target.url = 'http://127.0.0.1:9000'
    expect(() => publishUiResult({ uiRunsRoot: uiRunsRoot(), result: withTargetLeak })).toThrow(
      /target.*url|unexpected.*url/i,
    )
  })

  it('writes an exclusive temp file and atomically renames it to result.json', () => {
    const root = uiRunsRoot()
    const value = result()
    const renames: Array<[string, string]> = []

    const path = publishUiResult({
      uiRunsRoot: root,
      result: value,
      renameFile(from, to) {
        renames.push([from, to])
        renameSync(from, to)
      },
    })

    expect(renames).toEqual([[join(dirname(path), `${value.sessionId}.tmp`), path]])
  })

  it('never replaces finalized evidence, even with identical content', () => {
    const root = uiRunsRoot()
    const value = result()
    const path = publishUiResult({ uiRunsRoot: root, result: value })
    const before = readFileSync(path, 'utf8')

    expect(() => publishUiResult({ uiRunsRoot: root, result: value })).toThrow(
      /already.*final|immutable|replace/i,
    )
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('preserves a finalized result created immediately before atomic finalization', () => {
    const root = uiRunsRoot()
    const value = result()
    const finalPath = join(root, pluginEvidenceKey(value.plugin), value.sessionId, 'result.json')
    const competing = '{"owner":"concurrent publisher"}\n'

    expect(() => publishUiResult({
      uiRunsRoot: root,
      result: value,
      beforeFinalize(path) {
        expect(path).toBe(finalPath)
        writeFileSync(path, competing)
      },
    })).toThrow(/already.*final|immutable|exist/i)

    expect(readFileSync(finalPath, 'utf8')).toBe(competing)
    expect(existsSync(join(dirname(finalPath), `${value.sessionId}.tmp`))).toBe(false)
  })

  it('removes only the temporary file when atomic publication fails', () => {
    const root = uiRunsRoot()
    const value = result()
    const directory = join(root, pluginEvidenceKey(value.plugin), value.sessionId)

    expect(() => publishUiResult({
      uiRunsRoot: root,
      result: value,
      renameFile() {
        throw new Error('injected UI rename failure')
      },
    })).toThrow(/injected UI rename failure/i)
    expect(existsSync(join(directory, `${value.sessionId}.tmp`))).toBe(false)
    expect(existsSync(join(directory, 'result.json'))).toBe(false)
  })

  it.each(['temporary-name', 'publication-lock'] as const)(
    'returns committed immutable evidence when %s cleanup fails after finalization',
    failure => {
      const root = uiRunsRoot()
      const value = result()
      const expectedPath = join(root, pluginEvidenceKey(value.plugin), value.sessionId, 'result.json')
      const cleanup = vi.fn(() => { throw new Error(`injected ${failure} cleanup failure`) })
      const options = failure === 'temporary-name'
        ? { removeTemporaryName: cleanup }
        : { removePublicationLock: cleanup }

      expect(publishUiResult({ uiRunsRoot: root, result: value, ...options })).toBe(expectedPath)
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(JSON.parse(readFileSync(expectedPath, 'utf8'))).toEqual(value)
    },
  )

  it('fails visibly when pre-commit publication and lock cleanup both fail', () => {
    const root = uiRunsRoot()
    const value = result()
    const lock = join(root, pluginEvidenceKey(value.plugin), value.sessionId, '.publication.lock')

    expect(() => publishUiResult({
      uiRunsRoot: root,
      result: value,
      renameFile() { throw new Error('injected pre-commit publication failure') },
      removePublicationLock() { throw new Error('injected pre-commit lock cleanup failure') },
    })).toThrow(/publication.*failure.*lock|lock.*cleanup.*publication|aggregate/i)

    expect(existsSync(lock)).toBe(true)
  })

  it('does not report success or delete replacement bookkeeping after committed-directory drift', () => {
    const root = uiRunsRoot()
    const value = result()
    const directory = join(root, pluginEvidenceKey(value.plugin), value.sessionId)
    const parked = `${directory}.parked`
    const replacementLockCanary = join(directory, '.publication.lock', 'replacement-canary.txt')

    expect(() => publishUiResult({
      uiRunsRoot: root,
      result: value,
      afterFinalize(path: string) {
        expect(path).toBe(join(directory, 'result.json'))
        renameSync(directory, parked)
        mkdirSync(join(directory, '.publication.lock'), { recursive: true })
        writeFileSync(replacementLockCanary, 'replacement lock')
        writeFileSync(join(directory, 'result.json'), '{"owner":"replacement"}\n')
      },
    })).toThrow(/identity|changed|swap|ownership|refus/i)

    expect(readFileSync(replacementLockCanary, 'utf8')).toBe('replacement lock')
    expect(readFileSync(join(directory, 'result.json'), 'utf8')).toBe('{"owner":"replacement"}\n')
    expect(JSON.parse(readFileSync(join(parked, 'result.json'), 'utf8'))).toEqual(value)
    expect(existsSync(join(parked, `${value.sessionId}.tmp`))).toBe(true)
  })

  it.each(['beforeLockRemove', 'afterLockRemove'] as const)(
    'fails closed and preserves replacement bookkeeping at the %s seam',
    seam => {
      const root = uiRunsRoot()
      const value = result()
      const directory = join(root, pluginEvidenceKey(value.plugin), value.sessionId)
      const parked = `${directory}.${seam}.parked`
      let seamCalled = false
      let observed: unknown
      const hooks = {
        [seam]() {
          seamCalled = true
          renameSync(directory, parked)
          mkdirSync(join(directory, '.publication.lock'), { recursive: true })
          writeFileSync(join(directory, '.publication.lock', 'replacement-canary.txt'), 'replacement lock')
          writeFileSync(join(directory, 'result.json'), '{"owner":"replacement"}\n')
        },
      }

      try {
        publishUiResult({ uiRunsRoot: root, result: value, ...hooks } as Parameters<typeof publishUiResult>[0] & Record<typeof seam, () => void>)
      } catch (error) {
        observed = error
      }

      expect(seamCalled).toBe(true)
      expect(readFileSync(join(directory, '.publication.lock', 'replacement-canary.txt'), 'utf8')).toBe('replacement lock')
      expect(readFileSync(join(directory, 'result.json'), 'utf8')).toBe('{"owner":"replacement"}\n')
      expect(observed).toBeInstanceOf(Error)
      expect((observed as Error).message).toMatch(/identity|changed|swap|ownership|lock|refus/i)
    },
  )

  it('rejects a symlinked plugin evidence directory instead of escaping uiRunsRoot', () => {
    const root = uiRunsRoot()
    const outside = uiRunsRoot()
    const value = result()
    const key = pluginEvidenceKey(value.plugin)
    symlinkDirectory(outside, join(root, key))

    expect(() => publishUiResult({ uiRunsRoot: root, result: value })).toThrow(
      /symlink|junction|escape/i,
    )
    expect(existsSync(join(outside, value.sessionId, 'result.json'))).toBe(false)
    expect(() => loadUiResults({ uiRunsRoot: root, pluginKey: key })).toThrow(
      /symlink|junction|escape/i,
    )
  })

  it('rejects a session-directory swap before publication I/O', () => {
    const root = uiRunsRoot()
    const outside = uiRunsRoot()
    const value = result()

    expect(() => publishUiResult({
      uiRunsRoot: root,
      result: value,
      beforePublishWrite(sessionDirectory) {
        rmSync(sessionDirectory, { recursive: true, force: true })
        symlinkDirectory(outside, sessionDirectory)
      },
    })).toThrow(/symlink|junction|containment|changed|escape/i)
    expect(existsSync(join(outside, `${value.sessionId}.tmp`))).toBe(false)
    expect(existsSync(join(outside, 'result.json'))).toBe(false)
  })

  it('rejects an ordinary same-name session-directory swap at finalization', () => {
    const root = uiRunsRoot()
    const value = result()
    const sessionDirectory = join(root, pluginEvidenceKey(value.plugin), value.sessionId)
    const parked = `${sessionDirectory}.parked`
    const replacementResult = join(sessionDirectory, 'result.json')

    expect(() => publishUiResult({
      uiRunsRoot: root,
      result: value,
      beforeFinalize() {
        renameSync(sessionDirectory, parked)
        mkdirSync(sessionDirectory)
        writeFileSync(join(sessionDirectory, `${value.sessionId}.tmp`), '{"owner":"replacement"}\n')
      },
    })).toThrow(/identity|changed|swap|refus/i)

    expect(existsSync(replacementResult)).toBe(false)
    expect(readFileSync(join(sessionDirectory, `${value.sessionId}.tmp`), 'utf8')).toBe('{"owner":"replacement"}\n')
    expect(existsSync(join(parked, 'result.json'))).toBe(false)
  })
})

describe('loadUiResults', () => {
  it('loads finalized results newest-first with a deterministic session-id tie-breaker', () => {
    const root = uiRunsRoot()
    const older = result({
      sessionId: 'ui-20260824T100000000Z-11111111',
      startedAt: '2026-08-24T10:00:00.000Z',
      finishedAt: '2026-08-24T10:01:00.000Z',
    })
    const tiedB = result({
      sessionId: 'ui-20260824T120000000Z-bbbbbbbb',
      finishedAt: '2026-08-24T12:01:00.000Z',
    })
    const tiedA = result({
      sessionId: 'ui-20260824T120000000Z-aaaaaaaa',
      finishedAt: '2026-08-24T12:01:00.000Z',
    })
    const key = pluginEvidenceKey(older.plugin)
    for (const value of [older, tiedB, tiedA]) publishUiResult({ uiRunsRoot: root, result: value })
    writeFileSync(join(root, key, 'notes.txt'), 'ignored')

    expect(loadUiResults({ uiRunsRoot: root, pluginKey: key }).map(value => value.sessionId)).toEqual([
      tiedA.sessionId,
      tiedB.sessionId,
      older.sessionId,
    ])
  })

  it('reports malformed finalized evidence with the exact result path', () => {
    const root = uiRunsRoot()
    const key = pluginEvidenceKey(result().plugin)
    const path = join(root, key, 'ui-20260824T120000000Z-deadbeef', 'result.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{broken')

    expect(() => loadUiResults({ uiRunsRoot: root, pluginKey: key })).toThrow(
      new RegExp(`Corrupt.*${escapeRegex(path)}`, 'i'),
    )
  })

  it('revalidates a finalized result immediately before reading it', () => {
    const root = uiRunsRoot()
    const value = result()
    const path = publishUiResult({ uiRunsRoot: root, result: value })
    const outside = uiRunsRoot()
    let seamCalled = false

    expect(() => loadUiResults({
      uiRunsRoot: root,
      pluginKey: pluginEvidenceKey(value.plugin),
      beforeResultRead(resultPath) {
        seamCalled = true
        expect(resultPath).toBe(path)
        rmSync(dirname(resultPath), { recursive: true, force: true })
        symlinkDirectory(outside, dirname(resultPath))
      },
    })).toThrow(/symlink|junction|changed|containment|regular file|escape/i)
    expect(seamCalled).toBe(true)
  })

  it('rejects a valid forged result from an ordinary same-name replacement directory', () => {
    const root = uiRunsRoot()
    const value = result()
    const path = publishUiResult({ uiRunsRoot: root, result: value })
    const sessionDirectory = dirname(path)
    const parked = `${sessionDirectory}.parked`
    const forged = { ...value, verdict: 'fail' as const, summary: 'forged replacement evidence' }

    expect(() => loadUiResults({
      uiRunsRoot: root,
      pluginKey: pluginEvidenceKey(value.plugin),
      beforeResultRead(resultPath) {
        expect(resultPath).toBe(path)
        renameSync(sessionDirectory, parked)
        mkdirSync(sessionDirectory)
        writeFileSync(resultPath, `${JSON.stringify(forged, null, 2)}\n`)
        writeFileSync(join(sessionDirectory, 'replacement-canary.txt'), 'replacement')
      },
    })).toThrow(/identity|changed|swap|ownership|corrupt|refus/i)

    expect(JSON.parse(readFileSync(join(parked, 'result.json'), 'utf8'))).toEqual(value)
    expect(readFileSync(join(sessionDirectory, 'replacement-canary.txt'), 'utf8')).toBe('replacement')
  })
})

function symlinkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
