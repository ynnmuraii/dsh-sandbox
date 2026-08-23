import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePluginSelector, runCli } from './cli.js'
import { checkUpstream, updateUpstream } from './upstream-update.js'

vi.mock('./upstream-update.js', () => ({
  checkUpstream: vi.fn(),
  updateUpstream: vi.fn(),
}))

const PINNED = '1'.repeat(40)
const REMOTE = '2'.repeat(40)

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(checkUpstream).mockReset()
  vi.mocked(updateUpstream).mockReset()
})

function captureConsole() {
  const logs: string[] = []
  const errors: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')))
  return { logs, errors }
}

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
