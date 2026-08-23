import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctor } from './doctor.js'
import { contextDocuments, snapshotContext } from './sync.js'
import { AGENT_SKILL_PATH, renderAgentSkill, SKILL_SOURCE_PATH } from './skill.js'

const SKILL_BODY = [
  '# DSH Plugin Development',
  '',
  'Use the forge as the agent-owned environment.',
  '',
  '## Contracts',
  '',
  '- [Harness contracts](../../../context/harness-contracts.md)',
].join('\n')

function writeSkillContext(root: string): void {
  mkdirSync(join(root, 'context'), { recursive: true })
  writeFileSync(join(root, SKILL_SOURCE_PATH), SKILL_BODY)
  writeFileSync(join(root, 'context', 'harness-contracts.md'), '# Harness contracts\n')
}

function writeCurrentSkill(root: string): string {
  writeSkillContext(root)
  const body = readFileSync(join(root, SKILL_SOURCE_PATH), 'utf8')
  const rendered = renderAgentSkill({ body, documents: contextDocuments(root) })
  const path = join(root, AGENT_SKILL_PATH)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, rendered)
  return path
}

const VALID_MANIFEST = (commit: string): string =>
  [
    'targets:',
    '  next:',
    '    dsh: 0.1.0-rc.8',
    '    cordis: 4.0.1',
    '    node: 1.0.0',
    '    pnpm: 11.7.0',
    '  master:',
    '    repository: deepseek-ai/deepseek-harness',
    `    commit: ${commit}`,
    '    pnpm: 11.7.0',
    '    node: ^22.19.0',
  ].join('\n')

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-'))
  mkdirSync(join(dir, 'workbench'), { recursive: true })
  writeFileSync(join(dir, 'workbench', 'compatibility.yaml'), VALID_MANIFEST('0'.repeat(40)))
  return dir
}

function git(opts: { dir: string; args: string[] }): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...opts.args], {
    cwd: opts.dir,
    stdio: 'ignore',
  })
}

function initCommit(dir: string): string {
  git({ dir, args: ['init', '-q'] })
  writeFileSync(join(dir, 'f'), 'x')
  git({ dir, args: ['add', '.'] })
  git({ dir, args: ['commit', '-qm', 'init'] })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
}

describe('doctor', () => {
  it('reports missing compatibility manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-'))
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'error' && /compatibility/i.test(r.message))).toBe(true)
  })

  it('reports version mismatch between manifest and installed node', async () => {
    const dir = tmpRoot()
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'error' && /node/i.test(r.message))).toBe(true)
  })

  it('reports missing upstream checkout as an error', async () => {
    const dir = tmpRoot()
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'error' && /upstream/i.test(r.message))).toBe(true)
  })

  it('reports an upstream HEAD that does not match the pinned commit', async () => {
    const dir = tmpRoot()
    const upstream = join(dir, 'upstream', 'deepseek-harness')
    mkdirSync(upstream, { recursive: true })
    initCommit(upstream) // real HEAD, but pin is all-zeros
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'error' && /does not match pinned master/i.test(r.message))).toBe(
      true,
    )
  })

  it('reports a dirty upstream submodule', async () => {
    const dir = tmpRoot()
    const upstream = join(dir, 'upstream', 'deepseek-harness')
    mkdirSync(upstream, { recursive: true })
    const head = initCommit(upstream)
    writeFileSync(join(dir, 'workbench', 'compatibility.yaml'), VALID_MANIFEST(head))
    writeFileSync(join(upstream, 'f'), 'changed') // dirt
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'error' && /working tree is dirty/i.test(r.message))).toBe(true)
  })

  it('reports no upstream error for a clean, pinned upstream', async () => {
    const dir = tmpRoot()
    const upstream = join(dir, 'upstream', 'deepseek-harness')
    mkdirSync(upstream, { recursive: true })
    const head = initCommit(upstream)
    writeFileSync(join(dir, 'workbench', 'compatibility.yaml'), VALID_MANIFEST(head))
    const res = await doctor({ root: dir })
    expect(res.some(r => /upstream/i.test(r.message))).toBe(false)
  })

  it('reports a stale or missing shared-context snapshot', async () => {
    const dir = tmpRoot()
    // A cataloged plugin with an out-of-date snapshot digest.
    mkdirSync(join(dir, 'context'), { recursive: true })
    writeFileSync(join(dir, 'context', 'a.md'), 'hello')
    mkdirSync(join(dir, 'plugins', 'demo', '.dsh-lab'), { recursive: true })
    const canonical = snapshotContext(dir, [readFileSync(join(dir, 'context', 'a.md'), 'utf8')])
    const canonicalHash = /^> context version: (\S+)$/m.exec(canonical)?.[1]
    writeFileSync(
      join(dir, 'plugins', 'demo', '.dsh-lab', 'shared-context.md'),
      `# Shared context snapshot\n\n> context version: deadbeef\n\nstale\n`,
    )
    writeFileSync(
      join(dir, 'catalog.yaml'),
      ['plugins:', '  demo:', '    path: plugins/demo', '    tracking: local', '    maturity: experiment'].join('\n') + '\n',
    )
    const res = await doctor({ root: dir })
    expect(canonicalHash).toBeTruthy()
    expect(res.some(r => r.level === 'error' && /stale shared context for plugin 'demo'/i.test(r.message))).toBe(
      true,
    )
  })

  it('reports a missing generated agent skill without creating it', async () => {
    const dir = tmpRoot()
    writeSkillContext(dir)
    const path = join(dir, AGENT_SKILL_PATH)

    const res = await doctor({ root: dir })

    expect(res.some(r => r.level === 'error' && /stale agent skill.*lab sync-context/i.test(r.message))).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('reports a tampered generated agent skill without repairing its bytes', async () => {
    const dir = tmpRoot()
    const path = writeCurrentSkill(dir)
    writeFileSync(path, 'tampered\n')

    const res = await doctor({ root: dir })

    expect(res.some(r => r.level === 'error' && /stale agent skill.*lab sync-context/i.test(r.message))).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('tampered\n')
  })

  it('accepts renderer-identical generated agent skill content', async () => {
    const dir = tmpRoot()
    writeCurrentSkill(dir)

    const res = await doctor({ root: dir })

    expect(res.some(r => /agent skill/i.test(r.message))).toBe(false)
  })

  it('reports the committed projection stale after another context document changes', async () => {
    const dir = tmpRoot()
    writeCurrentSkill(dir)
    writeFileSync(join(dir, 'context', 'harness-contracts.md'), '# Harness contracts changed\n')

    const res = await doctor({ root: dir })

    expect(res.some(r => r.level === 'error' && /stale agent skill.*lab sync-context/i.test(r.message))).toBe(true)
  })

  it('reports a cataloged plugin whose Cordis deps mismatch its declared target pin', async () => {
    const dir = tmpRoot()
    const plugin = join(dir, 'plugins', 'mismatch')
    mkdirSync(join(plugin, '.dsh-lab'), { recursive: true })
    writeFileSync(
      join(plugin, '.dsh-lab', 'plugin.yaml'),
      ['name: mismatch', 'tracking: local', 'maturity: experiment', 'targets:', '  - next'].join('\n') + '\n',
    )
    writeFileSync(
      join(plugin, 'package.json'),
      JSON.stringify({
        name: '@dsh-lab/dsh-plugin-mismatch',
        peerDependencies: { '@deepseek-ai/cordis': '4.0.99' },
        devDependencies: { '@deepseek-ai/cordis': '4.0.1' },
      }),
    )
    writeFileSync(
      join(dir, 'catalog.yaml'),
      ['plugins:', '  mismatch:', '    path: plugins/mismatch', '    tracking: local', '    maturity: experiment'].join('\n') + '\n',
    )
    const res = await doctor({ root: dir })
    expect(
      res.some(r => r.level === 'error' && /plugin 'mismatch' peerDependencies\['@deepseek-ai\/cordis'\]/i.test(r.message)),
    ).toBe(true)
  })

  it('reports a dirty cataloged submodule', async () => {
    const dir = tmpRoot()
    const sub = join(dir, 'plugins', 'demo')
    mkdirSync(sub, { recursive: true })
    initCommit(sub)
    writeFileSync(join(sub, 'f'), 'changed') // dirt
    writeFileSync(
      join(dir, 'catalog.yaml'),
      [
        'plugins:',
        '  demo:',
        '    path: plugins/demo',
        '    repository: https://github.com/example/demo',
        '    tracking: submodule',
        '    maturity: experiment',
      ].join('\n') + '\n',
    )
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'error' && /submodule 'plugins\/demo' working tree is dirty/i.test(r.message))).toBe(
      true,
    )
  })

  it('reports a submodule checked out at a different commit than the recorded gitlink', async () => {
    const dir = tmpRoot()
    const sub = join(dir, 'plugins', 'demo')
    mkdirSync(sub, { recursive: true })
    initCommit(sub) // commit A
    // Parent records the nested repo as a gitlink at commit A.
    git({ dir, args: ['init', '-q'] })
    git({ dir, args: ['add', 'plugins/demo'] })
    git({ dir, args: ['commit', '-qm', 'add submodule'] })
    // Advance the nested repo to commit B with a CLEAN working tree; git status
    // --porcelain is empty, but the parent's gitlink still points at A.
    writeFileSync(join(sub, 'f'), 'advanced')
    git({ dir: sub, args: ['add', '.'] })
    git({ dir: sub, args: ['commit', '-qm', 'advance'] })
    writeFileSync(
      join(dir, 'catalog.yaml'),
      [
        'plugins:',
        '  demo:',
        '    path: plugins/demo',
        '    repository: https://github.com/example/demo',
        '    tracking: submodule',
        '    maturity: experiment',
      ].join('\n') + '\n',
    )
    const res = await doctor({ root: dir })
    expect(
      res.some(r => r.level === 'error' && /does not match the meta-repo gitlink/i.test(r.message)),
    ).toBe(true)
  })
})
