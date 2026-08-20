#!/usr/bin/env node
import { doctor } from './doctor.js'
import { createPlugin } from './create.js'
import { syncContext } from './sync.js'

const HELP = `
Usage: lab <command> [args]

Commands:
  new <name>               create a standalone plugin repo from the template
  dev <name> --target T    run source overlay + HMR against target (next|master)
  verify <name> [--target T] run plugin checks + target compatibility
  sync-context [name|--all] regenerate shared-context snapshots
  doctor                   validate toolchain, catalog, and target pins
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
    case 'dev':
    case 'verify':
      console.error(`error: '${cmd}' not implemented yet`)
      return 1
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

// Allow direct node execution.
if (process.argv[1] && process.argv[1].endsWith('cli.ts')) {
  runCli(process.argv.slice(2)).then(code => process.exit(code))
}
