import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { load as loadYaml } from 'js-yaml'
import {
  verifyPackageInWorkspace,
  type PackageVerifyRunner,
} from './package-verify.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lab-package-verify-'))
  roots.push(root)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - .\nsharedWorkspaceLockfile: false\n')
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: '@fixture/demo',
      version: '0.0.0',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
        build: 'tsc -p tsconfig.build.json',
        'pack-smoke': 'node scripts/pack-smoke.mjs',
      },
    }, null, 2)}\n`,
  )
  return root
}

interface Call {
  args: string[]
  cwd?: string
}

function runner(opts: {
  pack?: string
  failAt?: string
  onCall?: (args: string[]) => void
} = {}): { runner: PackageVerifyRunner; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    runner: {
      pnpm(args, runOpts) {
        calls.push({ args: [...args], cwd: runOpts.cwd })
        opts.onCall?.(args)
        if (args[0] === opts.failAt) {
          throw new Error('command failed\nTOKEN=super-secret-value')
        }
        return args[0] === 'pack'
          ? (opts.pack ?? JSON.stringify([{ filename: 'fixture-demo-0.0.0.tgz' }]))
          : ''
      },
    },
  }
}

describe('verifyPackageInWorkspace', () => {
  it('runs the exact staged pipeline in the temporary workspace', () => {
    const workspacePath = workspace()
    const subject = runner()

    const result = verifyPackageInWorkspace({
      workspacePath,
      allowBuilds: { esbuild: true },
      runner: subject.runner,
    })

    const tarball = resolve(workspacePath, 'fixture-demo-0.0.0.tgz')
    expect(subject.calls.map(call => call.args)).toEqual([
      ['install', '--ignore-workspace', '--frozen-lockfile'],
      ['typecheck'],
      ['test'],
      ['build'],
      ['pack', '--json'],
      ['pack-smoke', tarball],
    ])
    expect(subject.calls.every(call => call.cwd === workspacePath)).toBe(true)
    expect(subject.calls.flatMap(call => call.args).join(' ')).not.toContain('plugins/source')
    expect(result.tarball).toBe(tarball)
    expect(isAbsolute(result.tarball)).toBe(true)
    expect(result.steps.map(step => [step.id, step.status])).toEqual([
      ['install', 'pass'],
      ['typecheck', 'pass'],
      ['test', 'pass'],
      ['build', 'pass'],
      ['pack', 'pass'],
      ['pack-smoke', 'pass'],
    ])
  })

  it('merges normalized, sorted target allowBuilds into only the copied workspace policy', () => {
    const workspacePath = workspace()
    const subject = runner()

    verifyPackageInWorkspace({
      workspacePath,
      allowBuilds: { zlib: false, esbuild: true },
      runner: subject.runner,
    })

    const text = readFileSync(join(workspacePath, 'pnpm-workspace.yaml'), 'utf8')
    const parsed = loadYaml(text) as Record<string, unknown>
    expect(parsed).toMatchObject({
      packages: ['.'],
      sharedWorkspaceLockfile: false,
      allowBuilds: { esbuild: true, zlib: false },
    })
    expect(text.indexOf('esbuild:')).toBeLessThan(text.indexOf('zlib:'))
    expect(Object.values(parsed.allowBuilds as Record<string, unknown>).every(
      value => typeof value === 'boolean',
    )).toBe(true)
  })

  it.each([
    ['pnpm-lock.yaml', 'lockfile'],
    ['pnpm-workspace.yaml', 'workspace'],
  ])('rejects missing %s before invoking pnpm', (file, message) => {
    const workspacePath = workspace()
    unlinkSync(join(workspacePath, file))
    const subject = runner()

    expect(() => verifyPackageInWorkspace({
      workspacePath,
      allowBuilds: {},
      runner: subject.runner,
    })).toThrow(new RegExp(message, 'i'))
    expect(subject.calls).toEqual([])
  })

  it.each(['typecheck', 'test', 'build', 'pack-smoke'])(
    'rejects a missing %s script before invoking pnpm',
    missing => {
      const workspacePath = workspace()
      const path = join(workspacePath, 'package.json')
      const pkg = JSON.parse(readFileSync(path, 'utf8'))
      delete pkg.scripts[missing]
      writeFileSync(path, JSON.stringify(pkg))
      const subject = runner()

      expect(() => verifyPackageInWorkspace({
        workspacePath,
        allowBuilds: {},
        runner: subject.runner,
      })).toThrow(new RegExp(missing, 'i'))
      expect(subject.calls).toEqual([])
    },
  )

  it('rejects non-boolean allowBuilds before invoking pnpm or rewriting policy', () => {
    const workspacePath = workspace()
    const policyPath = join(workspacePath, 'pnpm-workspace.yaml')
    const before = readFileSync(policyPath, 'utf8')
    const subject = runner()

    expect(() => verifyPackageInWorkspace({
      workspacePath,
      allowBuilds: { esbuild: 'yes' } as unknown as Record<string, boolean>,
      runner: subject.runner,
    })).toThrow(/allowBuilds.*boolean/i)
    expect(subject.calls).toEqual([])
    expect(readFileSync(policyPath, 'utf8')).toBe(before)
  })

  it.each([
    ['not json', /pack.*json/i],
    ['[]', /pack.*empty|no.*tarball/i],
    [JSON.stringify([{ filename: '../outside.tgz' }]), /tarball.*escape|outside/i],
    [JSON.stringify([{ filename: resolve(tmpdir(), 'outside.tgz') }]), /tarball.*absolute|escape|outside/i],
  ])('rejects unsafe pack output %j before pack-smoke', (pack, message) => {
    const workspacePath = workspace()
    const subject = runner({ pack })

    expect(() => verifyPackageInWorkspace({
      workspacePath,
      allowBuilds: {},
      runner: subject.runner,
    })).toThrow(message)
    expect(subject.calls.map(call => call.args[0])).toEqual([
      'install',
      'typecheck',
      'test',
      'build',
      'pack',
    ])
  })

  it('attaches structured pass/fail/skipped results with a sanitized failure summary', () => {
    const workspacePath = workspace()
    const subject = runner({ failAt: 'test' })
    let error: unknown

    try {
      verifyPackageInWorkspace({ workspacePath, allowBuilds: {}, runner: subject.runner })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    const steps = (error as Error & { steps: Array<{ id: string; status: string; durationMs: number; summary?: string }> }).steps
    expect(steps.map(step => [step.id, step.status])).toEqual([
      ['install', 'pass'],
      ['typecheck', 'pass'],
      ['test', 'fail'],
      ['build', 'skipped'],
      ['pack', 'skipped'],
      ['pack-smoke', 'skipped'],
    ])
    expect(steps.every(step => Number.isFinite(step.durationMs) && step.durationMs >= 0)).toBe(true)
    expect(steps[2]!.summary).not.toContain('super-secret-value')
    expect(steps[2]!.summary).not.toMatch(/[\r\n]/)
    expect(subject.calls.map(call => call.args[0])).toEqual(['install', 'typecheck', 'test'])
  })
})
