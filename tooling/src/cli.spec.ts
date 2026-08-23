import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { parsePluginSelector, runCli } from './cli.js'
import { checkUpstream, updateUpstream } from './upstream-update.js'
import { resolvePluginRef } from './plugin-ref.js'
import { inspectPlugin } from './inspect.js'
import { verifyPlugin } from './verify.js'
import { derivePluginStatus } from './status.js'
import { devPlugin } from './run.js'
import { syncContext } from './sync.js'

vi.mock('./upstream-update.js', () => ({
  checkUpstream: vi.fn(),
  updateUpstream: vi.fn(),
}))

vi.mock('./plugin-ref.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./plugin-ref.js')>()),
  resolvePluginRef: vi.fn(),
}))

vi.mock('./inspect.js', () => ({ inspectPlugin: vi.fn() }))
vi.mock('./verify.js', () => ({ verifyPlugin: vi.fn() }))
vi.mock('./status.js', () => ({ derivePluginStatus: vi.fn() }))
vi.mock('./run.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./run.js')>()),
  devPlugin: vi.fn(),
}))
vi.mock('./sync.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./sync.js')>()),
  syncContext: vi.fn(),
}))

const PINNED = '1'.repeat(40)
const REMOTE = '2'.repeat(40)

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(checkUpstream).mockReset()
  vi.mocked(updateUpstream).mockReset()
  vi.mocked(resolvePluginRef).mockReset()
  vi.mocked(inspectPlugin).mockReset()
  vi.mocked(verifyPlugin).mockReset()
  vi.mocked(derivePluginStatus).mockReset()
  vi.mocked(devPlugin).mockReset()
  vi.mocked(syncContext).mockReset()
})

function captureConsole() {
  const logs: string[] = []
  const errors: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')))
  return { logs, errors }
}

describe('portable agent skill CLI surface', () => {
  it('documents skill regeneration under sync-context without adding a skill command', async () => {
    const output = captureConsole()

    expect(await runCli(['--help'])).toBe(0)

    const help = output.logs.join('\n')
    expect(help).toMatch(/sync-context.*(?:context projections|shared-context).*agent skill/i)
    expect(help).not.toMatch(/^\s+skill(?:\s|$)/m)
  })

  it('reports plugin and agent-skill projections with existing synced/current words', async () => {
    const output = captureConsole()
    vi.mocked(syncContext).mockResolvedValue([
      {
        kind: 'plugin-context',
        name: 'demo',
        changed: true,
        path: 'A:/lab/plugins/demo/.dsh-lab/shared-context.md',
      },
      {
        kind: 'agent-skill',
        name: 'dsh-plugin-development',
        changed: false,
        path: 'A:/lab/.agents/skills/dsh-plugin-development/SKILL.md',
      },
    ])

    expect(await runCli(['sync-context', 'demo'])).toBe(0)
    expect(syncContext).toHaveBeenCalledWith({
      root: process.cwd(),
      names: ['demo'],
      all: false,
    })
    expect(output.logs).toEqual([
      'synced  A:/lab/plugins/demo/.dsh-lab/shared-context.md',
      'current A:/lab/.agents/skills/dsh-plugin-development/SKILL.md',
    ])
  })
})

describe('upstream CLI', () => {
  it('prints nested help with check, update, and --verify', async () => {
    const output = captureConsole()
    expect(await runCli(['upstream', '--help'])).toBe(0)
    expect(output.logs.join('\n')).toMatch(/upstream check/)
    expect(output.logs.join('\n')).toMatch(/upstream update \[--verify\]/)
  })

  it('check prints both commits and returns 0 when current', async () => {
    const output = captureConsole()
    vi.mocked(checkUpstream).mockReturnValue({ pinned: PINNED, remote: PINNED, current: true })
    expect(await runCli(['upstream', 'check'])).toBe(0)
    expect(output.logs.join('\n')).toContain(`pinned: ${PINNED}`)
    expect(output.logs.join('\n')).toContain(`remote: ${PINNED}`)
  })

  it('check returns 2 when an update is available', async () => {
    captureConsole()
    vi.mocked(checkUpstream).mockReturnValue({ pinned: PINNED, remote: REMOTE, current: false })
    expect(await runCli(['upstream', 'check'])).toBe(2)
  })

  it.each([
    [[], false],
    [['--verify'], true],
  ] as const)('update forwards verify=%s and reports the adopted commit', async (flags, verify) => {
    const output = captureConsole()
    vi.mocked(updateUpstream).mockResolvedValue({
      previous: PINNED,
      adopted: REMOTE,
      changed: true,
      verifiedPlugins: verify ? ['example'] : [],
    })
    expect(await runCli(['upstream', 'update', ...flags])).toBe(0)
    expect(updateUpstream).toHaveBeenCalledWith({ root: process.cwd(), verify })
    expect(output.logs.join('\n')).toContain(`previous: ${PINNED}`)
    expect(output.logs.join('\n')).toContain(`adopted: ${REMOTE}`)
  })

  it('returns 1 with usage for an unknown upstream subcommand', async () => {
    const output = captureConsole()
    expect(await runCli(['upstream', 'wat'])).toBe(1)
    expect(output.errors.join('\n')).toMatch(/usage: lab upstream/i)
  })

  it('maps updater failures to exit 1', async () => {
    const output = captureConsole()
    vi.mocked(checkUpstream).mockImplementation(() => { throw new Error('network unavailable') })
    expect(await runCli(['upstream', 'check'])).toBe(1)
    expect(output.errors.join('\n')).toContain('network unavailable')
  })
})

describe('plugin selector parsing', () => {
  it('parses a catalog name and leaves command flags in rest', () => {
    expect(parsePluginSelector(['demo', '--target', 'next'])).toEqual({
      selector: { name: 'demo' },
      rest: ['--target', 'next'],
    })
  })

  it('parses --path and leaves command flags in rest', () => {
    expect(parsePluginSelector(['--path', 'A:/plugin', '--target', 'master'])).toEqual({
      selector: { path: 'A:/plugin' },
      rest: ['--target', 'master'],
    })
  })

  it('rejects a missing --path value', () => {
    expect(() => parsePluginSelector(['--path'])).toThrow(/--path requires a value/i)
    expect(() => parsePluginSelector(['--path', '--target', 'next'])).toThrow(
      /--path requires a value/i,
    )
  })

  it.each(['', '   '])('rejects an empty --path value: %j', (path) => {
    expect(() => parsePluginSelector(['--path', path])).toThrow(/--path requires a value/i)
  })

  it('rejects conflicting positional names', () => {
    expect(() => parsePluginSelector(['demo', 'other'])).toThrow(/conflicting positional names/i)
  })

  it('rejects a positional catalog name combined with --path', () => {
    expect(() => parsePluginSelector(['demo', '--path', 'A:/plugin'])).toThrow(/exactly one/i)
  })
})

describe('path-first dev CLI', () => {
  const plugin = { sourcePath: 'A:/external', packageName: '@fixture/external' }

  it.each([
    [['dev', '--path', 'A:/external', '--target', 'next'], { path: 'A:/external' }],
    [['dev', 'demo', '--target', 'master'], { name: 'demo' }],
  ] as const)('routes path and catalog selectors through the same live dev seam: %j', async (argv, selector) => {
    captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(plugin)
    vi.mocked(devPlugin).mockResolvedValue()

    expect(await runCli([...argv])).toBe(0)
    expect(resolvePluginRef).toHaveBeenCalledWith({ root: process.cwd(), selector })
    expect(devPlugin).toHaveBeenCalledWith({
      root: process.cwd(),
      plugin,
      target: argv.at(-1),
    })
  })

  it('rejects invalid targets before starting dev', async () => {
    const output = captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(plugin)

    expect(await runCli(['dev', '--path', 'A:/external', '--target', 'all'])).toBe(1)
    expect(output.errors.join('\n')).toMatch(/next\|master/i)
    expect(devPlugin).not.toHaveBeenCalled()
  })
})

describe('agent-first command and documentation contract', () => {
  it('advertises every first-slice command with catalog and path selectors only', async () => {
    const output = captureConsole()

    expect(await runCli(['--help'])).toBe(0)
    const help = output.logs.join('\n')
    expect(help).toMatch(/inspect\s+<name>\|--path\s+P[\s\S]*\[--json]/i)
    expect(help).toMatch(/dev\s+<name>\|--path\s+P[\s\S]*--target\s+T/i)
    expect(help).toMatch(/verify\s+<name>\|--path\s+P[\s\S]*--target\s+T[\s\S]*\[--json]/i)
    expect(help).toMatch(/status\s+<name>\|--path\s+P[\s\S]*\[--json]/i)
    expect(help).not.toMatch(/^\s*(?:ui|publish|init|generate-skills?)\b/im)
  })

  it('documents mutation/isolation and the portable skill without claiming UI or skill commands exist', () => {
    const docs = [
      readFileSync(new URL('../../README.md', import.meta.url), 'utf8'),
      readFileSync(new URL('../../docs/using-the-lab.md', import.meta.url), 'utf8'),
      readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8'),
    ].join('\n')

    expect(docs).toMatch(/dev[\s\S]{0,160}(?:live|in-place)[\s\S]{0,160}read-only/i)
    expect(docs).toMatch(/verify[\s\S]{0,240}temporary[\s\S]{0,160}(?:always|every)[\s\S]{0,80}(?:remove|clean)/i)
    expect(docs).toMatch(/uncommitted[\s\S]{0,80}untracked[\s\S]{0,160}(?:included|copied)/i)
    expect(docs).toMatch(/evidence[\s\S]{0,160}minimal[\s\S]{0,160}(?:memory|record)/i)
    expect(docs).toMatch(/catalog[\s\S]{0,80}(?:init|initialization)[\s\S]{0,80}optional/i)
    expect(docs).toMatch(/only explicit authoring commands[\s\S]{0,120}mutate/i)
    expect(docs).toMatch(/UI[\s\S]{0,120}(?:not provided|not implemented|future work)/i)
    expect(docs).toMatch(/portable agent (?:entrypoint|skill)[\s\S]{0,200}advisory/i)
    expect(docs).not.toMatch(/\b(?:pnpm\s+)?lab\s+(?:ui|skill)\b/i)
  })
})

describe('inspect CLI', () => {
  const plugin = { sourcePath: 'A:/standalone', packageName: '@fixture/standalone' }

  it('prints concise text diagnostics and maps inspection errors to exit 1', async () => {
    const output = captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(plugin)
    vi.mocked(inspectPlugin).mockReturnValue({
      schemaVersion: 1,
      plugin,
      faces: { host: true, client: 'unknown' },
      diagnostics: [
        {
          code: 'LOCKFILE_MISSING',
          severity: 'error',
          message: 'pnpm-lock.yaml is required',
          remediation: 'Generate and commit the lockfile.',
        },
      ],
      ok: false,
    })

    expect(await runCli(['inspect', '--path', 'A:/standalone'])).toBe(1)
    expect(resolvePluginRef).toHaveBeenCalledWith({
      root: process.cwd(),
      selector: { path: 'A:/standalone' },
    })
    expect(inspectPlugin).toHaveBeenCalledWith({ root: process.cwd(), plugin })
    expect(output.logs).toEqual([
      'plugin @fixture/standalone (A:/standalone)',
      '[error] LOCKFILE_MISSING: pnpm-lock.yaml is required',
      '  fix: Generate and commit the lockfile.',
    ])
  })

  it('prints exactly one JSON document on stdout and forwards target', async () => {
    const output = captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(plugin)
    const result = {
      schemaVersion: 1 as const,
      plugin,
      faces: { host: true, client: false as const },
      diagnostics: [],
      ok: true,
    }
    vi.mocked(inspectPlugin).mockReturnValue(result)

    expect(
      await runCli(['inspect', '--path', 'A:/standalone', '--target', 'master', '--json']),
    ).toBe(0)
    expect(output.logs).toHaveLength(1)
    expect(JSON.parse(output.logs[0]!)).toEqual(result)
    expect(inspectPlugin).toHaveBeenCalledWith({
      root: process.cwd(),
      plugin,
      target: 'master',
    })
  })

  it.each([
    ['--wat'],
    ['--json', '--json'],
    ['--target', 'next', '--target', 'master'],
  ])('rejects unknown or duplicate inspect flags: %j', async (...flags) => {
    const output = captureConsole()
    expect(await runCli(['inspect', '--path', 'A:/standalone', ...flags])).toBe(1)
    expect(output.errors.join('\n')).toMatch(/error:/i)
    expect(inspectPlugin).not.toHaveBeenCalled()
  })
})

describe('verify CLI', () => {
  const standalone = { sourcePath: 'A:/standalone', packageName: '@fixture/standalone' }
  const catalogPlugin = {
    ...standalone,
    catalogName: 'demo',
    metadata: { name: 'demo', tracking: 'local' as const, maturity: 'experiment', targets: ['next'] },
  }

  function verifyResult(result: 'pass' | 'fail' = 'pass') {
    return {
      schemaVersion: 1 as const,
      runId: 'verify-1',
      operation: 'verify' as const,
      result,
      plugin: { ...standalone, digest: `sha256:${'a'.repeat(64)}` as const },
      targets: { next: { dsh: '0.1.1-rc.2', result: result === 'pass' ? 'pass' as const : 'fail' as const } },
      lab: { contextDigest: `sha256:${'b'.repeat(64)}` },
      environment: { node: '22.20.0', pnpm: '11.7.0', platform: process.platform },
      steps: [
        { id: 'inspect', status: 'pass' as const, durationMs: 1 },
        { id: 'target:next', status: result === 'pass' ? 'pass' as const : 'fail' as const, durationMs: 2 },
      ],
      cleanup: 'pass' as const,
      startedAt: '2026-08-23T10:00:00.000Z',
      finishedAt: '2026-08-23T10:00:01.000Z',
    }
  }

  it.each([
    [['verify', '--path', 'A:/standalone', '--target', 'next'], standalone],
    [['verify', 'demo', '--target', 'next'], catalogPlugin],
  ] as const)('routes path and catalog selectors through the same verifier: %j', async (argv, resolved) => {
    captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(resolved)
    vi.mocked(verifyPlugin).mockResolvedValue(verifyResult())

    expect(await runCli([...argv])).toBe(0)
    expect(verifyPlugin).toHaveBeenCalledWith({
      root: process.cwd(),
      plugin: resolved,
      target: 'next',
    })
  })

  it('prints exactly one finalized JSON document and maps failed result to exit 1', async () => {
    const output = captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(standalone)
    const result = verifyResult('fail')
    vi.mocked(verifyPlugin).mockResolvedValue(result)

    expect(
      await runCli(['verify', '--path', 'A:/standalone', '--target', 'next', '--json']),
    ).toBe(1)
    expect(output.logs).toHaveLength(1)
    expect(JSON.parse(output.logs[0]!)).toEqual(result)
  })

  it('suppresses incidental verifier progress so JSON stdout remains one document', async () => {
    const output = captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(standalone)
    const result = verifyResult()
    vi.mocked(verifyPlugin).mockImplementation(async () => {
      console.log('target launcher progress')
      return result
    })

    expect(
      await runCli(['verify', '--path', 'A:/standalone', '--target', 'next', '--json']),
    ).toBe(0)
    expect(output.logs).toHaveLength(1)
    expect(JSON.parse(output.logs[0]!)).toEqual(result)
  })

  it('prints concise step outcomes in text mode', async () => {
    const output = captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(catalogPlugin)
    vi.mocked(verifyPlugin).mockResolvedValue(verifyResult())

    expect(await runCli(['verify', 'demo', '--target', 'next'])).toBe(0)
    expect(output.logs).toEqual([
      '[pass] inspect (1ms)',
      '[pass] target:next (2ms)',
      'verify: pass; cleanup: pass',
    ])
  })

  it('requires an explicit target for a standalone plugin without metadata', async () => {
    const output = captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(standalone)

    expect(await runCli(['verify', '--path', 'A:/standalone'])).toBe(1)
    expect(output.errors.join('\n')).toMatch(/--target.*required|target.*metadata/i)
    expect(verifyPlugin).not.toHaveBeenCalled()
  })

  it('uses a single metadata target when CLI target is omitted', async () => {
    captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(catalogPlugin)
    vi.mocked(verifyPlugin).mockResolvedValue(verifyResult())

    expect(await runCli(['verify', 'demo'])).toBe(0)
    expect(verifyPlugin).toHaveBeenCalledWith(expect.objectContaining({ target: 'next' }))
  })

  it('rejects unsupported metadata targets before invoking verification', async () => {
    const output = captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue({
      ...catalogPlugin,
      metadata: { ...catalogPlugin.metadata, targets: ['next', 'future'] },
    })

    expect(await runCli(['verify', 'demo'])).toBe(1)
    expect(output.errors.join('\n')).toMatch(/unknown.*target.*future|unsupported.*future/i)
    expect(verifyPlugin).not.toHaveBeenCalled()
  })

  it.each([
    ['--target', 'wat'],
    ['--target'],
    ['--target', 'next', '--target', 'master'],
    ['--json', '--json', '--target', 'next'],
    ['--wat', '--target', 'next'],
  ])('rejects invalid verify flags without invocation: %j', async (...flags) => {
    const output = captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(standalone)

    expect(await runCli(['verify', '--path', 'A:/standalone', ...flags])).toBe(1)
    expect(output.errors.join('\n')).toMatch(/error:/i)
    expect(verifyPlugin).not.toHaveBeenCalled()
  })
})

describe('status CLI', () => {
  const plugin = { sourcePath: 'A:/standalone', packageName: '@fixture/standalone' }

  function statusResult(state: 'pass' | 'fail' | 'stale' | 'not-run' = 'pass') {
    const claim = state === 'stale'
      ? { state, runId: 'verify-1', reasons: ['PLUGIN_CONTENT_CHANGED'] }
      : state === 'not-run'
        ? { state }
        : { state, runId: 'verify-1' }
    return {
      schemaVersion: 1 as const,
      plugin: { ...plugin, digest: `sha256:${'a'.repeat(64)}` as const },
      structure: claim,
      bundle: claim,
      targets: { next: claim, master: { state: 'not-applicable' as const } },
      ui: { state: 'not-applicable' as const },
    }
  }

  it('documents the distinct success, incomplete, and tooling-error exit codes', async () => {
    const output = captureConsole()

    expect(await runCli(['--help'])).toBe(0)
    const help = output.logs.join('\n')
    expect(help).toMatch(/status[\s\S]*exit\s*0[\s\S]*(?:current|applicable.*pass)/i)
    expect(help).toMatch(/exit\s*2[\s\S]*(?:stale|not-run|failed)/i)
    expect(help).toMatch(/exit\s*1[\s\S]*(?:selector|tooling|error)/i)
  })

  it.each([
    [['status', '--path', 'A:/standalone'], { path: 'A:/standalone' }],
    [['status', 'demo'], { name: 'demo' }],
  ] as const)('routes path and catalog selectors through the same status derivation: %j', async (argv, selector) => {
    const output = captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(plugin)
    vi.mocked(derivePluginStatus).mockReturnValue(statusResult())

    expect(await runCli([...argv])).toBe(0)
    expect(resolvePluginRef).toHaveBeenCalledWith({ root: process.cwd(), selector })
    expect(derivePluginStatus).toHaveBeenCalledWith({ root: process.cwd(), plugin })
    expect(output.logs.join('\n')).toMatch(/structure.*pass/i)
  })

  it('prints exactly one JSON document and returns 2 for incomplete current claims', async () => {
    const output = captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(plugin)
    const result = statusResult('stale')
    vi.mocked(derivePluginStatus).mockReturnValue(result)

    expect(await runCli(['status', '--path', 'A:/standalone', '--json'])).toBe(2)
    expect(output.logs).toHaveLength(1)
    expect(JSON.parse(output.logs[0]!)).toEqual(result)
  })

  it.each(['fail', 'stale', 'not-run'] as const)('returns 2 when an applicable claim is %s', async state => {
    captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(plugin)
    vi.mocked(derivePluginStatus).mockReturnValue(statusResult(state))

    expect(await runCli(['status', '--path', 'A:/standalone'])).toBe(2)
  })

  it('returns 1 only for resolution or tooling errors', async () => {
    const output = captureConsole()
    vi.mocked(resolvePluginRef).mockReturnValue(plugin)
    vi.mocked(derivePluginStatus).mockImplementation(() => { throw new Error('corrupt evidence path') })

    expect(await runCli(['status', '--path', 'A:/standalone'])).toBe(1)
    expect(output.errors.join('\n')).toContain('corrupt evidence path')
  })

  it.each([
    ['--wat'],
    ['--json', '--json'],
  ])('rejects unknown or duplicate status flags: %j', async (...flags) => {
    const output = captureConsole()
    expect(await runCli(['status', '--path', 'A:/standalone', ...flags])).toBe(1)
    expect(output.errors.join('\n')).toMatch(/error:/i)
    expect(derivePluginStatus).not.toHaveBeenCalled()
  })
})
