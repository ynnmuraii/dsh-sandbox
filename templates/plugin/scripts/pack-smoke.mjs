#!/usr/bin/env node
// Packed-bundle smoke (design §12 item 5, criterion §16.9): build, pack,
// install the produced tarball into an isolated temp workspace, then EXECUTE
// the built entry (lib/index.js) through a real cordis Context and assert the
// plugin's observable contract — no model/API key needed. Self-contained so the
// plugin repo can run it standalone, without the parent meta-repo.
//
// Usage: node scripts/pack-smoke.mjs [prebuilt-tarball]
//   - with an absolute/relative tarball path: install + execute that tarball
//     (skips build + pack), used by `lab verify` against the tarball it packed;
//   - without: build + pack first, then install + execute (standalone run).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Resolve pnpm as a node-invocable arg array (no shell quoting). On Windows the
// `pnpm`/`pnpm.cmd` shims cannot be spawned by execFileSync without a shell, so
// parse the shim to find the real ESM entry it invokes (whose layout differs
// between an npm-global and a standalone `.tools` pnpm install), then run it
// with the current node executable.
function pnpmCommand() {
  if (process.platform !== 'win32') return { cmd: 'pnpm', args: [] }
  const shell = process.env.ComSpec ?? 'cmd.exe'
  const where = execFileSync(shell, ['/d', '/s', '/c', 'where pnpm'], { encoding: 'utf8' })
  const shim = (where.split(/\r?\n/).find(l => /pnpm\.cmd$/i.test(l.trim())) ?? where.split(/\r?\n/)[0]).trim()
  const text = readFileSync(shim, 'utf8')
  const m = /%~?dp0%?[\\.]([^\s"%]+pnpm\.(?:cjs|mjs))/i.exec(text)
  if (!m) throw new Error(`cannot locate the pnpm CLI entry from its shim at ${shim}`)
  const entry = resolve(dirname(shim), m[1])
  if (!existsSync(entry)) throw new Error(`resolved pnpm CLI entry does not exist: ${entry}`)
  return { cmd: process.execPath, args: [entry] }
}

function runPnpm(args, opts = {}) {
  const { cmd, args: pre } = pnpmCommand()
  return execFileSync(cmd, [...pre, ...args], opts)
}

// The plugin's own observable contract, executed keyless: the built entry must
// import, mount through a real cordis Context (with a capturing `tools`
// service injected), register the `greet` tool, and have it execute.
function loaderSource() {
  return `import { Context, Service } from '@deepseek-ai/cordis'
import * as plugin from '${pkg.name}'

class CapturingTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.captured = []
  }
  register(def) { this.captured.push(def); return () => {} }
}

const ctx = new Context()
const tools = new CapturingTools(ctx)
const fiber = ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
await fiber

const greet = tools.captured.find(t => t.name === 'greet')
if (!greet) {
  console.error('FAIL: greet tool not registered; got', tools.captured.map(t => t.name))
  process.exit(1)
}
const out = await greet.execute({ name: 'World' })
if (out !== 'Hello, World!') {
  console.error('FAIL: unexpected execute result', JSON.stringify(out))
  process.exit(1)
}
await fiber.dispose()
console.log('pack-smoke OK: built entry imported, greet tool registered and executed')
`
}

async function main() {
  const arg = process.argv[2]
  let tarball = arg ? resolve(process.cwd(), arg) : null
  if (!tarball) {
    runPnpm(['build'], { cwd: root, stdio: 'inherit' })
    const packOut = runPnpm(['pack', '--json'], { cwd: root, encoding: 'utf8' })
    const packed = JSON.parse(packOut)
    const first = (Array.isArray(packed) ? packed[0] : packed) || (() => { throw new Error('pack produced no tarball') })()
    tarball = join(root, first.filename)
  }
  if (!existsSync(tarball)) throw new Error(`tarball not found: ${tarball}`)

  const tmp = mkdtempSync(join(tmpdir(), 'dsh-pack-smoke-'))
  try {
    // Install the plugin AND its peer dependencies (cordis, dsh-tools) as
    // explicit top-level dependencies: pnpm does not auto-install a dependency's
    // peers at the workspace root, but the built entry and the loader both import
    // them. Pinned exact versions come from the plugin's own manifest.
    const manifest = {
      name: 'pack-smoke',
      private: true,
      dependencies: {
        [pkg.name]: `file:${tarball.replace(/\\/g, '/')}`,
        ...(pkg.peerDependencies ?? {}),
      },
    }
    writeFileSync(join(tmp, 'package.json'), JSON.stringify(manifest, null, 2))
    runPnpm(['install', '--config.strictDepBuilds=false', '--config.minimumReleaseAge=0'], {
      cwd: tmp,
      stdio: 'inherit',
    })
    // Loader lives inside tmp so bare specifiers resolve from its node_modules.
    const loader = join(tmp, 'smoke-loader.mjs')
    writeFileSync(loader, loaderSource())
    execFileSync(process.execPath, [loader], { cwd: tmp, stdio: 'inherit', env: process.env })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch(e => {
  console.error(`pack-smoke failed: ${e.message}`)
  process.exit(1)
})
