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
import {
  abortUiSession,
  finishUiSession,
  getUiSessionStatus,
  startUiSession,
  type UiSessionViewV1,
} from './ui.js'
import type { UiResultV1 } from './ui-evidence.js'

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
  sync-context [name|--all] regenerate shared-context snapshots inside plugin repos
  ui start <name>|--path P --target T [--json]  start an isolated UI session
  ui status <session-id> [--json]              inspect a UI session
  ui finish <session-id> --verdict pass|fail --summary S [--json]  finalize a UI session
  ui abort <session-id> [--json]               abort a UI session
  UI browser/vision interaction is owned by the external browser agent/harness;
  screenshots are transient and not retained by lab.
  doctor                   validate toolchain, catalog, and target pins
  upstream check           compare the pinned master commit with the remote
  upstream update [--verify] explicitly adopt the fetched master commit
  mcp                      start MCP stdio server (read-only control plane)
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
    case 'ui':
      return runUi(rest)
    case 'upstream':
      return runUpstream(rest)
    case 'mcp': {
      const { runMcp } = await import('./mcp/index.js')
      return runMcp(process.cwd())
    }
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

export function inferVerifyTarget(plugin: { metadata?: { targets?: string[] } }): 'next' | 'master' | 'all' {
  const declared = validateMetadataTargets(plugin)
  if (declared.length === 1) return declared[0]!
  if (declared.length > 1) return 'all'
  throw new Error('verify requires --target when plugin metadata does not declare a target')
}

export function validateMetadataTargets(plugin: { metadata?: { targets?: string[] } }): Array<'next' | 'master'> {
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

async function runUi(rest: string[]): Promise<number> {
  const [subcommand, ...args] = rest
  try {
    if (subcommand === 'start') {
      const parsed = parseUiStart(args)
      const plugin = resolvePluginRef({ root: process.cwd(), selector: parsed.selector })
      const operation = () => startUiSession({ root: process.cwd(), plugin, target: parsed.target })
      const view = parsed.json ? await suppressConsoleProgress(operation) : await operation()
      if (parsed.json) console.log(JSON.stringify(view))
      else printUiStart(view)
      return uiStartExitCode(view)
    }
    if (subcommand === 'status') {
      const parsed = parseUiStatus(args)
      const operation = () => getUiSessionStatus({ root: process.cwd(), sessionId: parsed.sessionId })
      const view = parsed.json ? await suppressConsoleProgress(operation) : operation()
      if (parsed.json) console.log(JSON.stringify(view))
      else printUiStatus(view)
      return uiStatusExitCode(view)
    }
    if (subcommand === 'finish') {
      const parsed = parseUiFinish(args)
      const operation = () => finishUiSession({
        root: process.cwd(),
        sessionId: parsed.sessionId,
        verdict: parsed.verdict,
        summary: parsed.summary,
      })
      const result = parsed.json ? await suppressConsoleProgress(operation) : await operation()
      if (parsed.json) console.log(JSON.stringify(result))
      else printUiFinish(result)
      return result.verdict === 'pass' ? 0 : 2
    }
    if (subcommand === 'abort') {
      const parsed = parseUiAbort(args)
      const operation = () => abortUiSession({ root: process.cwd(), sessionId: parsed.sessionId })
      const view = parsed.json ? await suppressConsoleProgress(operation) : await operation()
      if (parsed.json) console.log(JSON.stringify(view))
      else printUiAbort(view)
      return view.state === 'aborted' ? 0 : 2
    }
    throw new Error('usage: lab ui start|status|finish|abort')
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    if (isUiProtocolOutcomeError(error)) return 2
    return 1
  }
}

function isUiProtocolOutcomeError(error: unknown): error is { name: 'UiProtocolOutcomeError'; outcome: 'stale' | 'cleanup-incomplete'; exitCode: 2 } {
  return error !== null && typeof error === 'object' && (error as { name?: unknown }).name === 'UiProtocolOutcomeError' && ((error as { outcome?: unknown }).outcome === 'stale' || (error as { outcome?: unknown }).outcome === 'cleanup-incomplete') && (error as { exitCode?: unknown }).exitCode === 2
}

interface UiSelectorParse {
  selector: { name?: string; path?: string }
  target: 'next' | 'master'
  json: boolean
}

interface UiSessionParse { sessionId: string; json: boolean }
interface UiFinishParse extends UiSessionParse { verdict: 'pass' | 'fail'; summary: string }

const UI_SESSION_ID_PATTERN = /^ui-[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}$/

function parseUiStart(args: string[]): UiSelectorParse {
  let name: string | undefined
  let path: string | undefined
  let target: 'next' | 'master' | undefined
  let json = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--path') {
      if (path !== undefined || name !== undefined) throw new Error('--path may not be combined with a positional plugin name')
      const value = args[++i]
      if (value === undefined || value.length === 0 || value.startsWith('--')) throw new Error('--path requires a value')
      path = value
    } else if (arg === '--target') {
      if (target !== undefined) throw new Error('--target may be specified only once')
      const value = args[++i]
      if (value !== 'next' && value !== 'master') throw new Error(`invalid --target '${value ?? ''}' (expected next|master)`)
      target = value
    } else if (arg === '--json') {
      if (json) throw new Error('--json may be specified only once')
      json = true
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown ui start flag '${arg}'`)
    } else if (name === undefined && path === undefined) {
      name = arg
    } else {
      throw new Error('ui start accepts exactly one plugin selector')
    }
  }
  if (name === undefined && path === undefined) throw new Error('ui start requires a plugin name or --path')
  if (target === undefined) throw new Error('ui start requires --target next|master')
  return { selector: path === undefined ? { name: name! } : { path }, target, json }
}

function parseUiStatus(args: string[]): UiSessionParse {
  const parsed = parseUiSessionFlags(args, 'status')
  return parsed
}

function parseUiAbort(args: string[]): UiSessionParse {
  return parseUiSessionFlags(args, 'abort')
}

function parseUiSessionFlags(args: string[], command: string): UiSessionParse {
  let sessionId: string | undefined
  let json = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--json') {
      if (json) throw new Error('--json may be specified only once')
      json = true
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown ui ${command} flag '${arg}'`)
    } else if (sessionId === undefined) {
      sessionId = arg
    } else {
      throw new Error(`ui ${command} accepts exactly one session ID`)
    }
  }
  if (sessionId === undefined || !UI_SESSION_ID_PATTERN.test(sessionId)) throw new Error('invalid or unsafe session ID')
  return { sessionId, json }
}

function parseUiFinish(args: string[]): UiFinishParse {
  let sessionId: string | undefined
  let verdict: 'pass' | 'fail' | undefined
  let summary: string | undefined
  let json = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--verdict') {
      if (verdict !== undefined) throw new Error('--verdict may be specified only once')
      const value = args[++i]
      if (value !== 'pass' && value !== 'fail') throw new Error(`invalid --verdict '${value ?? ''}' (expected pass|fail)`)
      verdict = value
    } else if (arg === '--summary') {
      if (summary !== undefined) throw new Error('--summary may be specified only once')
      const value = args[++i]
      if (value === undefined || value.startsWith('--')) throw new Error('--summary requires a non-flag value')
      summary = value
    } else if (arg === '--json') {
      if (json) throw new Error('--json may be specified only once')
      json = true
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown ui finish flag '${arg}'`)
    } else if (sessionId === undefined) {
      sessionId = arg
    } else {
      throw new Error('ui finish accepts exactly one session ID')
    }
  }
  if (sessionId === undefined || !UI_SESSION_ID_PATTERN.test(sessionId)) throw new Error('invalid or unsafe session ID')
  if (verdict === undefined) throw new Error('ui finish requires --verdict pass|fail')
  if (summary === undefined) throw new Error('ui finish requires --summary')
  return { sessionId, verdict, summary, json }
}

function printUiStart(view: UiSessionViewV1): void {
  console.log(`UI session ${view.sessionId}: ${view.state}${view.url === undefined ? '' : ` ${view.url}`}`)
}

function printUiStatus(view: UiSessionViewV1): void {
  console.log(`UI session ${view.sessionId}: ${view.state}`)
  if (view.url !== undefined) console.log(`url: ${view.url}`)
  if (view.stale) console.log(`stale: ${view.staleReasons.join(', ')}; abort this session and start a new one`)
  if (view.error !== undefined) console.log(`error: ${view.error}; ${view.orphan === true ? 'remove the orphaned runtime directory manually' : 'inspect the runtime or abort the session'}`)
}

function printUiFinish(result: UiResultV1): void {
  console.log(`UI finish: ${result.verdict}; evidence: ${result.sessionId} (${result.operation})`)
}

function printUiAbort(view: UiSessionViewV1): void {
  console.log(`UI abort: ${view.state} (${view.sessionId})`)
}

function uiStartExitCode(view: UiSessionViewV1): number { return view.state === 'ready' && !view.stale ? 0 : 2 }
function uiStatusExitCode(view: UiSessionViewV1): number { return view.state === 'ready' && !view.stale ? 0 : 2 }

async function suppressConsoleProgress<T>(operation: () => T | Promise<T>): Promise<T> {
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error
  console.log = () => undefined
  console.warn = () => undefined
  console.error = () => undefined
  try {
    return await operation()
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
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
