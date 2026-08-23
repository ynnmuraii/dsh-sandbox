import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  resolveSourceOverlay,
  buildProfilePackageJson,
  buildSourceOverlay,
  buildDevOverlay,
  verifyAllTargets,
  upstreamWorkingTreeDirty,
  DEV_WEB_BUNDLES,
  buildProfileWorkspaceYaml,
  profileName,
  resolveTsxLoader,
  verifyPackedTarget,
  buildUpstream,
} from './run.js'
import { pnpm } from './proc.js'

vi.mock('./proc.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./proc.js')>()),
  pnpm: vi.fn(),
}))

describe('resolveSourceOverlay', () => {
  it('produces an absolute path to the plugin entry', () => {
    const p = resolveSourceOverlay('workspace', 'plugins/example', 'src/index.ts', 'example')
    expect(p).toBe(pathToFileURL(resolve('workspace', 'plugins/example', 'src/index.ts')).href)
    expect(p).toMatch(/^file:/)
  })
})

describe('buildProfilePackageJson', () => {
  it('pins the dsh bundle and an exact version', () => {
    const spec = { name: 'dsh-profile-next', bundles: ['@deepseek-ai/dsh-base'] }
    const out = buildProfilePackageJson(spec, { dsh: '0.1.0-rc.8' })
    expect(out.dependencies['@deepseek-ai/dsh']).toBe('0.1.0-rc.8')
    expect(out).toHaveProperty('dsh')
  })

  it('omits the launcher dependency when no pin is given (master composes against the built bin)', () => {
    const spec = { name: 'dsh-profile-master', bundles: ['@deepseek-ai/dsh-base'] }
    const out = buildProfilePackageJson(spec, {})
    expect(out.dependencies).toEqual({})
    expect(out.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('carries the full web bundle stack so the dev profile boots a real web composition', () => {
    // Finding P1-1 wave 2: the dev profile must not be left with only the base
    // bundle — booting it by name must compose the web-app surface too.
    const spec = { name: '@dsh-lab/profile-next', bundles: DEV_WEB_BUNDLES }
    const out = buildProfilePackageJson(spec, { dsh: '0.1.0-rc.8' })
    expect(out.dsh.profile.bundles).toContain('@deepseek-ai/dsh-base')
    expect(out.dsh.profile.bundles).toContain('@deepseek-ai/dsh-web-app')
    expect(DEV_WEB_BUNDLES.length).toBeGreaterThan(1)
  })
})

describe('verifyAllTargets', () => {
  it('exports packed-target verification as the outer verifier seam', () => {
    expect(verifyPackedTarget).toBeTypeOf('function')
  })

  it('dispatches next then master and does not skip master when next fails', async () => {
    const calls: string[] = []
    await expect(
      verifyAllTargets('root', 'example', async target => {
        calls.push(target)
        if (target === 'next') throw new Error('boom next')
      }),
    ).rejects.toThrow(/next: boom next/)
    // Both declared targets run under --target all; a failing next does not
    // collapse the aggregate to a single non-master run.
    expect(calls).toEqual(['next', 'master'])
  })

  it('reports every failing target together', async () => {
    await expect(
      verifyAllTargets('root', 'example', async target => {
        throw new Error(`synthetic ${target}`)
      }),
    ).rejects.toThrow(/next: synthetic next[\s\S]*master: synthetic master/)
  })

  it('removes a packed-target profile when setup fails before launcher execution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-packed-target-cleanup-'))
    try {
      await expect(verifyPackedTarget({
        root,
        pluginName: 'demo',
        target: 'next',
        tarball: join(root, 'demo.tgz'),
        compat: {
          targets: {
            next: { cordis: '4.0.1', node: '22.20.0', pnpm: '11.7.0' },
            master: {
              repository: 'deepseek-ai/deepseek-harness',
              commit: '1'.repeat(40),
              node: '^22.19.0',
              pnpm: '11.7.0',
            },
          },
        },
      })).rejects.toThrow(/pinned dsh|requires.*dsh/i)
      const profiles = join(root, '.lab', 'runtime', 'profiles')
      expect(existsSync(profiles) ? readdirSync(profiles) : []).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails target verification when profile removal falls back to a stale directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-packed-target-stale-'))
    const masterBin = join(root, 'fake-master-bin.mjs')
    writeFileSync(
      masterBin,
      'if (process.argv.includes("--dump-config")) console.log("demo")\n',
    )
    try {
      await expect(verifyPackedTarget({
        root,
        pluginName: 'demo',
        target: 'master',
        tarball: join(root, 'demo.tgz'),
        masterBin,
        compat: {
          targets: {
            next: { dsh: '0.1.1-rc.2', cordis: '4.0.1', node: '22.20.0', pnpm: '11.7.0' },
            master: {
              repository: 'deepseek-ai/deepseek-harness',
              commit: '1'.repeat(40),
              node: '^22.19.0',
              pnpm: '11.7.0',
            },
          },
        },
        removeProfile() {
          throw new Error('injected profile lock')
        },
      })).rejects.toThrow(/cleanup|profile.*stale|injected profile lock/i)
      const profiles = join(root, '.lab', 'runtime', 'profiles')
      expect(readdirSync(profiles)).toHaveLength(1)
      expect(readdirSync(profiles)[0]).toMatch(/\.stale-/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('master launcher build output', () => {
  it('captures pnpm output instead of inheriting stdout used by JSON mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-master-build-output-'))
    const upstream = join(root, 'upstream', 'deepseek-harness')
    try {
      mkdirSync(upstream, { recursive: true })
      execFileSync('git', ['init', '-q'], { cwd: upstream })
      writeFileSync(join(upstream, 'package.json'), '{}')
      execFileSync('git', ['add', '.'], { cwd: upstream })
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: upstream })
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' }).trim()
      vi.mocked(pnpm).mockReset().mockReturnValue('captured output')

      await buildUpstream(root, {
        targets: {
          next: { dsh: '0.1.1-rc.2', cordis: '4.0.1', node: '22.20.0', pnpm: '11.7.0' },
          master: { repository: 'deepseek-ai/deepseek-harness', commit, node: '^22.19.0', pnpm: '11.7.0' },
        },
      })

      expect(pnpm).toHaveBeenCalledTimes(2)
      expect(vi.mocked(pnpm).mock.calls.every(([, opts]) => opts?.stdio !== 'inherit')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('buildSourceOverlay', () => {
  it('escapes apostrophes by doubling them for the YAML single-quoted scalar', () => {
    const overlay = buildSourceOverlay('example', `file:///A:/plugins/o'brien/src/index.ts`)
    expect(overlay).toContain(`name: 'file:///A:/plugins/o''brien/src/index.ts'`)
    expect(overlay).not.toContain(`\\'`)
  })
})

describe('buildDevOverlay', () => {
  it('re-enables the hmr row and points its module root at the plugin source dir', () => {
    const overlay = buildDevOverlay('example', `file:///A:/plugins/example/src/index.ts`, `A:/plugins/example/src`)
    // The shared hmr row (disabled by the web bundle) is re-enabled…
    expect(overlay).toContain('- id: hmr')
    expect(overlay).toContain('disabled: false')
    // …and its module root points at the plugin source directory for live reload.
    expect(overlay).toContain(`root:`)
    expect(overlay).toContain(`- 'A:/plugins/example/src'`)
    // The plugin source entry is still inserted.
    expect(overlay).toContain(`- insert:`)
    expect(overlay).toContain(`name: 'file:///A:/plugins/example/src/index.ts'`)
  })

  it('escapes apostrophes in the hmr root the same way as the entry', () => {
    const overlay = buildDevOverlay('example', `file:///A:/o'brien/src/index.ts`, `A:/o'brien/src`)
    expect(overlay).toContain(`- 'A:/o''brien/src'`)
  })
})

describe('profile boundaries', () => {
  it('retains noUncheckedIndexedAccess for the tooling package', () => {
    const config = JSON.parse(
      readFileSync(fileURLToPath(new URL('../tsconfig.json', import.meta.url)), 'utf8'),
    ) as { compilerOptions?: { noUncheckedIndexedAccess?: boolean } }
    expect(config.compilerOptions?.noUncheckedIndexedAccess).not.toBe(false)
  })

  it('resolves the public tsx/esm loader export to an installed file', () => {
    const loader = resolveTsxLoader()
    expect(loader).toMatch(/^file:/)
    expect(existsSync(fileURLToPath(loader))).toBe(true)
  })

  it('keeps dev stable and gives verify a unique namespace', () => {
    expect(profileName('example', 'next', 'dev')).toBe('example-next-dev')
    expect(profileName('example', 'next', 'verify', 'run-123')).toBe(
      'example-next-verify-run-123',
    )
  })

  it('materializes only target-owned build policy in the profile workspace', () => {
    expect(buildProfileWorkspaceYaml({ esbuild: true, koffi: false })).toBe(
      'packages:\n  - "."\nallowBuilds:\n  esbuild: true\n  koffi: false\n',
    )
  })
})

describe('upstreamWorkingTreeDirty', () => {
  function initCommitRepo(dir: string): void {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'f'), 'x')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir })
  }

  it('false for a clean repo, true once a tracked file is modified', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-run-'))
    try {
      initCommitRepo(dir)
      expect(upstreamWorkingTreeDirty(dir)).toBe(false)
      writeFileSync(join(dir, 'f'), 'y') // modify a tracked file
      expect(upstreamWorkingTreeDirty(dir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
