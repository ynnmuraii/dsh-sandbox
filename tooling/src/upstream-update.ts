import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT_PATHS, rootPath } from './context.js'
import { loadPluginConfig } from './create.js'
import { doctor } from './doctor.js'
import { pnpm } from './proc.js'
import { buildUpstream, verifyBundle, type VerifyOptions } from './run.js'
import {
  loadCatalogFromFile,
  loadCompatibilityFromFile,
  type Compatibility,
} from './schemas.js'

const MASTER_REF = 'refs/heads/master'
const COMMIT = /^[0-9a-f]{40}$/

export interface UpstreamStatus {
  pinned: string
  remote: string
  current: boolean
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts: { cwd: string }): string
}

export interface UpstreamUpdateResult {
  previous: string
  adopted: string
  changed: boolean
  verifiedPlugins: string[]
}

interface UpdateServices {
  doctor: typeof doctor
  pnpm: typeof pnpm
  buildUpstream: (root: string, compat: Compatibility) => Promise<string>
  verifyBundle: (opts: VerifyOptions) => Promise<void>
}

const defaultServices: UpdateServices = { doctor, pnpm, buildUpstream, verifyBundle }

const defaultRunner: CommandRunner = {
  run(cmd, args, opts) {
    return execFileSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8' })
  },
}

function gitmodulesRepository(root: string): string {
  const text = readFileSync(join(root, '.gitmodules'), 'utf8')
  const sections = text.split(/^\s*\[submodule\s+"[^"]+"\]\s*$/m).slice(1)
  for (const section of sections) {
    const path = /^\s*path\s*=\s*(.+?)\s*$/m.exec(section)?.[1]
    const url = /^\s*url\s*=\s*(.+?)\s*$/m.exec(section)?.[1]
    if (path === ROOT_PATHS.upstream && url) return url
  }
  throw new Error(`cannot resolve upstream repository URL from ${join(root, '.gitmodules')}`)
}

function upstreamRepository(root: string, runner: CommandRunner): string {
  const upstreamDir = rootPath(root, ROOT_PATHS.upstream)
  try {
    const origin = runner.run('git', ['config', '--get', 'remote.origin.url'], {
      cwd: upstreamDir,
    }).trim()
    if (origin) return origin
  } catch {
    // An uninitialized checkout or checkout without origin uses .gitmodules.
  }
  return gitmodulesRepository(root)
}

function parseMasterRef(output: string): string {
  const lines = output.trim() === '' ? [] : output.trim().split(/\r?\n/)
  if (lines.length !== 1) {
    throw new Error(`expected exactly one ${MASTER_REF} response, got ${lines.length}`)
  }
  const [commit, ref, ...extra] = lines[0]!.trim().split(/\s+/)
  if (ref !== MASTER_REF || extra.length > 0) {
    throw new Error(`remote response must identify ${MASTER_REF}`)
  }
  if (!commit || !COMMIT.test(commit)) {
    throw new Error(`remote ${MASTER_REF} commit must be a lowercase 40-character SHA`)
  }
  return commit
}

export function checkUpstream(opts: {
  root: string
  runner?: CommandRunner
}): UpstreamStatus {
  const runner = opts.runner ?? defaultRunner
  const compat = loadCompatibilityFromFile(rootPath(opts.root, ROOT_PATHS.compatibility))
  const pinned = compat.targets.master.commit!
  const repository = upstreamRepository(opts.root, runner)
  const remote = parseMasterRef(
    runner.run('git', ['ls-remote', repository, MASTER_REF], { cwd: opts.root }),
  )
  return { pinned, remote, current: pinned === remote }
}

export function replaceMasterCommit(text: string, current: string, next: string): string {
  if (!COMMIT.test(current) || !COMMIT.test(next)) {
    throw new Error('master commit replacement requires lowercase 40-character SHAs')
  }
  const occurrences = text.split(current).length - 1
  if (occurrences !== 1) {
    throw new Error(`expected current master commit to occur exactly once, got ${occurrences}`)
  }
  return text.replace(current, next)
}

function assertClean(
  runner: CommandRunner,
  cwd: string,
  label: 'meta-repo' | 'upstream checkout',
): void {
  const status = runner.run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd })
  if (status.trim() !== '') throw new Error(`${label} working tree is dirty`)
}

function exactCommit(value: string, phase: string): string {
  const commit = value.trim()
  if (!COMMIT.test(commit)) {
    throw new Error(`${phase} did not resolve a lowercase 40-character commit: '${commit}'`)
  }
  return commit
}

function phaseError(phase: string, error: unknown): Error {
  return new Error(`${phase} failed: ${(error as Error).message}`, { cause: error })
}

export async function updateUpstream(opts: {
  root: string
  verify: boolean
  runner?: CommandRunner
  services?: UpdateServices
}): Promise<UpstreamUpdateResult> {
  const runner = opts.runner ?? defaultRunner
  const services = opts.services ?? defaultServices
  const upstreamDir = rootPath(opts.root, ROOT_PATHS.upstream)
  const manifestPath = rootPath(opts.root, ROOT_PATHS.compatibility)

  assertClean(runner, opts.root, 'meta-repo')
  assertClean(runner, upstreamDir, 'upstream checkout')

  const before = readFileSync(manifestPath, 'utf8')
  const previous = loadCompatibilityFromFile(manifestPath).targets.master.commit!
  let adopted: string
  try {
    runner.run('git', ['fetch', 'origin', 'master'], { cwd: upstreamDir })
    adopted = exactCommit(
      runner.run('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { cwd: upstreamDir }),
      'fetch',
    )
  } catch (error) {
    throw phaseError('fetch', error)
  }

  if (adopted === previous) {
    return { previous, adopted, changed: false, verifiedPlugins: [] }
  }

  try {
    runner.run('git', ['checkout', '--detach', adopted], { cwd: upstreamDir })
  } catch (error) {
    throw phaseError('checkout', error)
  }
  try {
    writeFileSync(manifestPath, replaceMasterCommit(before, previous, adopted))
  } catch (error) {
    throw phaseError('manifest update', error)
  }

  const diagnostics = await services.doctor({ root: opts.root })
  const errors = diagnostics.filter(result => result.level === 'error')
  if (errors.length > 0) {
    throw new Error(`doctor failed after adopting ${adopted}: ${errors.map(e => e.message).join('; ')}`)
  }

  const verifiedPlugins: string[] = []
  if (opts.verify) {
    try {
      services.pnpm(['typecheck'], { cwd: opts.root, stdio: 'inherit' })
      services.pnpm(['test'], { cwd: opts.root, stdio: 'inherit' })
      const compat = loadCompatibilityFromFile(manifestPath)
      const masterBin = await services.buildUpstream(opts.root, compat)
      const catalog = loadCatalogFromFile(rootPath(opts.root, ROOT_PATHS.catalog))
      for (const [name, entry] of Object.entries(catalog.plugins)) {
        const config = loadPluginConfig(join(opts.root, entry.path, '.dsh-lab', 'plugin.yaml'))
        if (!config.targets.includes('master')) continue
        await services.verifyBundle({ root: opts.root, name, target: 'master', masterBin })
        verifiedPlugins.push(name)
      }
    } catch (error) {
      throw phaseError('verification', error)
    }
  }

  return { previous, adopted, changed: true, verifiedPlugins }
}
