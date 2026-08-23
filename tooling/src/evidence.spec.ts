import { afterEach, describe, expect, it } from 'vitest'
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
import {
  loadRunResults,
  pluginEvidenceKey,
  publishRunResult,
  type VerifyRunResultV1,
} from './evidence.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lab-evidence-'))
  roots.push(root)
  return root
}

function result(overrides: Partial<VerifyRunResultV1> = {}): VerifyRunResultV1 {
  return {
    schemaVersion: 1,
    runId: 'run-20260823-0001',
    operation: 'verify',
    result: 'pass',
    plugin: {
      packageName: '@fixture/demo',
      sourcePath: 'A:/plugins/demo',
      digest: `sha256:${'a'.repeat(64)}`,
    },
    targets: { next: { dsh: '0.1.1-rc.2', result: 'pass' } },
    lab: { contextDigest: `sha256:${'b'.repeat(64)}` },
    environment: { node: '22.20.0', pnpm: '11.7.0', platform: process.platform },
    steps: [{ id: 'inspect', status: 'pass', durationMs: 12, summary: 'contracts valid' }],
    cleanup: 'pass',
    startedAt: '2026-08-23T10:00:00.000Z',
    finishedAt: '2026-08-23T10:00:01.000Z',
    ...overrides,
  }
}

describe('pluginEvidenceKey', () => {
  it('combines a readable sanitized package fragment with a stable normalized-path hash', () => {
    const windows = pluginEvidenceKey({ packageName: '@fixture/demo', sourcePath: 'A:\\Work\\Plugin' })
    const slash = pluginEvidenceKey({ packageName: '@fixture/demo', sourcePath: 'A:/Work/Plugin/' })

    expect(windows).toBe(slash)
    expect(windows).toMatch(/^fixture-demo-[a-f0-9]{12}$/)
    expect(
      pluginEvidenceKey({ packageName: '@fixture/demo', sourcePath: 'A:/Work/Other' }),
    ).not.toBe(windows)
  })

  it('includes the full package identity in the hash even when readable fragments collide or truncate', () => {
    expect(pluginEvidenceKey({ packageName: '@a/b-c', sourcePath: 'A:/same' })).not.toBe(
      pluginEvidenceKey({ packageName: '@a-b/c', sourcePath: 'A:/same' }),
    )
    const prefix = `@scope/${'a'.repeat(100)}`
    const first = pluginEvidenceKey({ packageName: `${prefix}x`, sourcePath: 'A:/same' })
    const second = pluginEvidenceKey({ packageName: `${prefix}y`, sourcePath: 'A:/same' })
    expect(first).not.toBe(second)
    expect(first.length).toBeLessThanOrEqual(80)
  })

  it('canonicalizes Windows drive case without conflating UNC and POSIX roots', () => {
    expect(pluginEvidenceKey({ packageName: 'demo', sourcePath: 'C:\\Work\\Plugin' })).toBe(
      pluginEvidenceKey({ packageName: 'demo', sourcePath: 'c:/work/plugin/' }),
    )
    expect(pluginEvidenceKey({ packageName: 'demo', sourcePath: '\\\\server\\share\\plugin' })).not.toBe(
      pluginEvidenceKey({ packageName: 'demo', sourcePath: '/server/share/plugin' }),
    )
  })
})

describe('publishRunResult', () => {
  it('validates the minimal schema and round-trips formatted JSON with a final newline', () => {
    const root = runsRoot()
    const value = result()

    const path = publishRunResult({ runsRoot: root, result: value })

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(value)
    expect(readFileSync(path, 'utf8')).toMatch(/\n$/)
    expect(path).toBe(
      join(root, pluginEvidenceKey(value.plugin), value.runId, 'result.json'),
    )
  })

  it.each([
    [{ operation: undefined }, /operation/i],
    [{ schemaVersion: 2 }, /schemaVersion/i],
    [{ runId: '../escape' }, /runId/i],
    [{ steps: [{ id: 'inspect', status: 'pass', durationMs: -1 }] }, /durationMs/i],
  ])('rejects an invalid required field: %j', (override, message) => {
    expect(() => publishRunResult({
      runsRoot: runsRoot(),
      result: result(override as Partial<VerifyRunResultV1>),
    })).toThrow(message)
  })

  it('rejects arbitrary environment fields and overlong summaries', () => {
    const withEnvironmentLeak = result() as VerifyRunResultV1 & {
      environment: VerifyRunResultV1['environment'] & { home: string }
    }
    withEnvironmentLeak.environment.home = 'C:/Users/private'
    expect(() => publishRunResult({ runsRoot: runsRoot(), result: withEnvironmentLeak })).toThrow(
      /environment.*home|unexpected.*home/i,
    )

    expect(() => publishRunResult({
      runsRoot: runsRoot(),
      result: result({
        steps: [{ id: 'inspect', status: 'fail', durationMs: 1, summary: 'x'.repeat(501) }],
      }),
    })).toThrow(/summary/i)
  })

  it('persists only a single-line redacted summary and bounds the number of steps', () => {
    const root = runsRoot()
    const leaked = 'failed\nTOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz\npassword=hunter2'
    const path = publishRunResult({
      runsRoot: root,
      result: result({
        steps: [{ id: 'inspect', status: 'fail', durationMs: 1, summary: leaked }],
      }),
    })
    const stored = JSON.parse(readFileSync(path, 'utf8')) as VerifyRunResultV1
    const summary = stored.steps[0]!.summary!
    expect(summary).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz')
    expect(summary).not.toContain('hunter2')
    expect(summary).not.toMatch(/[\r\n]/)
    expect(summary).toContain('[REDACTED]')
    expect(summary.length).toBeLessThanOrEqual(500)

    expect(() => publishRunResult({
      runsRoot: runsRoot(),
      result: result({
        steps: Array.from({ length: 257 }, (_, index) => ({
          id: `step-${index}`,
          status: 'pass' as const,
          durationMs: 0,
        })),
      }),
    })).toThrow(/steps.*256|too many steps/i)
  })

  it('redacts compound secret keys without destroying ordinary diagnostic assignments', () => {
    const root = runsRoot()
    const path = publishRunResult({
      runsRoot: root,
      result: result({
        steps: [{
          id: 'inspect',
          status: 'fail',
          durationMs: 1,
          summary: 'client_secret=mysecret access_token=token-value ERROR=ENOENT HTTP=200 PATH=/tmp/plugin',
        }],
      }),
    })
    const stored = JSON.parse(readFileSync(path, 'utf8')) as VerifyRunResultV1
    const summary = stored.steps[0]!.summary!

    expect(summary).not.toContain('mysecret')
    expect(summary).not.toContain('token-value')
    expect(summary).toContain('client_secret=[REDACTED]')
    expect(summary).toContain('access_token=[REDACTED]')
    expect(summary).toContain('ERROR=ENOENT')
    expect(summary).toContain('HTTP=200')
    expect(summary).toContain('PATH=/tmp/plugin')
  })

  it.each(['CON', 'con.txt', 'PRN', 'AUX', 'NUL', 'COM1', 'lpt9', 'run.'])(
    'rejects non-portable Windows run id %j',
    runId => {
      expect(() => publishRunResult({
        runsRoot: runsRoot(),
        result: result({ runId }),
      })).toThrow(/runId.*reserved|runId.*portable|invalid runId/i)
    },
  )

  it('writes run-id temp then atomically renames to result.json', () => {
    const root = runsRoot()
    const renames: Array<[string, string]> = []

    const finalPath = publishRunResult({
      runsRoot: root,
      result: result(),
      renameFile(from, to) {
        renames.push([from, to])
        renameSync(from, to)
      },
    })

    expect(renames).toEqual([[join(dirname(finalPath), `${result().runId}.tmp`), finalPath]])
    expect(basename(finalPath)).toBe('result.json')
  })

  it('never overwrites a finalized run', () => {
    const root = runsRoot()
    const value = result()
    const path = publishRunResult({ runsRoot: root, result: value })
    const before = readFileSync(path, 'utf8')

    expect(() => publishRunResult({
      runsRoot: root,
      result: result({ result: 'fail' }),
    })).toThrow(/already exists|immutable|duplicate/i)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('removes the temp file when atomic publication fails', () => {
    const root = runsRoot()
    const value = result()
    const runDirectory = join(root, pluginEvidenceKey(value.plugin), value.runId)
    const temporary = join(runDirectory, `${value.runId}.tmp`)

    expect(() => publishRunResult({
      runsRoot: root,
      result: value,
      renameFile() {
        throw new Error('injected rename failure')
      },
    })).toThrow(/injected rename failure/i)
    expect(existsSync(temporary)).toBe(false)
    expect(existsSync(join(runDirectory, 'result.json'))).toBe(false)
  })

  it('rejects a symlinked plugin evidence directory instead of writing outside runsRoot', () => {
    const root = runsRoot()
    const outside = runsRoot()
    const value = result()
    const key = pluginEvidenceKey(value.plugin)
    symlinkSyncDirectory(outside, join(root, key))

    expect(() => publishRunResult({ runsRoot: root, result: value })).toThrow(/symlink|junction|escape/i)
    expect(existsSync(join(outside, value.runId, 'result.json'))).toBe(false)
    expect(() => loadRunResults({ runsRoot: root, pluginKey: key })).toThrow(/symlink|junction|escape/i)
  })

  it('rejects a symlinked runsRoot itself', () => {
    const parent = runsRoot()
    const outside = runsRoot()
    const linkedRoot = join(parent, 'linked-runs')
    symlinkSyncDirectory(outside, linkedRoot)

    expect(() => publishRunResult({ runsRoot: linkedRoot, result: result() })).toThrow(
      /runsRoot.*symlink|junction|escape/i,
    )
  })

  it('reports an orphan publication lock with its exact actionable path', () => {
    const root = runsRoot()
    const value = result()
    const lock = join(root, pluginEvidenceKey(value.plugin), value.runId, '.publication.lock')
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(dirname(lock), `${value.runId}.tmp`), 'orphan')

    expect(() => publishRunResult({ runsRoot: root, result: value })).toThrow(
      new RegExp(`${escapeRegex(lock)}.*(?:stale|orphan|remove|recover)`, 'i'),
    )
  })

  it('reports an orphan temporary file with its exact actionable path', () => {
    const root = runsRoot()
    const value = result()
    const temporary = join(
      root,
      pluginEvidenceKey(value.plugin),
      value.runId,
      `${value.runId}.tmp`,
    )
    mkdirSync(dirname(temporary), { recursive: true })
    writeFileSync(temporary, 'orphan')

    expect(() => publishRunResult({ runsRoot: root, result: value })).toThrow(
      new RegExp(`${escapeRegex(temporary)}.*(?:stale|orphan|remove|recover)`, 'i'),
    )
    expect(existsSync(temporary)).toBe(true)
  })

  it('revalidates containment after a run directory is swapped before publication I/O', () => {
    const root = runsRoot()
    const outside = runsRoot()
    const value = result()
    let seamCalled = false

    expect(() => publishRunResult({
      runsRoot: root,
      result: value,
      beforePublishWrite(runDirectory) {
        seamCalled = true
        rmSync(runDirectory, { recursive: true, force: true })
        symlinkSyncDirectory(outside, runDirectory)
      },
    })).toThrow(/symlink|junction|containment|changed|escape/i)
    expect(seamCalled).toBe(true)
    expect(existsSync(join(outside, `${value.runId}.tmp`))).toBe(false)
    expect(existsSync(join(outside, 'result.json'))).toBe(false)
  })
})

describe('loadRunResults', () => {
  it('loads finalized results newest-first and ignores unrelated files', () => {
    const root = runsRoot()
    const older = result({ runId: 'older', finishedAt: '2026-08-23T10:00:01.000Z' })
    const newer = result({ runId: 'newer', finishedAt: '2026-08-23T11:00:01.000Z' })
    const key = pluginEvidenceKey(older.plugin)
    publishRunResult({ runsRoot: root, result: older })
    publishRunResult({ runsRoot: root, result: newer })
    writeFileSync(join(root, key, 'notes.txt'), 'ignore me')
    writeFileSync(join(root, key, 'orphan.tmp'), '{}')
    mkdirSync(join(root, key, 'unfinished'), { recursive: true })
    writeFileSync(join(root, key, 'unfinished', 'other.json'), '{}')

    expect(loadRunResults({ runsRoot: root, pluginKey: key }).map(run => run.runId)).toEqual([
      'newer',
      'older',
    ])
  })

  it('reports malformed finalized JSON with its exact path', () => {
    const root = runsRoot()
    const key = pluginEvidenceKey(result().plugin)
    const path = join(root, key, 'broken', 'result.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ invalid json')

    expect(() => loadRunResults({ runsRoot: root, pluginKey: key })).toThrow(
      new RegExp(escapeRegex(path)),
    )
  })

  it('uses a locale-independent code-point tie-breaker for equal completion times', () => {
    const root = runsRoot()
    const timestamp = '2026-08-23T10:00:01.000Z'
    const upper = result({ runId: 'B', finishedAt: timestamp })
    const lower = result({ runId: 'a', finishedAt: timestamp })
    const key = pluginEvidenceKey(upper.plugin)
    publishRunResult({ runsRoot: root, result: upper })
    publishRunResult({ runsRoot: root, result: lower })

    expect(loadRunResults({ runsRoot: root, pluginKey: key }).map(run => run.runId)).toEqual([
      'a',
      'B',
    ])
  })

  it('revalidates a finalized file after it is swapped immediately before reading', () => {
    const root = runsRoot()
    const value = result()
    const path = publishRunResult({ runsRoot: root, result: value })
    const outside = runsRoot()
    writeFileSync(join(outside, 'result.json'), `${JSON.stringify(result({ result: 'fail' }))}\n`)
    let seamCalled = false

    expect(() => loadRunResults({
      runsRoot: root,
      pluginKey: pluginEvidenceKey(value.plugin),
      beforeResultRead(resultPath) {
        seamCalled = true
        expect(resultPath).toBe(path)
        rmSync(resultPath)
        symlinkSyncDirectory(outside, resultPath)
      },
    })).toThrow(/symlink|changed|containment|regular file/i)
    expect(seamCalled).toBe(true)
  })
})

function symlinkSyncDirectory(target: string, path: string): void {
  // Junctions are available to ordinary Windows users; POSIX uses a directory symlink.
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(target, path, type)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
