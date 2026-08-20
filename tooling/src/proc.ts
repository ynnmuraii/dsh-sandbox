import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface RunOpts {
  cwd?: string
  env?: NodeJS.ProcessEnv
  encoding?: 'utf8' | BufferEncoding | null
  stdio?: 'pipe' | 'ignore' | 'inherit'
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

// Invoke the current node interpreter with a script path (e.g. the built
// upstream CLI bin) plus arguments, as an explicit arg-array (Windows-safe).
export function node(
  script: string,
  args: string[],
  opts: RunOpts = {},
): Buffer | string {
  return execFileSync(process.execPath, [script, ...args], opts as never)
}
