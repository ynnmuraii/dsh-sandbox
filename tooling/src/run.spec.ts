import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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
} from './run.js'

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
