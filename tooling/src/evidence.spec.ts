import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
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
})

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
