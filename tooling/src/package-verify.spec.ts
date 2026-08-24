import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
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
  failureMessage?: string
  createTarball?: boolean
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
          throw new Error(opts.failureMessage ?? 'command failed\nTOKEN=super-secret-value')
        }
        if (args[0] !== 'pack') return ''
        const output = opts.pack ?? JSON.stringify([{ filename: 'fixture-demo-0.0.0.tgz' }])
        if (opts.createTarball !== false) {
          try {
            const parsed = JSON.parse(output) as unknown
            const entry = Array.isArray(parsed) ? parsed[0] : parsed
            const filename = (entry as { filename?: unknown } | undefined)?.filename
            if (
              typeof filename === 'string' &&
              !isAbsolute(filename) &&
              !filename.replaceAll('\\', '/').split('/').includes('..')
            ) writeFileSync(join(runOpts.cwd!, filename), 'tarball bytes')
          } catch {
            // Malformed-output tests intentionally provide non-JSON.
          }
        }
        return output
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
      ['install', '--frozen-lockfile'],
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
    writeFileSync(
      join(workspacePath, 'pnpm-workspace.yaml'),
      'packages:\n  - .\nsharedWorkspaceLockfile: false\nallowBuilds:\n  source-owned: true\n',
    )

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
    expect(parsed.allowBuilds).not.toHaveProperty('source-owned')
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
    expectStructuredPrerequisiteError(() => verifyPackageInWorkspace({
      workspacePath,
      allowBuilds: {},
      runner: subject.runner,
    }))
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

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects unsafe allowBuilds package key %j',
    packageName => {
      const workspacePath = workspace()
      const policy = Object.create(null) as Record<string, boolean>
      Object.defineProperty(policy, packageName, { value: true, enumerable: true })
      const subject = runner()

      expect(() => verifyPackageInWorkspace({
        workspacePath,
        allowBuilds: policy,
        runner: subject.runner,
      })).toThrow(/allowBuilds.*key|package name|unsafe/i)
      expect(subject.calls).toEqual([])
    },
  )

  it('rejects duplicate allowBuilds keys in workspace YAML before invoking pnpm', () => {
    const workspacePath = workspace()
    writeFileSync(
      join(workspacePath, 'pnpm-workspace.yaml'),
      'packages:\n  - .\nallowBuilds:\n  esbuild: true\n  esbuild: false\n',
    )
    const subject = runner()

    expect(() => verifyPackageInWorkspace({
      workspacePath,
      allowBuilds: {},
      runner: subject.runner,
    })).toThrow(/duplicate|duplicated|allowBuilds/i)
    expect(subject.calls).toEqual([])
  })

  it.each([
    ['not json', /pack.*json/i],
    ['[]', /pack.*empty|no.*tarball/i],
    [JSON.stringify([{ filename: '../outside.tgz' }]), /tarball.*escape|outside/i],
    [JSON.stringify([{ filename: resolve(tmpdir(), 'outside.tgz') }]), /tarball.*absolute|escape|outside/i],
    [JSON.stringify([{ filename: 'one.tgz' }, { filename: 'two.tgz' }]), /pack.*exactly one|ambiguous|multiple/i],
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

  it('accepts the pnpm 11 single-object pack output', () => {
    const workspacePath = workspace()
    const subject = runner({ pack: JSON.stringify({
      name: '@fixture/demo',
      version: '0.0.0',
      filename: 'fixture-demo-0.0.0.tgz',
      files: [{ path: 'package.json' }],
    }) })

    const result = verifyPackageInWorkspace({
      workspacePath,
      allowBuilds: {},
      runner: subject.runner,
    })

    expect(result.tarball).toBe(resolve(workspacePath, 'fixture-demo-0.0.0.tgz'))
    expect(subject.calls.at(-1)?.args).toEqual([
      'pack-smoke',
      resolve(workspacePath, 'fixture-demo-0.0.0.tgz'),
    ])
  })

  it.each([
    [JSON.stringify({ name: '@fixture/demo', version: '0.0.0' }), /pack.*no.*tarball|no.*tarball.*filename/i],
    [JSON.stringify({ filename: '../outside.tgz' }), /tarball.*escape|outside/i],
    [JSON.stringify([[]]), /no.*tarball/i],
  ])('rejects unsafe pnpm 11 pack output %j before pack-smoke', (pack, message) => {
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

  it('requires the packed tarball to be an existing regular file inside the workspace', () => {
    const workspacePath = workspace()
    const missing = runner({ createTarball: false })
    expect(() => verifyPackageInWorkspace({
      workspacePath,
      allowBuilds: {},
      runner: missing.runner,
    })).toThrow(/tarball.*not found|regular file|does not exist/i)
    expect(missing.calls.at(-1)?.args[0]).toBe('pack')

    const outside = mkdtempSync(join(tmpdir(), 'dsh-lab-package-outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'out.tgz'), 'outside bytes')
    symlinkSync(outside, join(workspacePath, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const escaped = runner({ pack: JSON.stringify([{ filename: 'link/out.tgz' }]) })
    expect(() => verifyPackageInWorkspace({
      workspacePath,
      allowBuilds: {},
      runner: escaped.runner,
    })).toThrow(/tarball.*symlink|junction|escape|outside/i)
    expect(escaped.calls.at(-1)?.args[0]).toBe('pack')
  })

  it('rejects a symlinked workspace root before policy mutation or process execution', () => {
    const source = workspace()
    const policyPath = join(source, 'pnpm-workspace.yaml')
    const before = readFileSync(policyPath, 'utf8')
    const aliasParent = mkdtempSync(join(tmpdir(), 'dsh-lab-package-alias-'))
    roots.push(aliasParent)
    const workspacePath = join(aliasParent, 'workspace')
    symlinkSync(source, workspacePath, process.platform === 'win32' ? 'junction' : 'dir')
    const subject = runner()

    expect(() => verifyPackageInWorkspace({
      workspacePath,
      allowBuilds: { esbuild: true },
      runner: subject.runner,
    })).toThrow(/workspace.*symlink|workspace.*junction|workspace.*real directory/i)
    expect(subject.calls).toEqual([])
    expect(readFileSync(policyPath, 'utf8')).toBe(before)
  })

  it('rejects a workspace reached through a symlinked parent component before any side effect', () => {
    const source = workspace()
    const policyPath = join(source, 'pnpm-workspace.yaml')
    const before = readFileSync(policyPath, 'utf8')
    const aliasRoot = mkdtempSync(join(tmpdir(), 'dsh-lab-package-parent-alias-'))
    roots.push(aliasRoot)
    const linkedParent = join(aliasRoot, 'linked-parent')
    symlinkSync(dirname(source), linkedParent, process.platform === 'win32' ? 'junction' : 'dir')
    const workspacePath = join(linkedParent, basename(source))
    const subject = runner()

    expect(() => verifyPackageInWorkspace({
      workspacePath,
      allowBuilds: { esbuild: true },
      runner: subject.runner,
    })).toThrow(/workspace.*symlink|workspace.*junction|workspace.*component|workspace.*alias/i)
    expect(subject.calls).toEqual([])
    expect(readFileSync(policyPath, 'utf8')).toBe(before)
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

  it('redacts access keys and credential-bearing URLs from failure summaries', () => {
    const workspacePath = workspace()
    const subject = runner({
      failAt: 'test',
      failureMessage: [
        'AWS_ACCESS_KEY_ID=AKIA1234567890',
        'DATABASE_URL=postgres://user:secret@db.example/app',
      ].join('\n'),
    })
    let error: unknown
    try {
      verifyPackageInWorkspace({ workspacePath, allowBuilds: {}, runner: subject.runner })
    } catch (caught) {
      error = caught
    }

    const summary = (error as Error & { steps: Array<{ summary?: string }> }).steps[2]!.summary!
    expect(summary).not.toContain('AKIA1234567890')
    expect(summary).not.toContain('user:secret')
    expect(summary).toContain('[REDACTED]')
  })
})

function expectStructuredPrerequisiteError(run: () => unknown): void {
  let error: unknown
  try {
    run()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(Error)
  const steps = (error as Error & { steps?: Array<{ id: string; status: string }> }).steps
  expect(steps).toHaveLength(6)
  expect(steps!.some(step => step.status === 'blocked' || step.status === 'fail')).toBe(true)
  expect(steps!.every(step => ['blocked', 'fail', 'skipped'].includes(step.status))).toBe(true)
}
