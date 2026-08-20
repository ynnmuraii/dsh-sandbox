import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT_PATHS, rootPath } from './context.js'

export async function verifyUpstreamCommit(
  root: string,
  expected: string,
): Promise<boolean> {
  const dir = rootPath(root, ROOT_PATHS.upstream)
  if (!existsSync(join(dir, '.git'))) return false
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim()
    return head === expected
  } catch {
    return false
  }
}

export async function ensureUpstream(
  root: string,
  repository: string,
  commit: string,
): Promise<string> {
  const dir = rootPath(root, ROOT_PATHS.upstream)
  if (await verifyUpstreamCommit(root, commit)) return dir
  // Deterministic CI fallback: clone fresh (no submodule init assumed) and
  // pin the exact commit. The meta-repo's submodule entry stays in control.
  execFileSync('git', ['clone', '--no-checkout', repository, dir], {
    stdio: 'inherit',
  })
  execFileSync('git', ['checkout', commit], { cwd: dir, stdio: 'inherit' })
  return dir
}
