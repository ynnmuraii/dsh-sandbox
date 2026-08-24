import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defaultProcessTreeDependencies, stopOwnedProcessTree, type OwnedProcessTreeHandle } from './process-tree.js'

export interface RunOpts {
  cwd?: string
  env?: NodeJS.ProcessEnv
  encoding?: 'utf8' | BufferEncoding | null
  stdio?: 'pipe' | 'ignore' | 'inherit'
}

export interface AsyncRunOpts extends Omit<RunOpts, 'stdio'> {
  signal: AbortSignal
  stdio?: 'pipe'
}

interface Command {
  cmd: string
  args: string[]
}

// Cache the resolved pnpm command across calls (the entry never moves within a
// process).
let pnpmCmd: Command | null = null

// Resolve pnpm as a node-invocable argument array so every call is
// Windows-safe (no shell quoting, no reliance on `pnpm`/`pnpm.cmd` shims that
// execFileSync cannot spawn without a shell). On POSIX `pnpm` resolves to the
// real binary through PATH. On Windows we parse the `.cmd` shim on PATH to find
// the real ESM entry it invokes (`node_modules/pnpm/bin/pnpm.{cjs,mjs}`), which
// differs between an npm-global install and pnpm's standalone `.tools` layout,
// then run that entry with the current node executable.
export function pnpmCommand(): Command {
  if (pnpmCmd) return pnpmCmd
  if (process.platform !== 'win32') {
    pnpmCmd = { cmd: 'pnpm', args: [] }
    return pnpmCmd
  }
  const shell = process.env.ComSpec ?? 'cmd.exe'
  const where = execFileSync(shell, ['/d', '/s', '/c', 'where pnpm'], {
    encoding: 'utf8',
  })
  const shim = (
    where.split(/\r?\n/).find(l => /pnpm\.cmd$/i.test(l.trim())) ??
    where.split(/\r?\n/)[0]!
  ).trim()
  const shimDir = dirname(shim)
  const text = readFileSync(shim, 'utf8')
  // The shim runs the entry relative to %~dp0 (its own directory), e.g.
  // `%dp0%\node_modules\pnpm\bin\pnpm.cjs` or `%~dp0\..\node_modules\pnpm\bin\pnpm.mjs`.
  const m = /%~?dp0%?[\\.]([^\s"%]+pnpm\.(?:cjs|mjs))/i.exec(text)
  if (!m) {
    throw new Error(`cannot locate the pnpm CLI entry from its shim at ${shim}`)
  }
  const entry = resolve(shimDir, m[1]!)
  if (!existsSync(entry)) {
    throw new Error(`resolved pnpm CLI entry does not exist: ${entry}`)
  }
  pnpmCmd = { cmd: process.execPath, args: [entry] }
  return pnpmCmd
}

// Run pnpm with an argument array (never string interpolation). Returns the
// captured stdout when stdio is left as the default pipe.
export function pnpm(args: string[], opts: RunOpts = {}): Buffer | string {
  const { cmd, args: pre } = pnpmCommand()
  return execFileSync(cmd, [...pre, ...args], opts as never)
}

/**
 * Run pnpm as an owned process tree. This is reserved for cancellable UI
 * preparation; the synchronous runner above remains the dev/verify path.
 */
export function pnpmAsync(args: string[], opts: AsyncRunOpts): Promise<Buffer | string> {
  if (!(opts.signal instanceof AbortSignal)) throw new Error('pnpmAsync requires an AbortSignal')
  if (opts.signal.aborted) return Promise.reject(abortError())
  const { cmd, args: pre } = pnpmCommand()
  const child = spawn(cmd, [...pre, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on('data', chunk => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
  child.stderr?.on('data', chunk => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))

  let settled = false
  let aborting = false
  let leaderExited = false
  let rejectRun!: (error: unknown) => void
  let resolveRun!: (value: Buffer | string) => void
  const result = new Promise<Buffer | string>((resolvePromise, rejectPromise) => {
    resolveRun = resolvePromise
    rejectRun = rejectPromise
  })
  const signal = opts.signal
  const finish = (error: unknown, value?: Buffer | string): void => {
    if (settled) return
    settled = true
    signal.removeEventListener('abort', onAbort)
    if (error !== undefined) rejectRun(error)
    else resolveRun(value ?? Buffer.alloc(0))
  }
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveClosed => {
    child.once('close', (code, closeSignal) => resolveClosed({ code, signal: closeSignal }))
  })
  child.once('exit', () => { leaderExited = true })
  child.once('error', error => {
    leaderExited = true
    if (!aborting) finish(error)
  })
  child.once('close', (code, closeSignal) => {
    leaderExited = true
    if (aborting) return
    if (code !== 0) {
      const detail = Buffer.concat(stderr).toString('utf8').trim()
      finish(new Error(`pnpm exited with ${closeSignal ?? `code ${String(code)}`}${detail ? `: ${detail}` : ''}`))
      return
    }
    finish(undefined, opts.encoding === null ? Buffer.concat(stdout) : Buffer.concat(stdout).toString(opts.encoding ?? 'utf8'))
  })
  const onAbort = (): void => {
    if (settled || aborting) return
    aborting = true
    void stopProcessTree(child, closed, () => leaderExited).then(
      () => finish(abortError()),
      error => finish(error),
    )
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  return result
}

async function stopProcessTree(child: ChildProcess, closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>, leaderExited: () => boolean): Promise<void> {
  const pid = child.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) throw new Error('pnpm process did not provide a valid PID')
  const tree: OwnedProcessTreeHandle = { pid, exited: closed, leaderExited }
  await stopOwnedProcessTree(tree, defaultProcessTreeDependencies())
}

function abortError(): Error {
  const error = new Error('pnpm process tree aborted')
  error.name = 'AbortError'
  return error
}

// Invoke the current node interpreter with a script path (e.g. the built
// upstream CLI bin) plus arguments, as an explicit arg-array (Windows-safe).
export function node(
  script: string,
  args: string[],
  opts: RunOpts = {},
): Buffer | string {
  return execFileSync(process.execPath, [script, ...args], opts as never)
}
