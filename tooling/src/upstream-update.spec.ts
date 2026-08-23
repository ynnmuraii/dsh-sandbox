import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkUpstream,
  replaceMasterCommit,
  updateUpstream,
  type CommandRunner,
} from './upstream-update.js'

const PINNED = '1'.repeat(40)
const REMOTE = '2'.repeat(40)
const roots: string[] = []

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upstream-check-'))
  roots.push(root)
  mkdirSync(join(root, 'workbench'), { recursive: true })
  mkdirSync(join(root, 'upstream', 'deepseek-harness'), { recursive: true })
  writeFileSync(
    join(root, 'workbench', 'compatibility.yaml'),
    `targets:\n  next:\n    dsh: 0.1.1-rc.2\n    cordis: 4.0.1\n    node: 22.20.0\n    pnpm: 11.7.0\n  master:\n    repository: deepseek-ai/deepseek-harness\n    commit: ${PINNED}\n    pnpm: 11.7.0\n    node: ^22.19.0\n`,
  )
  writeFileSync(
    join(root, '.gitmodules'),
    '[submodule "upstream/deepseek-harness"]\n\tpath = upstream/deepseek-harness\n\turl = https://example.test/deepseek-harness.git\n',
  )
  return root
}

function runner(remoteOutput: string, origin = 'https://example.test/deepseek-harness.git'):
  CommandRunner & { calls: Array<{ cmd: string; args: string[]; cwd: string }> } {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = []
  return {
    calls,
    run(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts.cwd })
      if (args[0] === 'config') return origin
      if (args[0] === 'ls-remote') return remoteOutput
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`)
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('checkUpstream', () => {
  it('reports an exact matching master ref as current without mutating or fetching', () => {
    const root = fixtureRoot()
    const commands = runner(`${PINNED}\trefs/heads/master\n`)

    expect(checkUpstream({ root, runner: commands })).toEqual({
      pinned: PINNED,
      remote: PINNED,
      current: true,
    })
    expect(commands.calls.map(call => call.args[0])).toEqual(['config', 'ls-remote'])
  })

  it('reports a different exact master ref as stale', () => {
    const status = checkUpstream({
      root: fixtureRoot(),
      runner: runner(`${REMOTE}\trefs/heads/master\n`),
    })
    expect(status).toEqual({ pinned: PINNED, remote: REMOTE, current: false })
  })

  it('falls back to the matching .gitmodules URL when the checkout has no origin', () => {
    const root = fixtureRoot()
    const calls: string[][] = []
    const noOrigin: CommandRunner = {
      run(_cmd, args) {
        calls.push(args)
        if (args[0] === 'config') throw new Error('origin is not configured')
        if (args[0] === 'ls-remote') return `${PINNED}\trefs/heads/master\n`
        throw new Error(`unexpected args: ${args.join(' ')}`)
      },
    }

    expect(checkUpstream({ root, runner: noOrigin }).current).toBe(true)
    expect(calls[1]).toEqual([
      'ls-remote',
      'https://example.test/deepseek-harness.git',
      'refs/heads/master',
    ])
  })

  it.each([
    ['', /exactly one/],
    [`${REMOTE}\trefs/heads/main\n`, /refs\/heads\/master/],
    [`${REMOTE}\trefs/heads/master\n${PINNED}\trefs/heads/master\n`, /exactly one/],
    [`short\trefs/heads/master\n`, /40-character/],
  ])('rejects an invalid remote response %#', (output, expected) => {
    expect(() => checkUpstream({ root: fixtureRoot(), runner: runner(output) })).toThrow(expected)
  })
})

describe('replaceMasterCommit', () => {
  it('replaces exactly the master commit while preserving every other byte', () => {
    const input = `targets:\n  next:\n    dsh: 0.1.1-rc.2\n  master:\n    repository: deepseek-ai/deepseek-harness\n    commit: ${PINNED}\n    node: ^22.19.0\n`
    expect(replaceMasterCommit(input, PINNED, REMOTE)).toBe(
      input.replace(`    commit: ${PINNED}`, `    commit: ${REMOTE}`),
    )
  })

  it('rejects missing or duplicate current pins', () => {
    expect(() => replaceMasterCommit('targets:\n  master: {}\n', PINNED, REMOTE)).toThrow(/exactly once/)
    expect(() => replaceMasterCommit(`${PINNED}\n${PINNED}\n`, PINNED, REMOTE)).toThrow(/exactly once/)
  })
})

function adoptionRunner(opts: {
  remote?: string
  rootDirty?: string
  upstreamDirty?: string
} = {}): CommandRunner & { calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = []
  return {
    calls,
    run(_cmd, args, commandOpts) {
      calls.push({ args, cwd: commandOpts.cwd })
      if (args[0] === 'status') {
        return commandOpts.cwd.endsWith(join('upstream', 'deepseek-harness'))
          ? (opts.upstreamDirty ?? '')
          : (opts.rootDirty ?? '')
      }
      if (args[0] === 'fetch') return ''
      if (args[0] === 'rev-parse') return opts.remote ?? REMOTE
      if (args[0] === 'checkout') return ''
      throw new Error(`unexpected command: git ${args.join(' ')}`)
    },
  }
}

function services(overrides: Record<string, unknown> = {}) {
  return {
    doctor: async () => [],
    pnpm: () => '',
    buildUpstream: async () => 'upstream/apps/cli/lib/bin.js',
    verifyBundle: async () => undefined,
    ...overrides,
  }
}

describe('updateUpstream', () => {
  it('rejects a dirty meta-repo before fetch', async () => {
    const commands = adoptionRunner({ rootDirty: ' M tracked-file\n' })
    await expect(
      updateUpstream({ root: fixtureRoot(), verify: false, runner: commands, services: services() }),
    ).rejects.toThrow(/meta-repo.*dirty/i)
    expect(commands.calls.some(call => call.args[0] === 'fetch')).toBe(false)
  })

  it('rejects a dirty upstream checkout before fetch', async () => {
    const commands = adoptionRunner({ upstreamDirty: ' M tracked-file\n' })
    await expect(
      updateUpstream({ root: fixtureRoot(), verify: false, runner: commands, services: services() }),
    ).rejects.toThrow(/upstream.*dirty/i)
    expect(commands.calls.some(call => call.args[0] === 'fetch')).toBe(false)
  })

  it('returns a no-op when fetched master is already pinned', async () => {
    const commands = adoptionRunner({ remote: PINNED })
    const result = await updateUpstream({
      root: fixtureRoot(),
      verify: false,
      runner: commands,
      services: services(),
    })
    expect(result).toEqual({ previous: PINNED, adopted: PINNED, changed: false, verifiedPlugins: [] })
    expect(commands.calls.some(call => call.args[0] === 'checkout')).toBe(false)
  })

  it('adopts a stale fetched commit, changes only the pin, then runs doctor', async () => {
    const root = fixtureRoot()
    const manifestPath = join(root, 'workbench', 'compatibility.yaml')
    const before = readFile(manifestPath)
    let doctorCalls = 0
    const result = await updateUpstream({
      root,
      verify: false,
      runner: adoptionRunner(),
      services: services({ doctor: async () => { doctorCalls += 1; return [] } }),
    })

    expect(result).toEqual({ previous: PINNED, adopted: REMOTE, changed: true, verifiedPlugins: [] })
    expect(readFile(manifestPath)).toBe(before.replace(PINNED, REMOTE))
    expect(doctorCalls).toBe(1)
  })

  it('leaves a failed adopted candidate visible and never issues rollback commands', async () => {
    const root = fixtureRoot()
    const commands = adoptionRunner()
    await expect(
      updateUpstream({
        root,
        verify: false,
        runner: commands,
        services: services({
          doctor: async () => [{ level: 'error', message: 'candidate mismatch' }],
        }),
      }),
    ).rejects.toThrow(/doctor.*candidate mismatch/i)
    expect(readFile(join(root, 'workbench', 'compatibility.yaml'))).toContain(REMOTE)
    expect(commands.calls.some(call => ['reset', 'restore', 'clean'].includes(call.args[0]!))).toBe(false)
  })

  it('labels a fetch failure before any mutation', async () => {
    const base = adoptionRunner()
    const failingFetch: CommandRunner = {
      run(cmd, args, opts) {
        if (args[0] === 'fetch') throw new Error('remote unavailable')
        return base.run(cmd, args, opts)
      },
    }
    const root = fixtureRoot()
    await expect(
      updateUpstream({ root, verify: false, runner: failingFetch, services: services() }),
    ).rejects.toThrow(/fetch.*remote unavailable/i)
    expect(readFile(join(root, 'workbench', 'compatibility.yaml'))).toContain(PINNED)
  })

  it('labels verification failures and leaves the adopted candidate visible', async () => {
    const root = fixtureRoot()
    writeFileSync(join(root, 'catalog.yaml'), 'plugins: {}\n')
    await expect(
      updateUpstream({
        root,
        verify: true,
        runner: adoptionRunner(),
        services: services({ buildUpstream: async () => { throw new Error('build exploded') } }),
      }),
    ).rejects.toThrow(/verification.*build exploded/i)
    expect(readFile(join(root, 'workbench', 'compatibility.yaml'))).toContain(REMOTE)
  })

  it('with verify runs root checks, builds once, and verifies only master plugins', async () => {
    const root = fixtureRoot()
    mkdirSync(join(root, 'plugins', 'both', '.dsh-lab'), { recursive: true })
    mkdirSync(join(root, 'plugins', 'next-only', '.dsh-lab'), { recursive: true })
    writeFileSync(
      join(root, 'catalog.yaml'),
      'plugins:\n  both:\n    path: plugins/both\n    tracking: local\n  next-only:\n    path: plugins/next-only\n    tracking: local\n',
    )
    writeFileSync(join(root, 'plugins', 'both', '.dsh-lab', 'plugin.yaml'), 'targets: [next, master]\n')
    writeFileSync(join(root, 'plugins', 'next-only', '.dsh-lab', 'plugin.yaml'), 'targets: [next]\n')
    const pnpmCalls: string[][] = []
    const verified: Array<{ name: string; masterBin: string | undefined }> = []
    let builds = 0

    const result = await updateUpstream({
      root,
      verify: true,
      runner: adoptionRunner(),
      services: services({
        pnpm: (args: string[]) => { pnpmCalls.push(args); return '' },
        buildUpstream: async () => { builds += 1; return 'bin.js' },
        verifyBundle: async ({ name, masterBin }: { name: string; masterBin?: string }) => {
          verified.push({ name, masterBin })
        },
      }),
    })

    expect(pnpmCalls).toEqual([['typecheck'], ['test']])
    expect(builds).toBe(1)
    expect(verified).toEqual([{ name: 'both', masterBin: 'bin.js' }])
    expect(result.verifiedPlugins).toEqual(['both'])
  })

  it('without verify skips root checks, build, and plugin verification', async () => {
    let expensiveCalls = 0
    await updateUpstream({
      root: fixtureRoot(),
      verify: false,
      runner: adoptionRunner(),
      services: services({
        pnpm: () => { expensiveCalls += 1; return '' },
        buildUpstream: async () => { expensiveCalls += 1; return 'bin.js' },
        verifyBundle: async () => { expensiveCalls += 1 },
      }),
    })
    expect(expensiveCalls).toBe(0)
  })
})

function readFile(path: string): string {
  return readFileSync(path, 'utf8')
}
