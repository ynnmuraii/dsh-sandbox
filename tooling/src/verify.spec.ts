import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginSnapshot, computePluginDigest } from './plugin-snapshot.js'
import { verifyPackageInWorkspace, type PackageVerifyRunner } from './package-verify.js'
import {
  verifyPlugin,
  type VerifyPluginDependencies,
  type VerifyPluginOptions,
} from './verify.js'
import type { PluginRef } from './plugin-ref.js'
import { loadRunResults, pluginEvidenceKey, publishRunResult, type VerifyRunResultV1 } from './evidence.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function plugin(sourcePath = 'A:/plugin'): PluginRef {
  return {
    sourcePath,
    packageName: '@fixture/demo',
    metadata: { name: 'demo', tracking: 'local', maturity: 'experiment', targets: ['next', 'master'] },
  }
}

function compatibility() {
  return {
    targets: {
      next: { dsh: '0.1.1-rc.2', cordis: '4.0.1', node: '22.20.0', pnpm: '11.7.0' },
      master: {
        repository: 'deepseek-ai/deepseek-harness',
        commit: '1'.repeat(40),
        node: '^22.19.0',
        pnpm: '11.7.0',
      },
    },
  }
}

function fakeSnapshot(events: string[], cleanupError?: Error) {
  return {
    runRoot: 'A:/runtime/verify-run',
    workspacePath: 'A:/runtime/verify-run/workspace',
    digest: `sha256:${'a'.repeat(64)}` as const,
    files: ['package.json', 'src/index.ts'],
    cleanup: vi.fn(() => {
      events.push('cleanup')
      if (cleanupError) throw cleanupError
    }),
  }
}

function dependencies(
  events: string[],
  overrides: Partial<VerifyPluginDependencies> = {},
): VerifyPluginDependencies {
  const snapshot = fakeSnapshot(events)
  return {
    inspectPlugin: vi.fn(() => {
      events.push('inspect')
      return {
        schemaVersion: 1,
        plugin: { packageName: '@fixture/demo', sourcePath: 'A:/plugin' },
        faces: { host: true, client: 'unknown' },
        diagnostics: [],
        ok: true,
      }
    }),
    createSnapshot: vi.fn(() => {
      events.push('snapshot')
      return snapshot
    }),
    verifyPackage: vi.fn(() => {
      events.push('package')
      return {
        tarball: 'A:/runtime/verify-run/workspace/demo.tgz',
        steps: [
          { id: 'install', status: 'pass', durationMs: 1 },
          { id: 'typecheck', status: 'pass', durationMs: 1 },
          { id: 'test', status: 'pass', durationMs: 1 },
          { id: 'build', status: 'pass', durationMs: 1 },
          { id: 'pack', status: 'pass', durationMs: 1 },
          { id: 'pack-smoke', status: 'pass', durationMs: 1 },
        ],
      }
    }),
    verifyTarget: vi.fn(async ({ target }) => {
      events.push(`target:${target}`)
    }),
    loadCompatibility: vi.fn(() => compatibility()),
    publishResult: vi.fn(({ result }) => {
      events.push('publish')
      return `A:/runs/${result.runId}/result.json`
    }),
    createRunId: vi.fn(() => 'verify-20260823-0001'),
    now: vi.fn(() => new Date('2026-08-23T10:00:00.000Z')),
    contextDigest: vi.fn(() => `sha256:${'b'.repeat(64)}`),
    environment: vi.fn(() => ({ node: '22.20.0', pnpm: '11.7.0', platform: process.platform })),
    ...overrides,
  }
}

function options(deps: VerifyPluginDependencies, target: 'next' | 'master' | 'all' = 'next'): VerifyPluginOptions {
  return { root: 'A:/lab', plugin: plugin(), target, runsRoot: 'A:/runs', dependencies: deps }
}

describe('verifyPlugin orchestration', () => {
  it('publishes one finalized passing result only after cleanup outcome is known', async () => {
    const events: string[] = []
    const deps = dependencies(events)

    const result = await verifyPlugin(options(deps))

    expect(events).toEqual(['inspect', 'snapshot', 'package', 'target:next', 'cleanup', 'publish'])
    expect(result.result).toBe('pass')
    expect(result.cleanup).toBe('pass')
    expect(result.plugin.digest).toBe(`sha256:${'a'.repeat(64)}`)
    expect(result.targets.next).toMatchObject({ dsh: '0.1.1-rc.2', result: 'pass' })
    expect(result.steps.map(step => step.id)).toEqual([
      'inspect',
      'install',
      'typecheck',
      'test',
      'build',
      'pack',
      'pack-smoke',
      'target:next',
    ])
    expect(deps.publishResult).toHaveBeenCalledTimes(1)
    expect(deps.publishResult).toHaveBeenCalledWith({ runsRoot: 'A:/runs', result })
  })

  it('stops before snapshot/package when structural inspection fails', async () => {
    const events: string[] = []
    const deps = dependencies(events, {
      inspectPlugin: vi.fn(() => ({
        schemaVersion: 1,
        plugin: { packageName: '@fixture/demo', sourcePath: 'A:/plugin' },
        faces: { host: true, client: 'unknown' },
        diagnostics: [{ code: 'LOCKFILE_MISSING', severity: 'error', message: 'missing lock' }],
        ok: false,
      })),
    })

    await expect(verifyPlugin(options(deps))).rejects.toThrow(/inspection.*LOCKFILE_MISSING|LOCKFILE_MISSING.*inspection/i)
    expect(deps.createSnapshot).not.toHaveBeenCalled()
    expect(deps.verifyPackage).not.toHaveBeenCalled()
    expect(deps.publishResult).not.toHaveBeenCalled()
  })

  it('publishes package failure with structured steps and always cleans once', async () => {
    const events: string[] = []
    const snapshot = fakeSnapshot(events)
    const failedSteps = [
      { id: 'install', status: 'pass' as const, durationMs: 1 },
      { id: 'typecheck', status: 'fail' as const, durationMs: 2, summary: 'type error' },
      { id: 'test', status: 'skipped' as const, durationMs: 0 },
    ]
    const failure = Object.assign(new Error('package failed'), { steps: failedSteps })
    const deps = dependencies(events, {
      createSnapshot: vi.fn(() => {
        events.push('snapshot')
        return snapshot
      }),
      verifyPackage: vi.fn(() => {
        events.push('package')
        throw failure
      }),
    })

    const result = await verifyPlugin(options(deps))

    expect(result.result).toBe('fail')
    expect(result.steps).toEqual([
      expect.objectContaining({ id: 'inspect', status: 'pass' }),
      ...failedSteps,
    ])
    expect(snapshot.cleanup).toHaveBeenCalledTimes(1)
    expect(deps.verifyTarget).not.toHaveBeenCalled()
    expect(deps.publishResult).toHaveBeenCalledTimes(1)
  })

  it('runs every selected target under all and aggregates a target failure', async () => {
    const events: string[] = []
    const deps = dependencies(events, {
      verifyTarget: vi.fn(async ({ target }) => {
        events.push(`target:${target}`)
        if (target === 'next') throw new Error('next failed')
      }),
    })

    const result = await verifyPlugin(options(deps, 'all'))

    expect(deps.inspectPlugin).toHaveBeenCalledTimes(2)
    expect(deps.inspectPlugin).toHaveBeenNthCalledWith(1, {
      root: 'A:/lab',
      plugin: options(deps, 'all').plugin,
      target: 'next',
    })
    expect(deps.inspectPlugin).toHaveBeenNthCalledWith(2, {
      root: 'A:/lab',
      plugin: options(deps, 'all').plugin,
      target: 'master',
    })
    expect(events).toContain('target:next')
    expect(events).toContain('target:master')
    expect(result.result).toBe('fail')
    expect(result.targets.next.result).toBe('fail')
    expect(result.targets.master).toMatchObject({ commit: '1'.repeat(40), result: 'pass' })
  })

  it('inspects both explicit all targets even when a standalone plugin has no metadata', async () => {
    const events: string[] = []
    const deps = dependencies(events)
    const standalone = { sourcePath: 'A:/plugin', packageName: '@fixture/demo' }

    await verifyPlugin({
      root: 'A:/lab',
      plugin: standalone,
      target: 'all',
      runsRoot: 'A:/runs',
      dependencies: deps,
    })

    expect(deps.inspectPlugin).toHaveBeenNthCalledWith(1, {
      root: 'A:/lab', plugin: standalone, target: 'next',
    })
    expect(deps.inspectPlugin).toHaveBeenNthCalledWith(2, {
      root: 'A:/lab', plugin: standalone, target: 'master',
    })
  })

  it('returns a generic master-only result for all when metadata declares only master', async () => {
    const events: string[] = []
    const deps = dependencies(events)
    const masterOnly = plugin()
    masterOnly.metadata!.targets = ['master']
    const promise = verifyPlugin({
      root: 'A:/lab',
      plugin: masterOnly,
      target: 'all',
      runsRoot: 'A:/runs',
      dependencies: deps,
    })
    expectTypeOf(promise).toEqualTypeOf<Promise<VerifyRunResultV1>>()

    const result = await promise
    expect(result.targets).toHaveProperty('master')
    expect(result.targets).not.toHaveProperty('next')
  })

  it('rejects unsupported metadata targets instead of silently filtering them', async () => {
    const events: string[] = []
    const deps = dependencies(events)
    const withFuture = plugin()
    withFuture.metadata!.targets = ['next', 'future']

    await expect(verifyPlugin({
      root: 'A:/lab',
      plugin: withFuture,
      target: 'all',
      dependencies: deps,
    })).rejects.toThrow(/unknown.*target.*future|unsupported.*future/i)
    expect(deps.inspectPlugin).not.toHaveBeenCalled()
  })

  it('records cleanup failure as a failed result and still publishes exactly once', async () => {
    const events: string[] = []
    const snapshot = fakeSnapshot(events, new Error('locked workspace'))
    const deps = dependencies(events, {
      createSnapshot: vi.fn(() => {
        events.push('snapshot')
        return snapshot
      }),
    })

    const result = await verifyPlugin(options(deps))

    expect(snapshot.cleanup).toHaveBeenCalledTimes(1)
    expect(result.cleanup).toBe('fail')
    expect(result.result).toBe('fail')
    expect(result.steps).toContainEqual(expect.objectContaining({ id: 'cleanup', status: 'fail' }))
    expect(deps.publishResult).toHaveBeenCalledTimes(1)
  })

  it('attempts cleanup once and surfaces evidence publication failure', async () => {
    const events: string[] = []
    const snapshot = fakeSnapshot(events)
    const deps = dependencies(events, {
      createSnapshot: vi.fn(() => snapshot),
      publishResult: vi.fn(() => {
        events.push('publish')
        throw new Error('evidence unavailable')
      }),
    })

    await expect(verifyPlugin(options(deps))).rejects.toThrow(/evidence unavailable/)
    expect(snapshot.cleanup).toHaveBeenCalledTimes(1)
    expect(deps.publishResult).toHaveBeenCalledTimes(1)
  })
})

describe('verifyPlugin source isolation', () => {
  it('finalizes failed evidence and removes the real temporary workspace when plugin tests fail', async () => {
    const root = temporaryRoot('dsh-lab-verify-failure-root-')
    const sourcePath = temporaryRoot('dsh-lab-verify-failure-source-')
    const runsRoot = join(root, '.lab', 'runs')
    mkdirSync(join(sourcePath, 'src'), { recursive: true })
    writeFileSync(join(sourcePath, 'src', 'index.ts'), 'export const current = true\n')
    writeFileSync(join(sourcePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    writeFileSync(join(sourcePath, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    writeFileSync(join(sourcePath, 'package.json'), JSON.stringify({
      name: '@fixture/demo',
      version: '0.0.0',
      scripts: { typecheck: 'x', test: 'x', build: 'x', 'pack-smoke': 'x' },
    }))
    const pluginRef = plugin(sourcePath)
    const before = computePluginDigest(sourcePath)
    const packageRunner: PackageVerifyRunner = {
      pnpm(args) {
        if (args[0] === 'test' || args.join(' ') === 'run test') throw new Error('intentional plugin test failure')
        return ''
      },
    }
    const events: string[] = []
    const deps = dependencies(events, {
      createSnapshot: opts => createPluginSnapshot(opts),
      verifyPackage: opts => verifyPackageInWorkspace({ ...opts, runner: packageRunner }),
      publishResult: opts => publishRunResult(opts),
      createRunId: () => 'verify-failed-acceptance',
    })

    const result = await verifyPlugin({ root, runsRoot, plugin: pluginRef, target: 'next', dependencies: deps })

    expect(result.result).toBe('fail')
    expect(result.steps).toContainEqual(expect.objectContaining({ id: 'test', status: 'fail' }))
    expect(loadRunResults({ runsRoot, pluginKey: pluginEvidenceKey(pluginRef) })).toEqual([result])
    const runtimeRoot = join(root, '.lab', 'runtime')
    expect(existsSync(runtimeRoot) ? readdirSync(runtimeRoot) : []).toEqual([])
    expect(computePluginDigest(sourcePath)).toEqual(before)
  })

  it('uses current source content through a real temporary snapshot and leaves source byte-identical', async () => {
    const root = temporaryRoot('dsh-lab-verify-root-')
    const sourcePath = temporaryRoot('dsh-lab-verify-source-')
    mkdirSync(join(sourcePath, 'src'), { recursive: true })
    writeFileSync(join(sourcePath, 'src', 'index.ts'), 'export const modified = true\n')
    writeFileSync(join(sourcePath, 'src', 'untracked.ts'), 'export const untracked = true\n')
    writeFileSync(join(sourcePath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    writeFileSync(join(sourcePath, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    writeFileSync(join(sourcePath, 'package.json'), JSON.stringify({
      name: '@fixture/demo',
      version: '0.0.0',
      scripts: { typecheck: 'x', test: 'x', build: 'x', 'pack-smoke': 'x' },
    }))
    const before = computePluginDigest(sourcePath)
    const commandCwds: string[] = []
    let stagedArtifactsObserved = false
    const packageRunner: PackageVerifyRunner = {
      pnpm(args, runOpts) {
        const cwd = runOpts.cwd!
        commandCwds.push(cwd)
        if (args[0] === 'install') mkdirSync(join(cwd, 'node_modules'), { recursive: true })
        if (args[0] === 'build') {
          mkdirSync(join(cwd, 'lib'), { recursive: true })
          writeFileSync(join(cwd, 'lib', 'index.js'), 'built')
        }
        if (args[0] === 'pack') {
          writeFileSync(join(cwd, 'fixture-demo-0.0.0.tgz'), 'tarball')
          stagedArtifactsObserved = existsSync(join(cwd, 'node_modules')) && existsSync(join(cwd, 'lib'))
          return JSON.stringify([{ filename: 'fixture-demo-0.0.0.tgz' }])
        }
        return ''
      },
    }
    const events: string[] = []
    const deps = dependencies(events, {
      createSnapshot: opts => createPluginSnapshot(opts),
      verifyPackage: opts => verifyPackageInWorkspace({ ...opts, runner: packageRunner }),
    })

    const result = await verifyPlugin({
      root,
      plugin: plugin(sourcePath),
      target: 'next',
      dependencies: deps,
    })

    expect(result.result).toBe('pass')
    expect(stagedArtifactsObserved).toBe(true)
    expect(commandCwds.length).toBe(6)
    expect(commandCwds.every(cwd => cwd !== sourcePath && cwd.startsWith(root))).toBe(true)
    expect(commandCwds.every(cwd => !existsSync(cwd))).toBe(true)
    expect(computePluginDigest(sourcePath)).toEqual(before)
    expect(existsSync(join(sourcePath, 'node_modules'))).toBe(false)
    expect(existsSync(join(sourcePath, 'lib'))).toBe(false)
    expect(existsSync(join(sourcePath, 'fixture-demo-0.0.0.tgz'))).toBe(false)
    expect(readFileSync(join(sourcePath, 'src', 'untracked.ts'), 'utf8')).toContain('untracked')
  })
})
