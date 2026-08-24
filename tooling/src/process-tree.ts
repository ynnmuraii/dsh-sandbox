import { execFile } from 'node:child_process'

export interface OwnedProcessTreeHandle {
  pid: number
  exited: Promise<unknown>
  leaderExited(): boolean
}

export interface ProcessTreeDependencies {
  platform: 'windows' | 'posix'
  taskkill(args: string[]): Promise<void>
  signalGroup(group: number, signal: 'SIGTERM' | 'SIGKILL'): void
  waitForExit(exited: Promise<unknown>, timeoutMs: number): Promise<boolean>
  termGraceMs: number
  killGraceMs: number
  treeAlive: (pidOrGroup: number) => boolean
}

export function windowsTreeKillArgs(pid: number): string[] {
  assertPid(pid)
  return ['/PID', String(pid), '/T', '/F']
}

export function posixProcessGroup(pid: number): number {
  assertPid(pid)
  return -pid
}

export async function stopOwnedProcessTree(
  tree: OwnedProcessTreeHandle,
  deps: ProcessTreeDependencies = defaultProcessTreeDependencies(),
): Promise<void> {
  assertPid(tree.pid)
  if (deps.platform === 'windows') {
    // A closed leader PID is no longer an owned Windows identity. Never pass
    // it to taskkill, since the PID may already belong to another process.
    if (tree.leaderExited()) throw new Error('owned Windows process leader already exited; refusing reused PID cleanup')
    await deps.taskkill(windowsTreeKillArgs(tree.pid))
    if (!await deps.waitForExit(tree.exited, deps.termGraceMs) || !tree.leaderExited() || deps.treeAlive(tree.pid)) {
      throw new Error('owned Windows process tree did not close after taskkill')
    }
    return
  }

  const group = posixProcessGroup(tree.pid)
  deps.signalGroup(group, 'SIGTERM')
  if (await deps.waitForExit(tree.exited, deps.termGraceMs) && !deps.treeAlive(group)) return
  deps.signalGroup(group, 'SIGKILL')
  if (!await deps.waitForExit(tree.exited, deps.killGraceMs) || deps.treeAlive(group)) {
    throw new Error('owned POSIX process group did not close after SIGKILL')
  }
}

export function defaultProcessTreeDependencies(): ProcessTreeDependencies {
  const platform = process.platform === 'win32' ? 'windows' : 'posix'
  return {
    platform,
    taskkill: args => new Promise<void>((resolvePromise, rejectPromise) => {
      execFile('taskkill.exe', args, { windowsHide: true }, error => error ? rejectPromise(error) : resolvePromise())
    }),
    signalGroup: (group, signal) => {
      try { process.kill(group, signal) } catch (error) {
        if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH')) throw error
      }
    },
    waitForExit: waitForExitWithin,
    treeAlive: pidOrGroup => {
      try { process.kill(pidOrGroup, 0); return true } catch { return false }
    },
    termGraceMs: 5_000,
    killGraceMs: 5_000,
  }
}

async function waitForExitWithin(exited: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) throw new Error('process-tree timeout must be a non-negative integer')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>(resolveTimeout => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs)
  })
  try {
    return await Promise.race([exited.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`owned process PID must be a positive integer, got ${String(pid)}`)
}
