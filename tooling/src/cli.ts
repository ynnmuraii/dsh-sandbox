#!/usr/bin/env node
import { doctor } from './doctor.js'
import { createPlugin } from './create.js'
import { syncContext } from './sync.js'
import { devSource, verifyBundle, type VerifyOptions } from './run.js'
import { checkUpstream, updateUpstream } from './upstream-update.js'

const HELP = `
Usage: lab <command> [args]

Commands:
  new <name>               create a standalone plugin repo from the template
  dev <name> --target T    run source overlay + HMR against target (next|master)
  verify <name> [--target T] run plugin checks + target compatibility
  sync-context [name|--all] regenerate shared-context snapshots
  doctor                   validate toolchain, catalog, and target pins
  upstream check           compare the pinned master commit with the remote
  upstream update [--verify] explicitly adopt the fetched master commit
`

const UPSTREAM_HELP = `
Usage: lab upstream <command>

Commands:
  upstream check             print pinned/remote master commits (stale exits 2)
  upstream update [--verify] adopt remote master; optionally run full verification
`

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'doctor':
      return report(await doctor({ root: process.cwd() }))
    case 'new': {
      const name = rest[0]
      if (!name) {
        console.error('error: usage: lab new <name>')
        return 1
      }
      try {
        const created = await createPlugin({ root: process.cwd(), name })
        console.log(`created plugin at ${created}`)
        return 0
      } catch (e) {
        console.error(`error: ${(e as Error).message}`)
        return 1
      }
    }
    case 'sync-context': {
      const all = rest.includes('--all')
      const names = rest.filter(a => a !== '--all')
      const res = await syncContext({ root: process.cwd(), names, all })
      for (const r of res) {
        console.log(r.changed ? `synced  ${r.path}` : `current ${r.path}`)
      }
      return 0
    }
    case 'dev': {
      const [name] = rest.filter(a => !a.startsWith('--'))
      if (!name) {
        console.error('error: usage: lab dev <name> [--target next|master]')
        return 1
      }
      try {
        const target = parseTarget(rest, ['next', 'master']) as 'next' | 'master'
        await devSource({ root: process.cwd(), name, target })
        return 0
      } catch (e) {
        console.error(`error: ${(e as Error).message}`)
        return 1
      }
    }
    case 'verify': {
      const [name] = rest.filter(a => !a.startsWith('--'))
      if (!name) {
        console.error('error: usage: lab verify <name> [--target next|master|all]')
        return 1
      }
      try {
        const target = parseTarget(rest, ['next', 'master', 'all']) as VerifyOptions['target']
        await verifyBundle({ root: process.cwd(), name, target })
        return 0
      } catch (e) {
        console.error(`error: ${(e as Error).message}`)
        return 1
      }
    }
    case 'upstream':
      return runUpstream(rest)
    case '--help':
    case '-h':
    case undefined:
      console.log(HELP)
      return 0
    default:
      console.error(`error: unknown command '${cmd}'\n${HELP}`)
      return 1
  }
}

async function runUpstream(rest: string[]): Promise<number> {
  const [subcommand, ...flags] = rest
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(UPSTREAM_HELP)
    return 0
  }
  try {
    if (subcommand === 'check' && flags.length === 0) {
      const status = checkUpstream({ root: process.cwd() })
      console.log(`pinned: ${status.pinned}`)
      console.log(`remote: ${status.remote}`)
      console.log(status.current ? 'status: current' : 'status: update available')
      return status.current ? 0 : 2
    }
    if (subcommand === 'update' && flags.every(flag => flag === '--verify')) {
      if (flags.filter(flag => flag === '--verify').length > 1) {
        throw new Error('--verify may be specified only once')
      }
      const verify = flags.includes('--verify')
      const result = await updateUpstream({ root: process.cwd(), verify })
      console.log(`previous: ${result.previous}`)
      console.log(`adopted: ${result.adopted}`)
      console.log(`changed: ${result.changed ? 'yes' : 'no'}`)
      if (verify) {
        console.log(`verified plugins: ${result.verifiedPlugins.join(', ') || 'none'}`)
      }
      return 0
    }
    console.error(`error: usage: lab upstream check | update [--verify]\n${UPSTREAM_HELP}`)
    return 1
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    return 1
  }
}

function report(results: { level: string; message: string }[]): number {
  let failed = false
  for (const r of results) {
    if (r.level === 'error') failed = true
    console[resultLogLevel(r.level)](`[${r.level}] ${r.message}`)
  }
  return failed ? 1 : 0
}

function resultLogLevel(level: string): 'error' | 'warn' | 'log' {
  return level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'
}

// Parse `--target <T>` from the arg list against an allowed set; default to the
// first allowed value. `verify` allows next|master|all; `dev` is next|master.
function parseTarget(rest: string[], allowed: readonly string[]): string {
  const i = rest.indexOf('--target')
  if (i === -1) return allowed[0] as string
  const value = rest[i + 1] ?? ''
  if (!allowed.includes(value)) {
    throw new Error(`invalid --target '${value}' (expected ${allowed.join('|')})`)
  }
  return value
}

// Allow direct node execution.
if (process.argv[1] && process.argv[1].endsWith('cli.ts')) {
  runCli(process.argv.slice(2)).then(code => process.exit(code))
}
