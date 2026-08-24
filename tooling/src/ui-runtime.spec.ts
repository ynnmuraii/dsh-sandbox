import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { computePluginDigest } from './plugin-snapshot.js'
import type { Compatibility } from './schemas.js'
import { resolveUiLauncher } from './run.js'
import { pnpmAsync } from './proc.js'
import {
  buildUiRuntimeEnvironment,
  prepareUiRuntime,
  type UiRuntimeDependencies,
  type UiRuntimePlugin,
} from './ui-runtime.js'

vi.mock('./run.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./run.js')>()
  return { ...actual, resolveUiLauncher: vi.fn(actual.resolveUiLauncher) }
})

vi.mock('./proc.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./proc.js')>()
  return {
    ...actual,
    pnpm: vi.fn(() => { throw new Error('legacy synchronous pnpm runner used') }),
    pnpmAsync: vi.fn(),
  }
})

const roots: string[] = []
const SESSION = 'ui-20260824T120000000Z-a1b2c3d4'
const NEXT = '0.1.1-rc.2'
const MASTER = '1'.repeat(40)

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; plugin: UiRuntimePlugin; compatibility: Compatibility } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lab-ui-runtime-'))
  roots.push(root)
  const sourcePath = join(root, 'external-plugin')
  mkdirSync(join(sourcePath, 'src'), { recursive: true })
  mkdirSync(join(root, 'upstream', 'deepseek-harness'), { recursive: true })
  mkdirSync(join(root, 'workbench'), { recursive: true })
  writeFileSync(join(sourcePath, 'src', 'index.ts'), 'export const plugin = true\n')
  writeFileSync(join(sourcePath, 'package.json'), JSON.stringify({ name: '@fixture/example' }))
  const compatibility = {
    targets: {
      next: {
        dsh: NEXT,
        cordis: '4.0.1',
        node: '22.20.0',
        pnpm: '11.7.0',
        allowBuilds: { esbuild: true },
      },
      master: {
        repository: 'deepseek-ai/deepseek-harness',
        commit: MASTER,
        node: '^22.19.0',
        pnpm: '11.7.0',
        allowBuilds: { esbuild: true },
      },
    },
  } as Compatibility
  writeFileSync(join(root, 'workbench', 'compatibility.yaml'), [
    'targets:',
    '  next:',
    `    dsh: ${NEXT}`,
    '    cordis: 4.0.1',
    '    node: 22.20.0',
    '    pnpm: 11.7.0',
    '  master:',
    '    repository: deepseek-ai/deepseek-harness',
    `    commit: ${MASTER}`,
    '    node: ^22.19.0',
    '    pnpm: 11.7.0',
    '',
  ].join('\n'))
  return {
    root,
    plugin: { packageName: '@fixture/example', sourcePath, runtimeName: 'example' },
    compatibility,
  }
}

function dependencies(compatibility: Compatibility) {
  const installNextProfile = vi.fn(async (_profileDir: string, _env: NodeJS.ProcessEnv, _signal?: AbortSignal) => undefined)
  const resolveLauncher = vi.fn(async (_root: string, target: 'next' | 'master', _compatibility?: Compatibility, _signal?: AbortSignal) => (
    target === 'next'
      ? { cmd: process.execPath, args: ['C:/tools/pnpm.cjs', 'exec', 'dsh'] }
      : { cmd: process.execPath, args: ['A:/upstream/apps/cli/lib/bin.js'] }
  ))
  const deps: UiRuntimeDependencies = {
    loadCompatibility: vi.fn(() => compatibility),
    resolveLauncher,
    installNextProfile,
  }
  return { deps, installNextProfile, resolveLauncher }
}

describe('prepareUiRuntime', () => {
  it('materializes a unique next profile and source overlay entirely inside the session', async () => {
    const current = fixture()
    const { deps, installNextProfile } = dependencies(current.compatibility)
    const before = computePluginDigest(current.plugin.sourcePath)

    const plan = await prepareUiRuntime({
      root: current.root,
      plugin: current.plugin,
      target: 'next',
      sessionId: SESSION,
    }, deps)

    const sessionDir = join(current.root, '.lab', 'runtime', 'ui-sessions', SESSION)
    expect(plan.sessionDir).toBe(sessionDir)
    expect(plan.runtimeHome).toBe(join(sessionDir, 'home'))
    expect(plan.profileName).toBe(`example-next-ui-${SESSION}`)
    expect(plan.profileDir).toBe(join(plan.runtimeHome, 'profiles', plan.profileName))
    expect(plan.overlayPath).toBe(join(sessionDir, 'overlay', 'cordis.patch.yml'))
    expect(plan.cwd).toBe(plan.profileDir)
    expect(plan.argv).toEqual([
      ...plan.launcher.args,
      '--profile', plan.profileName,
      '--patch', plan.overlayPath,
      '--host', '127.0.0.1',
      '--port', '0',
      '--no-open',
    ])
    expect(readFileSync(plan.overlayPath, 'utf8')).toContain(current.plugin.sourcePath.replaceAll('\\', '/'))
    const manifest = JSON.parse(readFileSync(join(plan.profileDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies['@deepseek-ai/dsh']).toBe(NEXT)
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(readFileSync(join(plan.profileDir, 'pnpm-workspace.yaml'), 'utf8')).toContain('esbuild: true')
    expect(installNextProfile).toHaveBeenCalledTimes(1)
    expect(installNextProfile.mock.calls[0]![0]).toBe(plan.profileDir)
    expect(installNextProfile.mock.calls[0]![1].DSH_HOME).toBe(plan.runtimeHome)
    expect(installNextProfile.mock.calls[0]![2]).toBeInstanceOf(AbortSignal)
    expect(computePluginDigest(current.plugin.sourcePath)).toEqual(before)
  })

  it('forwards cancellation to launcher resolution and profile installation', async () => {
    const current = fixture()
    const controller = new AbortController()
    const { deps, installNextProfile, resolveLauncher } = dependencies(current.compatibility)
    installNextProfile.mockImplementation(async (_profileDir: string, _env: NodeJS.ProcessEnv, signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      await new Promise<never>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('install aborted')), { once: true })
      })
    })
    const preparing = prepareUiRuntime({
      root: current.root,
      plugin: current.plugin,
      target: 'next',
      sessionId: SESSION,
      signal: controller.signal,
    }, deps)

    await vi.waitFor(() => expect(installNextProfile).toHaveBeenCalledTimes(1))
    expect(resolveLauncher.mock.calls[0]![3]).toBe(controller.signal)
    controller.abort()

    await expect(preparing).rejects.toThrow(/abort/i)
  })

  it('lets cancellation interrupt pinned master launcher preparation before profile materialization completes', async () => {
    const current = fixture()
    const controller = new AbortController()
    const { deps, installNextProfile, resolveLauncher } = dependencies(current.compatibility)
    resolveLauncher.mockImplementation(async (_root, target, _compatibility, signal) => {
      expect(target).toBe('master')
      expect(signal).toBe(controller.signal)
      return await new Promise<{ cmd: string; args: string[] }>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('master build aborted')), { once: true })
      })
    })
    const preparing = prepareUiRuntime({
      root: current.root,
      plugin: current.plugin,
      target: 'master',
      sessionId: SESSION,
      signal: controller.signal,
    }, deps)
    void preparing.catch(() => undefined)

    await vi.waitFor(() => expect(resolveLauncher).toHaveBeenCalledTimes(1))
    controller.abort()

    await expect(preparing).rejects.toThrow(/abort/i)
    expect(installNextProfile).not.toHaveBeenCalled()
  })

  it('uses the cancellable package runner in the real next-runtime dependency path', async () => {
    const current = fixture()
    const controller = new AbortController()
    vi.mocked(resolveUiLauncher).mockResolvedValue({ cmd: process.execPath, args: ['C:/tools/pnpm.cjs', 'exec', 'dsh'] })
    vi.mocked(pnpmAsync).mockImplementation(async (_args, opts) => {
      expect(opts.signal).toBe(controller.signal)
      return await new Promise<never>((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('owned pnpm tree aborted')), { once: true })
      })
    })
    const preparing = prepareUiRuntime({
      root: current.root,
      plugin: current.plugin,
      target: 'next',
      sessionId: SESSION,
      signal: controller.signal,
    })
    void preparing.catch(() => undefined)

    await vi.waitFor(() => expect(pnpmAsync).toHaveBeenCalledTimes(1))
    expect(resolveUiLauncher).toHaveBeenCalledWith(current.root, 'next', expect.any(Object), controller.signal)
    expect(vi.mocked(pnpmAsync).mock.calls[0]![0]).toEqual(['install', '--config.strictDepBuilds=false'])
    expect(vi.mocked(pnpmAsync).mock.calls[0]![1]).toMatchObject({
      cwd: expect.stringContaining(SESSION),
      signal: controller.signal,
    })
    controller.abort()

    await expect(preparing).rejects.toThrow(/abort/i)
  })

  it('keeps inherited environment in memory and out of the serializable plan', async () => {
    const current = fixture()
    const { deps } = dependencies(current.compatibility)
    const plan = await prepareUiRuntime({
      root: current.root,
      plugin: current.plugin,
      target: 'next',
      sessionId: SESSION,
    }, deps)

    const env = buildUiRuntimeEnvironment(plan, { SECRET_TOKEN: 'do-not-persist', NODE_OPTIONS: '--trace-warnings' })
    expect(env.SECRET_TOKEN).toBe('do-not-persist')
    expect(env.DSH_HOME).toBe(plan.runtimeHome)
    expect(env.NODE_OPTIONS).toContain('--trace-warnings')
    expect(JSON.stringify(plan)).not.toContain('SECRET_TOKEN')
    expect(plan).not.toHaveProperty('env')
  })

  it('never shares writable paths between concurrent session plans', async () => {
    const current = fixture()
    const first = dependencies(current.compatibility)
    const second = dependencies(current.compatibility)
    const otherSession = 'ui-20260824T120000000Z-deadbeef'

    const [left, right] = await Promise.all([
      prepareUiRuntime({ root: current.root, plugin: current.plugin, target: 'next', sessionId: SESSION }, first.deps),
      prepareUiRuntime({ root: current.root, plugin: current.plugin, target: 'next', sessionId: otherSession }, second.deps),
    ])

    for (const path of [right.sessionDir, right.runtimeHome, right.profileDir, right.overlayPath]) {
      expect(path).not.toBe(left.sessionDir)
      expect(path.startsWith(left.sessionDir)).toBe(false)
    }
  })

  it('uses the pinned master launcher and a relative upstream dependency without profile install', async () => {
    const current = fixture()
    const { deps, installNextProfile, resolveLauncher } = dependencies(current.compatibility)

    const plan = await prepareUiRuntime({
      root: current.root,
      plugin: current.plugin,
      target: 'master',
      sessionId: SESSION,
    }, deps)

    expect(resolveLauncher).toHaveBeenCalledWith(current.root, 'master', current.compatibility, expect.any(AbortSignal))
    expect(installNextProfile).not.toHaveBeenCalled()
    const manifest = JSON.parse(readFileSync(join(plan.profileDir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    const upstream = join(current.root, 'upstream', 'deepseek-harness')
    expect(manifest.dependencies['@deepseek-ai/dsh']).toBe(
      `file:${relative(plan.profileDir, upstream).replaceAll('\\', '/')}`,
    )
    expect(plan.launcher.args).toEqual(['A:/upstream/apps/cli/lib/bin.js'])
  })

  it.each(['', '.', '..', '../outside', '..\\outside', '/absolute', 'line\nbreak'])(
    'rejects unsafe runtime name %j before creating forge files',
    async runtimeName => {
      const current = fixture()
      const { deps } = dependencies(current.compatibility)
      await expect(prepareUiRuntime({
        root: current.root,
        plugin: { ...current.plugin, runtimeName },
        target: 'next',
        sessionId: SESSION,
      }, deps)).rejects.toThrow(/runtimeName|identity|unsafe|invalid/i)
      expect(existsSync(join(current.root, '.lab'))).toBe(false)
    },
  )
})
