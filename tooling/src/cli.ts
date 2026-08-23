#!/usr/bin/env node
import { doctor } from './doctor.js'
import { createPlugin } from './create.js'
import { syncContext } from './sync.js'
import { devPlugin } from './run.js'
import { checkUpstream, updateUpstream } from './upstream-update.js'
import { parsePluginSelector, resolvePluginRef } from './plugin-ref.js'
import { inspectPlugin } from './inspect.js'
import { verifyPlugin } from './verify.js'
import { derivePluginStatus, type PluginStatus, type StatusClaim } from './status.js'

export { parsePluginSelector } from './plugin-ref.js'

const HELP = `
Usage: lab <command> [args]

Commands:
  new <name>               create a standalone plugin repo from the template
  dev <name>|--path P --target T       run live source overlay + HMR (next|master)
  verify <name>|--path P --target T [--json] run plugin checks + compatibility
  inspect <name>|--path P [--target T] [--json] inspect plugin contracts
  status <name>|--path P [--json]      derive current verification status
    exit 0 all applicable claims current/pass; exit 2 any applicable stale/not-run/failed;
    exit 1 selector/tooling error
  sync-context [name|--all] regenerate shared-context projections and the agent skill
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
      if (rest.length === 0) {
        console.error('error: usage: lab dev <name> [--target next|master]')
        return 1
      }
      try {
        const parsed = parsePluginSelector(rest)
        const target = parseTarget(parsed.rest, ['next', 'master']) as 'next' | 'master'
        const plugin = resolvePluginRef({ root: process.cwd(), selector: parsed.selector })
        await devPlugin({ root: process.cwd(), plugin, target })
        return 0
      } catch (e) {
        console.error(`error: ${(e as Error).message}`)
        return 1
      }
    }
    case 'verify': {
      if (rest.length === 0) {
        console.error('error: usage: lab verify <name> [--target next|master|all]')
        return 1
      }
      try {
        const parsed = parsePluginSelector(rest)
        const flags = parseVerifyFlags(parsed.rest)
        const plugin = resolvePluginRef({ root: process.cwd(), selector: parsed.selector })
        validateMetadataTargets(plugin)
        const target = flags.target ?? inferVerifyTarget(plugin)
        const run = () => verifyPlugin({ root: process.cwd(), plugin, target })
        const result = flags.json ? await suppressConsoleProgress(run) : await run()
        if (flags.json) {
          console.log(JSON.stringify(result))
        } else {
          for (const step of result.steps) {
            console.log(`[${step.status}] ${step.id} (${step.durationMs}ms)`)
          }
          console.log(`verify: ${result.result}; cleanup: ${result.cleanup}`)
        }
        return result.result === 'pass' ? 0 : 1
      } catch (e) {
        console.error(`error: ${(e as Error).message}`)
        return 1
      }
    }
    case 'inspect': {
      if (rest.length === 0) {
        console.error('error: usage: lab inspect <name> [--target next|master] [--json]')
        return 1
      }
      try {
        const parsed = parsePluginSelector(rest)
        const flags = parseInspectFlags(parsed.rest)
        const plugin = resolvePluginRef({ root: process.cwd(), selector: parsed.selector })
        const result = inspectPlugin({
          root: process.cwd(),
          plugin,
          ...(flags.target === undefined ? {} : { target: flags.target }),
        })
        if (flags.json) {
          console.log(JSON.stringify(result))
        } else {
          console.log(`plugin ${result.plugin.packageName} (${result.plugin.sourcePath})`)
          for (const diagnostic of result.diagnostics) {
            console.log(`[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`)
            if (diagnostic.remediation) console.log(`  fix: ${diagnostic.remediation}`)
          }
        }
        return result.ok ? 0 : 1
      } catch (e) {
        console.error(`error: ${(e as Error).message}`)
        return 1
      }
    }
    case 'status': {
      if (rest.length === 0) {
        console.error('error: usage: lab status <name> [--json]')
        return 1
      }
      try {
        const parsed = parsePluginSelector(rest)
        const flags = parseStatusFlags(parsed.rest)
        const plugin = resolvePluginRef({ root: process.cwd(), selector: parsed.selector })
        const result = derivePluginStatus({ root: process.cwd(), plugin })
        if (flags.json) {
          console.log(JSON.stringify(result))
        } else {
          printStatus(result)
        }
        return statusExitCode(result)
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

function parseVerifyFlags(rest: string[]): { target?: 'next' | 'master' | 'all'; json: boolean } {
  let target: 'next' | 'master' | 'all' | undefined
  let json = false
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    if (flag === '--json') {
      if (json) throw new Error('--json may be specified only once')
      json = true
      continue
    }
    if (flag === '--target') {
      if (target !== undefined) throw new Error('--target may be specified only once')
      const value = rest[i + 1]
      if (value !== 'next' && value !== 'master' && value !== 'all') {
        throw new Error(`invalid --target '${value ?? ''}' (expected next|master|all)`)
      }
      target = value
      i += 1
      continue
    }
    throw new Error(`unknown verify flag '${flag}'`)
  }
  return target === undefined ? { json } : { target, json }
}

function inferVerifyTarget(plugin: { metadata?: { targets?: string[] } }): 'next' | 'master' | 'all' {
  const declared = validateMetadataTargets(plugin)
  if (declared.length === 1) return declared[0]!
  if (declared.length > 1) return 'all'
  throw new Error('verify requires --target when plugin metadata does not declare a target')
}

function validateMetadataTargets(plugin: { metadata?: { targets?: string[] } }): Array<'next' | 'master'> {
  const raw = plugin.metadata?.targets ?? []
  for (const target of raw) {
    if (target !== 'next' && target !== 'master') {
      throw new Error(`unknown target '${target}' in plugin metadata`)
    }
  }
  return raw.filter(
    (target): target is 'next' | 'master' => target === 'next' || target === 'master',
  )
}

async function suppressConsoleProgress<T>(operation: () => Promise<T>): Promise<T> {
  const originalLog = console.log
  console.log = () => undefined
  try {
    return await operation()
  } finally {
    console.log = originalLog
  }
}

function parseInspectFlags(rest: string[]): { target?: 'next' | 'master'; json: boolean } {
  let target: 'next' | 'master' | undefined
  let json = false
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    if (flag === '--json') {
      if (json) throw new Error('--json may be specified only once')
      json = true
      continue
    }
    if (flag === '--target') {
      if (target !== undefined) throw new Error('--target may be specified only once')
      const value = rest[i + 1]
      if (value !== 'next' && value !== 'master') {
        throw new Error(`invalid --target '${value ?? ''}' (expected next|master)`)
      }
      target = value
      i += 1
      continue
    }
    throw new Error(`unknown inspect flag '${flag}'`)
  }
  return target === undefined ? { json } : { target, json }
}

function parseStatusFlags(rest: string[]): { json: boolean } {
  let json = false
  for (const flag of rest) {
    if (flag === '--json') {
      if (json) throw new Error('--json may be specified only once')
      json = true
      continue
    }
    throw new Error(`unknown status flag '${flag}'`)
  }
  return { json }
}

function printStatus(result: PluginStatus): void {
  console.log(`Plugin: ${result.plugin.packageName}`)
  console.log(`Structure: ${formatClaim(result.structure)}`)
  console.log(`Bundle: ${formatClaim(result.bundle)}`)
  for (const [target, claim] of Object.entries(result.targets)) {
    console.log(`DSH ${target}: ${formatClaim(claim)}`)
  }
  console.log(`UI review: ${formatClaim(result.ui)}`)
}

function formatClaim(claim: StatusClaim): string {
  const detail = claim.reasons && claim.reasons.length > 0 ? ` - ${claim.reasons.join(', ')}` : ''
  return `${claim.state.toUpperCase()}${detail}`
}

function statusExitCode(result: PluginStatus): number {
  const claims = [result.structure, result.bundle, ...Object.values(result.targets), result.ui]
  return claims.some(claim => claim.state !== 'pass' && claim.state !== 'not-applicable') ? 2 : 0
}

// Allow direct node execution.
if (process.argv[1] && process.argv[1].endsWith('cli.ts')) {
  runCli(process.argv.slice(2)).then(code => process.exit(code))
}
