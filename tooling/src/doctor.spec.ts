import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctor } from './doctor.js'
import { contextDocuments, snapshotContext } from './sync.js'

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

describe('doctor runtime hygiene', () => {
  // Helper to create a minimal valid root that does not trigger unrelated diagnostics noise
  // (we still filter for runtime messages, but this keeps the fixture realistic).
  function hygieneRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-hygiene-'))
    mkdirSync(join(dir, 'workbench'), { recursive: true })
    // Use current node version to avoid node-mismatch noise; pnpm is pinned to 11.7.0 which matches.
    const nodeVersion = process.versions.node
    writeFileSync(
      join(dir, 'workbench', 'compatibility.yaml'),
      [
        'targets:',
        '  next:',
        `    dsh: 0.1.0-rc.8`,
        '    cordis: 4.0.1',
        `    node: ${nodeVersion}`,
        '    pnpm: 11.7.0',
        '  master:',
        '    repository: deepseek-ai/deepseek-harness',
        `    commit: ${'0'.repeat(40)}`,
        '    pnpm: 11.7.0',
        `    node: ${nodeVersion}`,
      ].join('\n'),
    )
    // Minimal upstream to avoid upstream-missing error
    const upstream = join(dir, 'upstream', 'deepseek-harness')
    mkdirSync(upstream, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: upstream, stdio: 'ignore' })
    writeFileSync(join(upstream, 'f'), 'x')
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: upstream, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: upstream, stdio: 'ignore' })
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim()
    writeFileSync(
      join(dir, 'workbench', 'compatibility.yaml'),
      [
        'targets:',
        '  next:',
        `    dsh: 0.1.0-rc.8`,
        '    cordis: 4.0.1',
        `    node: ${nodeVersion}`,
        '    pnpm: 11.7.0',
        '  master:',
        '    repository: deepseek-ai/deepseek-harness',
        `    commit: ${head}`,
        '    pnpm: 11.7.0',
        `    node: ${nodeVersion}`,
      ].join('\n'),
    )
    writeFileSync(join(dir, 'catalog.yaml'), 'plugins: {}\n')
    return dir
  }

  it('warns on orphaned ephemeral verify profile', async () => {
    const dir = hygieneRoot()
    const profiles = join(dir, '.lab', 'runtime', 'profiles')
    mkdirSync(profiles, { recursive: true })
    const leaked = join(profiles, 'demo-next-verify-123e4567-e89b-12d3-a456-426614174000')
    mkdirSync(leaked, { recursive: true })
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'warn' && r.message.includes(leaked) && /orphaned ephemeral verify profile/i.test(r.message))).toBe(true)
  })

  it('warns on stale fallback directory', async () => {
    const dir = hygieneRoot()
    const profiles = join(dir, '.lab', 'runtime', 'profiles')
    mkdirSync(profiles, { recursive: true })
    const stale = join(profiles, 'demo-next-verify-abc.stale-123')
    mkdirSync(stale, { recursive: true })
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'warn' && r.message.includes(stale) && /stale verify profile fallback/i.test(r.message))).toBe(true)
  })

  it('warns on abandoned terminal ui-session older than 24h', async () => {
    const dir = hygieneRoot()
    const sessionsRoot = join(dir, '.lab', 'runtime', 'ui-sessions')
    const sessionId = 'ui-20260824T120000000Z-a1b2c3d4'
    const sessionDir = join(sessionsRoot, sessionId)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({ schemaVersion: 1, sessionId, state: 'finished', plugin: { packageName: '@fixture/demo', sourcePath: 'A:/plug', digest: `sha256:${'a'.repeat(64)}` }, target: { name: 'next', dsh: '0.1.0-rc.8' }, contextDigest: `sha256:${'b'.repeat(64)}`, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }))
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(sessionDir, old, old)
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'warn' && r.message.includes(sessionDir) && /abandoned terminal UI session/i.test(r.message))).toBe(true)
  })

  it('does not warn on fresh terminal or non-terminal session', async () => {
    const dir = hygieneRoot()
    const sessionsRoot = join(dir, '.lab', 'runtime', 'ui-sessions')
    const freshId = 'ui-20260824T120000000Z-b2c3d4e5'
    const readyId = 'ui-20260824T120000000Z-c3d4e5f6'
    for (const [id, state] of [[freshId, 'finished'], [readyId, 'ready']] as const) {
      const d = join(sessionsRoot, id)
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, 'state.json'), JSON.stringify({ schemaVersion: 1, sessionId: id, state, plugin: { packageName: '@fixture/demo', sourcePath: 'A:/plug', digest: `sha256:${'a'.repeat(64)}` }, target: { name: 'next', dsh: '0.1.0-rc.8' }, contextDigest: `sha256:${'b'.repeat(64)}`, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }))
    }
    const res = await doctor({ root: dir })
    const hygieneWarns = res.filter(r => r.level === 'warn' && /UI session/i.test(r.message))
    expect(hygieneWarns.length).toBe(0)
  })

  it('produces no runtime diagnostics when .lab/runtime is absent', async () => {
    const dir = hygieneRoot()
    const res = await doctor({ root: dir })
    const hygieneWarns = res.filter(r => r.level === 'warn' && /(verify profile|UI session|runtime)/i.test(r.message))
    expect(hygieneWarns.length).toBe(0)
  })

  it('warns on malformed state.json without throwing', async () => {
    const dir = hygieneRoot()
    const sessionsRoot = join(dir, '.lab', 'runtime', 'ui-sessions')
    const badId = 'ui-20260824T120000000Z-d4e5f6a7'
    const badDir = join(sessionsRoot, badId)
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'state.json'), '{ not json')
    await expect(doctor({ root: dir })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ level: 'warn', message: expect.stringContaining('unreadable UI session state') })]))
  })
})
