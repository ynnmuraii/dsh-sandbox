import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotContext, syncContext } from './sync.js'

function writeContext(root: string): void {
  mkdirSync(join(root, 'context'), { recursive: true })
  writeFileSync(join(root, 'context', 'harness-contracts.md'), '# Harness contracts\n')
}

describe('snapshotContext', () => {
  it('embeds a version hash of the inputs', () => {
    const a = snapshotContext('/root', ['# c1\n'])
    const b = snapshotContext('/root', ['# c1\n'])
    const c = snapshotContext('/root', ['# c1 changed\n'])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^# Shared context snapshot/)
  })
})

describe('syncContext', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-sync-'))
    writeContext(dir)
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('writes a snapshot into each plugin repo', async () => {
    writeFileSync(join(dir, 'catalog.yaml'), 'plugins:\n  a:\n    path: plugins/a\n    tracking: local\n')
    writeFileSync(join(dir, 'workbench-compat-stub'), '')
    mkdirSync(join(dir, 'plugins', 'a'), { recursive: true })
    writeFileSync(join(dir, 'plugins', 'a', 'package.json'), '{}')
    execFileSync('git', ['init', '-q'], { cwd: join(dir, 'plugins', 'a') })
    const res = await syncContext({ root: dir, names: ['a'], all: false })
    expect(res[0]!.path).toBe(join(dir, 'plugins', 'a', '.dsh-lab', 'shared-context.md'))
    expect(res[0]!.kind).toBe('plugin-context')
    expect(readFileSync(res[0]!.path, 'utf8')).toMatch(/^# Shared context snapshot/)
  })

  it('refuses to sync when the plugin repo is missing (no manufactured .dsh-lab)', async () => {
    // Cataloged 'a' has no plugins/a directory at all -> must refuse instead of
    // fabricating a standalone repo.
    writeFileSync(join(dir, 'catalog.yaml'), 'plugins:\n  a:\n    path: plugins/a\n    tracking: local\n')
    await expect(syncContext({ root: dir, names: ['a'], all: false })).rejects.toThrow(/missing or not a git repo/)
    expect(existsSync(join(dir, 'plugins', 'a', '.dsh-lab'))).toBe(false)
  })

  it('rejects a requested name outside the catalog before writing the root skill', async () => {
    writeFileSync(join(dir, 'catalog.yaml'), 'plugins:\n  a:\n    path: plugins/a\n    tracking: local\n')
    await expect(
      syncContext({ root: dir, names: ['constructor'], all: false }),
    ).rejects.toThrow(/unknown plugin.*constructor/i)
  })

  it('rejects an unknown prototype-like name when the catalog is missing', async () => {
    mkdirSync(join(dir, 'plugins', 'constructor'), { recursive: true })
    await expect(
      syncContext({ root: dir, names: ['constructor'], all: false }),
    ).rejects.toThrow(/unknown plugin.*constructor/i)
  })

  it('preflights every named target before writing any projection', async () => {
    writeFileSync(
      join(dir, 'catalog.yaml'),
      'plugins:\n  valid:\n    path: plugins/valid\n    tracking: local\n',
    )
    const valid = join(dir, 'plugins', 'valid')
    mkdirSync(valid, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: valid })

    await expect(
      syncContext({ root: dir, names: ['valid', 'unknown'], all: false }),
    ).rejects.toThrow(/unknown plugin.*unknown/i)

    expect(existsSync(join(valid, '.dsh-lab', 'shared-context.md'))).toBe(false)
  })

  it('syncs every catalog plugin in catalog order and is fully idempotent', async () => {
    writeFileSync(
      join(dir, 'catalog.yaml'),
      [
        'plugins:',
        '  beta:',
        '    path: plugins/beta',
        '    tracking: local',
        '  alpha:',
        '    path: plugins/alpha',
        '    tracking: local',
      ].join('\n') + '\n',
    )
    for (const name of ['beta', 'alpha']) {
      const plugin = join(dir, 'plugins', name)
      mkdirSync(plugin, { recursive: true })
      execFileSync('git', ['init', '-q'], { cwd: plugin })
    }

    const first = await syncContext({ root: dir, names: [], all: true })
    const second = await syncContext({ root: dir, names: [], all: true })

    expect(first.map(result => [result.kind, result.name, result.changed])).toEqual([
      ['plugin-context', 'beta', true],
      ['plugin-context', 'alpha', true],
    ])
    expect(second.map(result => [result.kind, result.name, result.changed])).toEqual([
      ['plugin-context', 'beta', false],
      ['plugin-context', 'alpha', false],
    ])
  })

  it('preflights every --all target before writing any projection', async () => {
    writeFileSync(
      join(dir, 'catalog.yaml'),
      [
        'plugins:',
        '  present:',
        '    path: plugins/present',
        '    tracking: local',
        '  missing:',
        '    path: plugins/missing',
        '    tracking: local',
      ].join('\n') + '\n',
    )
    const present = join(dir, 'plugins', 'present')
    mkdirSync(present, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: present })

    await expect(syncContext({ root: dir, names: [], all: true })).rejects.toThrow(
      /missing or not a git repo.*missing/i,
    )

    expect(existsSync(join(present, '.dsh-lab', 'shared-context.md'))).toBe(false)
  })

  it('does not create host-specific or plugin-local skill mirrors', async () => {
    await syncContext({ root: dir, names: [], all: false })
    expect(existsSync(join(dir, '.dsh', 'skills', 'dsh-plugin-development'))).toBe(false)
    expect(existsSync(join(dir, '.codex', 'skills', 'dsh-plugin-development'))).toBe(false)
    expect(existsSync(join(dir, 'skills', 'dsh-plugin-development'))).toBe(false)
    expect(existsSync(join(dir, 'plugins', 'a', '.agents'))).toBe(false)
  })
})
