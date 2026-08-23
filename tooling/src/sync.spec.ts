import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotContext, syncContext } from './sync.js'

const SKILL_PATH = join('.agents', 'skills', 'dsh-plugin-development', 'SKILL.md')
const SKILL_BODY = [
  '# DSH Plugin Development',
  '',
  'Use the forge as the agent-owned environment.',
  '',
  '## Contracts',
  '',
  '- [Harness contracts](../../../context/harness-contracts.md)',
].join('\n')

function writeContext(root: string): void {
  mkdirSync(join(root, 'context'), { recursive: true })
  writeFileSync(join(root, 'context', 'dsh-plugin-development-skill.md'), SKILL_BODY)
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
    expect(res.at(-1)?.kind).toBe('agent-skill')
  })

  it('regenerates only the root agent skill when no plugin target is requested', async () => {
    const res = await syncContext({ root: dir, names: [], all: false })
    const skill = res.find(result => result.kind === 'agent-skill')

    expect(res).toHaveLength(1)
    expect(skill).toEqual({
      kind: 'agent-skill',
      name: 'dsh-plugin-development',
      changed: true,
      path: join(dir, SKILL_PATH),
    })
    expect(readFileSync(join(dir, SKILL_PATH), 'utf8')).toMatch(
      /^---\nname: dsh-plugin-development\n/,
    )
  })

  it('is idempotent and treats CRLF-equivalent generated content as current', async () => {
    await syncContext({ root: dir, names: [], all: false })
    const path = join(dir, SKILL_PATH)
    const generated = readFileSync(path, 'utf8')
    writeFileSync(path, generated.replaceAll('\n', '\r\n'))

    const res = await syncContext({ root: dir, names: [], all: false })
    expect(res).toEqual([
      {
        kind: 'agent-skill',
        name: 'dsh-plugin-development',
        changed: false,
        path,
      },
    ])
    expect(readFileSync(path, 'utf8')).toContain('\r\n')
  })

  it('refuses to sync when the plugin repo is missing (no manufactured .dsh-lab)', async () => {
    // Cataloged 'a' has no plugins/a directory at all -> must refuse instead of
    // fabricating a standalone repo.
    writeFileSync(join(dir, 'catalog.yaml'), 'plugins:\n  a:\n    path: plugins/a\n    tracking: local\n')
    await expect(syncContext({ root: dir, names: ['a'], all: false })).rejects.toThrow(/missing or not a git repo/)
    expect(existsSync(join(dir, 'plugins', 'a', '.dsh-lab'))).toBe(false)
    expect(existsSync(join(dir, SKILL_PATH))).toBe(false)
  })

  it('ignores named targets not in the catalog (incl. prototype keys)', async () => {
    writeFileSync(join(dir, 'catalog.yaml'), 'plugins:\n  a:\n    path: plugins/a\n    tracking: local\n')
    mkdirSync(join(dir, 'plugins', 'a'), { recursive: true })
    const res = await syncContext({ root: dir, names: ['constructor'], all: false })
    expect(res).toHaveLength(0)
  })

  it('does not crash when catalog is missing and a name collides with a prototype key', async () => {
    // No catalog.yaml present -> plugins = {}; 'constructor' must resolve to
    // "not found" rather than the inherited Object constructor.
    mkdirSync(join(dir, 'plugins', 'constructor'), { recursive: true })
    const res = await syncContext({ root: dir, names: ['constructor'], all: false })
    expect(res.map(result => result.kind)).toEqual(['agent-skill'])
  })

  it('does not create host-specific or plugin-local skill mirrors', async () => {
    await syncContext({ root: dir, names: [], all: false })
    expect(existsSync(join(dir, '.dsh', 'skills', 'dsh-plugin-development'))).toBe(false)
    expect(existsSync(join(dir, '.codex', 'skills', 'dsh-plugin-development'))).toBe(false)
    expect(existsSync(join(dir, 'skills', 'dsh-plugin-development'))).toBe(false)
    expect(existsSync(join(dir, 'plugins', 'a', '.agents'))).toBe(false)
  })
})
