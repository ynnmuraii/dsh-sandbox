import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctor } from './doctor.js'
import { snapshotContext } from './sync.js'

const VALID_MANIFEST = (commit: string): string =>
  [
    'targets:',
    '  next:',
    '    dsh: 0.1.0-rc.8',
    '    cordis: 4.0.1',
    '    node: 1.0.0',
    '  master:',
    '    repository: deepseek-ai/deepseek-harness',
    `    commit: ${commit}`,
    '    pnpm: 11.7.0',
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
})
