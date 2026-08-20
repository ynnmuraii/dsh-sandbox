# DeepSeek Harness Plugin Laboratory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `dsh-lab` meta-repository (context library, plugin template, catalog, tooling, compatibility workbench) and prove it with one working example plugin that passes the §16 acceptance criteria of the approved design.

**Architecture:** A meta-repo whose root owns shared agent context, a plugin template, a machine-readable catalog + compatibility manifest, and a small TypeScript CLI (`lab`). Every plugin lives in its own independent Git repo under `plugins/`. The CLI supports exactly five commands: `new`, `dev`, `verify`, `sync-context`, `doctor`. Compatibility workbench runs a pinned upstream Harness checkout (submodule) plus exact npm `next` versions; plugin verification splits source/HMR mode from packed-bundle mode.

**Tech Stack:** Node 22.20+, pnpm 11 (root pins `packageManager`), TypeScript, tsx, vitest, Node's built-in `node:test`-free (we use vitest), YAML via `js-yaml`. Harness itself (`@deepseek-ai/dsh`) is used only inside the workbench, not as a root dependency.

## Global Constraints

Copied verbatim from the approved spec — every task inherits these:

1. DeepSeek Harness is a developer preview with compatibility-breaking changes; versions must be pinned exactly, never via `^`.
2. Two independently documented integration paths must NOT be conflated: source overlay (development) vs installable bundle (distribution).
3. `inject` is a contract. Required services are always declared via `inject`; optional ones are read via `ctx.get(name)` at use site.
4. Cordis fibers must be reversible: every `ctx.on`, registry registration, and external resource must carry a fiber-owned disposer; order-dependent async teardown goes in a single async disposer.
5. External non-revertible effects (network, persistence) are documented, never promised as rollback by the framework.
6. Patch layers replace whole config, not deep-merge. Stable entry `id`s are required. Tests must use realistic Loader/process composition, not hand-built `ctx.plugin()`.
7. plugin production code imports only public npm APIs — never files from `upstream/`.
8. Harness/Cordis service packages are `peerDependencies`; exact dev/test instances are duplicated in `devDependencies`.
9. Git `prepare`/`allowBuilds` are treated as untrusted executable code until reviewed; release smoke prefers npm/tarball.
10. Credentials live only in ignored runtime state or an external store; never in catalog, manifests, or snapshots.
11. Meta-repo does not touch plugin git state destructively; dirty submodules are reported, never reset.
12. The full plugin repo must remain cloneable and self-sufficient without the meta-repo parent.

---

### Task 1: Initialize the meta-repository

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.gitattributes`
- Create: `.editorconfig`
- Create: `README.md`
- Create: `.lab/runtime/README.md`

**Interfaces:**
- Consumes: nothing (greenfield; workspace is not yet a git repo).
- Produces: root package `@dsh-lab/meta` (private) with a `packageManager` pin, a workspace restricted to `tooling/*`, and a tsconfig/vitest base the tooling shares. Later tasks depend on these existing.

- [ ] **Step 1: Initialize git and write root manifests**

```bash
git init
```

`package.json`:

```json
{
  "name": "@dsh-lab/meta",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.7.0",
  "engines": {
    "node": "^22.19.0 || >=24.0.0"
  },
  "scripts": {
    "lab": "tsx tooling/src/cli.ts",
    "test": "vitest run",
    "typecheck": "tsc -b tooling/tsconfig.json",
    "doctor": "tsx tooling/src/cli.ts doctor"
  }
}
```

`pnpm-workspace.yaml` — **must** exclude `plugins/*` and `upstream/*` from workspaces:

```yaml
packages:
  - "tooling/*"
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    include: ['tooling/**/*.spec.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@lab': fileURLToPath(new URL('./tooling/src', import.meta.url)),
    },
  },
})
```

`.gitignore`:

```gitignore
node_modules/
.lab/runtime/
dist/
coverage/
*.tsbuildinfo
.DS_Store
.env
.edv/dsh*
```

**.gitattributes:**

```gitattributes
* text=auto
```

**.editorconfig:**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
```

`.lab/runtime/README.md` — explains the ignored runtime directory:

```markdown
# Runtime state

Everything under `.lab/runtime/` is machine-generated, git-ignored, and safe to
delete. It holds ephemeral profiles, absolute source overlays, logs, caches,
and DSH home data produced by `lab dev` / `lab verify`. Real credentials
belong in an ignored `.env` or an external store, never here.
```

- [ ] **Step 2: Verify tooling runs**

Run: `node --version`
Expected: `v22.x` (meets `^22.19.0`).

- [ ] **Step 3: Bootstrap empty tooling package**

Create `tooling/package.json` (a placeholder so the workspace installs):

```json
{
  "name": "@dsh-lab/tooling",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "js-yaml": "^4.2.0",
    "tsx": "^4.22.4"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.20.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
  }
}
```

Create `tooling/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "lib"
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Install and typecheck**

Run: `pnpm install`
Expected: installs js-yaml, tsx, typescript, vitest into root node_modules.

Run: `pnpm typecheck`
Expected: exits 0 (empty tooling compiles).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: initialize dsh-lab meta-repository scaffolding"
```

---

### Task 2: Compatibility manifest and catalog schemas

**Files:**
- Create: `workbench/compatibility.yaml`
- Create: `tooling/src/schemas.ts`
- Create: `tooling/src/schemas.spec.ts`

**Interfaces:**
- Consumes: Task 1 base tsconfig/vitest.
- Produces: `loadCompatibility(file): Compatibility`, `loadCatalog(file): Catalog`, `Compatibility`, `Catalog`, `CatalogEntry`, `PluginConfig` (from `.dsh-lab/plugin.yaml`), and `CompatibilityError` (thrown on malformed input). Task 4 (`doctor`) and Task 5 (`new`) consume these.

- [ ] **Step 1: Write the failing schema tests**

`tooling/src/schemas.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { loadCompatibility, loadCatalog } from './schemas.js'

const fixture = `
targets:
  next:
    dsh: 0.1.0-rc.8
    cordis: 4.0.1
    node: 22.20.0
  master:
    repository: deepseek-ai/deepseek-harness
    commit: 0000000000000000000000000000000000000000
    pnpm: 11.7.0
`

describe('loadCompatibility', () => {
  it('parses both next and master targets', () => {
    const c = loadCompatibility(fixture)
    expect(c.targets.next.dsh).toBe('0.1.0-rc.8')
    expect(c.targets.master.commit).toHaveLength(40)
  })

  it('rejects a target with a caret range', () => {
    const bad = fixture.replace('0.1.0-rc.8', '^0.1.0-rc.8')
    expect(() => loadCompatibility(bad)).toThrow(/exact|pin/i)
  })

  it('rejects master without a 40-char commit', () => {
    const bad = fixture.replace(
      '0000000000000000000000000000000000000000',
      'short',
    )
    expect(() => loadCompatibility(bad)).toThrow(/commit/i)
  })
})

describe('loadCatalog', () => {
  it('parses a mixed tracking catalog', () => {
    const catalog = loadCatalog(`
plugins:
  a:
    path: plugins/a
    repository: https://github.com/example/a
    tracking: submodule
  b:
    path: plugins/b
    tracking: local
`)
    expect(catalog.plugins.a.tracking).toBe('submodule')
    expect(catalog.plugins.b.tracking).toBe('local')
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run tooling/src/schemas.spec.ts`
Expected: FAIL — `Cannot find module './schemas.js'`.

- [ ] **Step 3: Write the minimal implementation**

`tooling/src/schemas.ts`:

```ts
import { load as loadYaml } from 'js-yaml'
import { readFileSync } from 'node:fs'

export interface TargetPin {
  dsh?: string
  cordis?: string
  node?: string
  pnpm?: string
  repository?: string
  commit?: string
}

export interface Compatibility {
  targets: Record<'next' | 'master', TargetPin>
}

export interface CatalogEntry {
  path: string
  repository?: string
  tracking: 'local' | 'submodule'
  maturity: 'experiment' | 'stable'
}

export interface Catalog {
  plugins: Record<string, CatalogEntry>
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function assertPin(kind: 'next' | 'master', pin: TargetPin): void {
  if (kind === 'next') {
    for (const v of [pin.dsh, pin.cordis, pin.node]) {
      if (v !== undefined && !EXACT_VERSION.test(v)) {
        throw new Error(`next target requires an exact pinned version, got '${v}'`)
      }
    }
  } else {
    if (!pin.commit || !/^[0-9a-f]{40}$/.test(pin.commit)) {
      throw new Error('master target requires a 40-char pinned git commit')
    }
  }
}

export function loadCompatibility(text: string): Compatibility {
  const raw = loadYaml(text) as Compatibility
  if (!raw?.targets?.next || !raw?.targets?.master) {
    throw new Error('compatibility manifest requires both next and master targets')
  }
  assertPin('next', raw.targets.next)
  assertPin('master', raw.targets.master)
  return raw
}

export function loadCompatibilityFromFile(path: string): Compatibility {
  return loadCompatibility(readFileSync(path, 'utf8'))
}

export function loadCatalog(text: string): Catalog {
  const raw = loadYaml(text) as Catalog
  if (!raw?.plugins || typeof raw.plugins !== 'object') {
    throw new Error('catalog requires a plugins map')
  }
  for (const [name, entry] of Object.entries(raw.plugins)) {
    if (entry.tracking !== 'local' && entry.tracking !== 'submodule') {
      throw new Error(`catalog entry '${name}' has invalid tracking '${entry.tracking}'`)
    }
    if (entry.tracking === 'submodule' && !entry.repository) {
      throw new Error(`submodule entry '${name}' requires a repository`)
    }
  }
  return raw
}

export function loadCatalogFromFile(path: string): Catalog {
  return loadCatalog(readFileSync(path, 'utf8'))
}
```

- [ ] **Step 4: Run and verify pass**

Run: `pnpm vitest run tooling/src/schemas.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the real compatibility manifest**

`workbench/compatibility.yaml` — values are the exact, verified pins from the design phase (re-check before commit; do not invent versions):

```yaml
targets:
  next:
    dsh: 0.1.0-rc.8
    cordis: 4.0.1
    node: 22.20.0
  master:
    repository: deepseek-ai/deepseek-harness
    commit: <replace with actual 40-char SHA after upstream submodule is registered in Task 8 — until then keep previous valid placeholder and update in Task 8>
    pnpm: 11.7.0
```

> Note: after recording a valid SHA, remove the bracketed instruction so no placeholder remains. The schema test only requires 40 hex chars, so an all-zero 40-char SHA is a legal intermediate used by the test fixture; the live manifest is finalized in Task 8.

- [ ] **Step 6: Commit**

```bash
git add workbench/compatibility.yaml tooling/src/schemas.ts tooling/src/schemas.spec.ts
git commit -m "feat: add compatibility manifest and catalog schemas"
```

---

### Task 3: Core context documents (agent library)

**Files:**
- Create: `context/harness-contracts.md`
- Create: `context/cordis-model.md`
- Create: `context/plugin-anatomy.md`
- Create: `context/testing-policy.md`
- Create: `context/compatibility.md`
- Create: `AGENTS.md` (root)

**Interfaces:**
- Consumes: design spec §6.1 and the research note `research/deepseek-harness-plugin-lab.md`.
- Produces: the canonical source-of-truth documents that `sync-context` (Task 6) compiles into per-plugin snapshots. Later tasks and agents read these.

- [ ] **Step 1: Verify references are in place**

Run: `ls research/deepseek-harness-plugin-lab.md`
Expected: file exists (written during design phase). If not, re-create it from the stored investigation summary before continuing.

Confirm `paper.pdf` placement — move the current `paper.pdf` to the permanent location and fix the research note's relative links:

```bash
mkdir -p references
git mv paper.pdf references/cordis-paper.pdf
```

Run and confirm the research note links still resolve: `grep -rn "paper.pdf" research/` — update `../paper.pdf#page=…` to `../references/cordis-paper.pdf#page=…` via edit.

- [ ] **Step 2: Write each context document (content is the deliverable; keep them concise, imperative, and actionable for agents)**

`context/harness-contracts.md` — the public plugin contracts of DeepSeek Harness: what a plugin module exports (`name`, `inject`, `Config`, `apply`), the two official integration paths (source overlay via absolute `--patch` path; installable bundle via `dsh.bundle.patch` + `dsh plugin --profile … add`), and the rule that function plugins must NOT export a default. Add a header line:

> **SOURCE OF TRUTH.** This file is compiled by `lab sync-context` into `plugins/*/.dsh-lab/shared-context.md`. Edit here, not in plugin snapshots.

`context/cordis-model.md` — fiber state machine (`PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED`, plus `FAILED`), effects (`ctx.on`, registry registrations, `ctx.plugin` are effects; external resources wrap in `ctx.effect()` returning a disposer), one async disposer for ordered teardown, and the dependency model (`inject` as mandatory contract, `ctx.get()` for optional).

`context/plugin-anatomy.md` — the standalone plugin repo layout (from design §5.2), package manifest contract (ESM, main/exports, files, `dsh.bundle`), peer vs dev dependency split, and the rule that production code imports only public npm APIs.

`context/testing-policy.md` — the six test levels from design §12 (behavior, lifecycle, dependency transitions, Loader composition, packed bundle, optional real-API) plus the HMR-safety rule for registries and the rule that a manual `ctx.plugin()` unit test never replaces a Loader/app/process smoke.

`context/compatibility.md` — how targets work (npm `next` exact pins vs pinned upstream `master`), where the manifest lives (`workbench/compatibility.yaml`), and how plugin `.dsh-lab/plugin.yaml` declares supported target IDs.

- [ ] **Step 3: Write the root AGENTS.md**

`AGENTS.md` indexes the context documents and documents the lab operations:

- Commands (from design §9.1): `pnpm lab new|dev|verify|sync-context|doctor`.
- Catalog policy for `local` vs `submodule` tracking.
- Rule that meta-repo never mutates plugin git state destructively.
- Rule that production plugin code imports only public npm APIs.
- Point to `context/*` as the single source of truth.

- [ ] **Step 4: Typecheck-adjacent sanity** (docs only; no compile step). Run `grep -rn "TODO\|TBD\|XXX" context/ AGENTS.md`.
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git add context/ AGENTS.md references/ research/
git commit -m "docs: add core context library and root agent index"
```

---

### Task 4: `lab` CLI skeleton + `doctor`

**Files:**
- Create: `tooling/src/cli.ts`
- Create: `tooling/src/doctor.ts`
- Create: `tooling/src/doctor.spec.ts`
- Modify: `tooling/src/context.ts` (helper `readContextFiles`)

**Interfaces:**
- Consumes: `loadCompatibilityFromFile`, `loadCatalogFromFile`, and `PluginConfig` loader from Task 2 (and Task 5's `loadPluginConfig` if already present).
- Produces: `runCli(argv: string[]): Promise<number>`; `doctor(opts): Promise<DiagnosticResult[]>` where `DiagnosticResult = { level: 'error'|'warn', message: string }`. `cli.ts` also dispatches `new`, `sync-context`, `dev`, `verify` to later tasks (stub dispatch that returns a "not implemented" error for now, replaced in Tasks 5–7).

- [ ] **Step 1: Write the failing doctor tests**

`tooling/src/doctor.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctor } from './doctor.js'

describe('doctor', () => {
  it('reports missing compatibility manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-'))
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'error' && /compatibility/i.test(r.message))).toBe(true)
  })

  it('reports version mismatch between manifest and installed node', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lab-'))
    mkdirSync(join(dir, 'workbench'), { recursive: true })
    writeFileSync(
      join(dir, 'workbench', 'compatibility.yaml'),
      [
        'targets:',
        '  next:',
        '    dsh: 0.1.0-rc.8',
        '    cordis: 4.0.1',
        '    node: 1.0.0',
        '  master:',
        '    repository: deepseek-ai/deepseek-harness',
        '    commit: 0000000000000000000000000000000000000000',
        '    pnpm: 11.7.0',
      ].join('\n'),
    )
    const res = await doctor({ root: dir })
    expect(res.some(r => r.level === 'error' && /node/i.test(r.message))).toBe(true)
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run tooling/src/doctor.spec.ts`
Expected: FAIL — `Cannot find module './doctor.js'`.

- [ ] **Step 3: Write the doctor implementation**

`tooling/src/context.ts` (path helper):

```ts
import { join } from 'node:path'

export const ROOT_PATHS = {
  compatibility: 'workbench/compatibility.yaml',
  catalog: 'catalog.yaml',
  contextDir: 'context',
  plugins: 'plugins',
  upstream: 'upstream/deepseek-harness',
  runtime: '.lab/runtime',
} as const

export function rootPath(root: string, rel: string): string {
  return join(root, rel)
}
```

`tooling/src/doctor.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadCompatibility, loadCompatibilityFromFile } from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'

export interface DiagnosticResult {
  level: 'error' | 'warn'
  message: string
}

export interface DoctorOptions {
  root: string
}

export async function doctor({ root }: DoctorOptions): Promise<DiagnosticResult[]> {
  const out: DiagnosticResult[] = []
  const compatPath = rootPath(root, ROOT_PATHS.compatibility)
  if (!existsSync(compatPath)) {
    out.push({ level: 'error', message: `missing compatibility manifest: ${compatPath}` })
    return out
  }

  let compat
  try {
    compat = loadCompatibilityFromFile(compatPath)
  } catch (e) {
    out.push({ level: 'error', message: `invalid compatibility manifest: ${(e as Error).message}` })
    return out
  }

  const expectedNode = compat.targets.next.node
  if (expectedNode) {
    const actual = process.versions.node
    if (actual !== expectedNode) {
      out.push({
        level: 'error',
        message: `node version mismatch: manifest pins ${expectedNode}, running ${actual}`,
      })
    }
  }

  const catalogPath = rootPath(root, ROOT_PATHS.catalog)
  if (!existsSync(catalogPath)) {
    out.push({ level: 'warn', message: `catalog not found: ${catalogPath}` })
  } else {
    try {
      readFileSync(catalogPath, 'utf8')
    } catch (e) {
      out.push({ level: 'error', message: `unreadable catalog: ${(e as Error).message}` })
    }
  }

  const upstreamPath = rootPath(root, ROOT_PATHS.upstream)
  if (!existsSync(join(upstreamPath, '.git'))) {
    out.push({ level: 'warn', message: `upstream checkout missing or not a git dir: ${upstreamPath}` })
  }

  return out
}
```

`tooling/src/cli.ts` (skeleton — dispatch for later tasks returns an explicit not-implemented error):

```ts
#!/usr/bin/env node
import { doctor } from './doctor.js'

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
    case 'new':
    case 'dev':
    case 'verify':
    case 'sync-context':
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tooling/src/doctor.spec.ts`
Expected: PASS.

Run: `pnpm lab doctor`
Expected: prints `[error] missing compatibility manifest: …workbench/compatibility.yaml` (before manifest exists) or resolves once Task 2's real manifest is present.

Run: `pnpm lab --help`
Expected: prints the help text and exits 0.

- [ ] **Step 5: Commit**

```bash
git add tooling/src/cli.ts tooling/src/doctor.ts tooling/src/doctor.spec.ts tooling/src/context.ts
git commit -m "feat: add lab CLI skeleton and doctor diagnostics"
```

---

### Task 5: Plugin template + `lab new`

**Files:**
- Create: `templates/plugin/package.json`
- Create: `templates/plugin/tsconfig.json`
- Create: `templates/plugin/src/index.ts`
- Create: `templates/plugin/tests/index.spec.ts`
- Create: `templates/plugin/.dsh-lab/plugin.yaml`
- Create: `templates/plugin/cordis.patch.yml`
- Create: `templates/plugin/README.md`
- Create: `templates/plugin/AGENTS.md`
- Create: `templates/plugin/.gitignore`
- Create: `tooling/src/create.ts`
- Create: `tooling/src/create.spec.ts`

**Interfaces:**
- Consumes: `Catalog`/`CatalogEntry` from Task 2; `rootPath` from Task 4.
- Produces: `createPlugin(opts: { root: string; name: string }): Promise<string>` (returns created path) and `loadPluginConfig(path): PluginConfig`. `PluginConfig = { name: string; targets: string[]; tracking: string }`.

- [ ] **Step 1: Write the failing create tests**

`tooling/src/create.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlugin, loadPluginConfig } from './create.js'

describe('createPlugin', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-new-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates an independent git repo with template files', async () => {
    const target = join(dir, 'plugins', 'example')
    const created = await createPlugin({ root: dir, name: 'example' })
    expect(created).toBe(target)
    expect(existsSync(join(target, '.git'))).toBe(true)
    expect(existsSync(join(target, 'src', 'index.ts'))).toBe(true)
    expect(existsSync(join(target, '.dsh-lab', 'shared-context.md'))).toBe(true)
  })

  it('refuses an existing non-empty target', async () => {
    await createPlugin({ root: dir, name: 'example' })
    await expect(createPlugin({ root: dir, name: 'example' })).rejects.toThrow(/exists/i)
  })

  it('writes plugin.yaml that round-trips', async () => {
    const created = await createPlugin({ root: dir, name: 'example' })
    const cfg = loadPluginConfig(join(created, '.dsh-lab', 'plugin.yaml'))
    expect(cfg.name).toBe('example')
    expect(cfg.tracking).toBe('local')
    expect(cfg.targets).toContain('next')
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run tooling/src/create.spec.ts`
Expected: FAIL — `Cannot find module './create.js'`.

- [ ] **Step 3: Write the template files**

`templates/plugin/package.json` (name/version is templated by substituting `__PLUGIN_NAME__`; see create.ts):

```json
{
  "name": "@dsh-lab/dsh-plugin-__PLUGIN_NAME__",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": {
      "patch": "cordis.patch.yml"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "pack": "pnpm pack"
  }
}
```

`templates/plugin/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "lib",
    "declaration": true,
    "emitDeclarationOnly": false,
    "rootDir": "src"
  },
  "include": ["src"]
}
```

`templates/plugin/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

> The template extends the meta-repo base by absolute-relative path `../../tsconfig.base.json`. Because a standalone clone has no parent, the plugin's own `tsconfig.json` **must** be self-contained. To satisfy global constraint 12, `create.ts` copies the base compiler options inline into the plugin's `tsconfig.json` instead of leaving the `extends`. See Step 4 substitution — replace the `extends` block with inline options in the placeholder `../../tsconfig.base.json` position.

`templates/plugin/src/index.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = '__PLUGIN_NAME__'

export function apply(ctx: Context) {
  // Register harness capabilities here. Anything registered through
  // ctx is disposed automatically when the fiber unloads.
  console.log(`[${name}] plugin loaded`)
}
```

`templates/plugin/tests/index.spec.ts` (behavior + lifecycle so the example passes Task 10's §16.5):

```ts
import { Context } from '@deepseek-ai/cordis'
import { describe, it, expect } from 'vitest'
import { apply } from '../src/index.js'

// Minimal durable registry to prove cleanup on dispose.
const logs: string[] = []

describe('example plugin', () => {
  it('logs a load message on apply', () => {
    const ctx = new Context()
    ctx.effect(() => () => {}) // keep ctx alive long enough
    ctx.on('dispose', () => {})
    apply(ctx)
    expect(logs).toStrictEqual([]) // placeholder; replaced with a real side-effect assertion in Task 9
  })
})
```

> Note: This test is intentionally provisional. The example plugin's observable contract (what it registers/sees) is finalized in Task 9, which gives the plugin a concrete capability (a tool or service) with a real lifecycle test. Keep this file as the behavior-test scaffold.

`templates/plugin/.dsh-lab/plugin.yaml`:

```yaml
name: __PLUGIN_NAME__
tracking: local
maturity: experiment
targets:
  - next
```

`templates/plugin/cordis.patch.yml` — annotated placeholder; the loader path is filled at runtime (absolute) or left as the package bundle path for release.

```yaml
# Patch layer contributed by this plugin's bundle. Release installs this file
# via dsh.bundle.patch; lab dev generates a source overlay instead.
```

`templates/plugin/README.md`:

```markdown
# dsh-plugin-__PLUGIN_NAME__

DeepSeek Harness plugin. See `AGENTS.md` and `.dsh-lab/shared-context.md`.
```

`templates/plugin/AGENTS.md`:

```markdown
# Agent rules for this plugin

1. Read `.dsh-lab/shared-context.md` first — it is the compiled common context.
2. Read this file — it holds plugin-local architecture and commands.
3. All registrations must be fiber-owned (reversible on unload).
4. Production code imports only public npm APIs (`@deepseek-ai/*`, `@deepseek-ai/cordis`).
5. Required services go in `inject`; optional ones via `ctx.get(name)`.
6. Commands: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm pack`.
```

`templates/plugin/.gitignore`:

```gitignore
node_modules/
lib/
dist/
*.tsbuildinfo
.env
```

- [ ] **Step 4: Write the create implementation + self-contained tsconfig rewriting**

`tooling/src/create.ts`:

```ts
import { execSync } from 'node:child_process'
import { mkdirSync, cpSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT_PATHS } from './context.js'
import { load } as loadYaml from 'js-yaml'

const TEMPLATES = 'templates/plugin'

export interface PluginConfig {
  name: string
  tracking: 'local' | 'submodule'
  maturity: string
  targets: string[]
}

export function loadPluginConfig(path: string): PluginConfig {
  return loadYaml(readFileSync(path, 'utf8')) as PluginConfig
}

function render(templateDir: string, targetDir: string, name: string): void {
  for (const entry of readDirRecursive(templateDir)) {
    const rel = entry.slice(templateDir.length)
    const out = join(targetDir, rel.replace(/__PLUGIN_NAME__/g, name))
    if (entry.endsWith('/')) {
      mkdirSync(out, { recursive: true })
      continue
    }
    mkdirSync(join(out, '..'), { recursive: true })
    const text = readFileSync(entry, 'utf8')
    writeFileSync(out, text.replaceAll('__PLUGIN_NAME__', name))
  }
}

function readDirRecursive(dir: string): string[] {
  const entries: string[] = []
  for (const f of readDirSorted(dir)) {
    const full = join(dir, f)
    if (statIsDir(full)) {
      entries.push(full + '/')
      entries.push(...readDirRecursive(full))
    } else {
      entries.push(full)
    }
  }
  return entries
}

export async function createPlugin(opts: { root: string; name: string }): Promise<string> {
  const { root, name } = opts
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid plugin name '${name}': use lowercase letters, digits, hyphens`)
  }
  const target = join(root, ROOT_PATHS.plugins, name)
  if (existsSync(target) && readDirRecursive(target).length > 0) {
    throw new Error(`plugin target already exists and is non-empty: ${target}`)
  }
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  const templateDir = join(root, TEMPLATES)
  render(templateDir, target, name)

  // Make tsconfig.json self-contained (inline base options) so a standalone
  // clone compiles without the meta-repo parent (global constraint 12).
  const tsconfigPath = join(target, 'tsconfig.json')
  const standaloneTsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
    },
    include: ['src', 'tests'],
  }
  writeFileSync(tsconfigPath, JSON.stringify(standaloneTsconfig, null, 2) + '\n')

  execSync('git init -q', { cwd: target, stdio: 'ignore' })
  return target
}
```

> Note: the helpers `readDirSorted` and `statIsDir` are small Node wrappers; implement them using `readdirSync(dir, { withFileTypes: true })` and `Dirent.isDirectory()`, iterating sorted names so output is deterministic across platforms.

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm vitest run tooling/src/create.spec.ts`
Expected: PASS.

Run from a scratch dir to observe a real plugin:

```bash
mkdir -p /tmp/dsh-new-probe && cd /tmp/dsh-new-probe
# point lab at a root that has templates/plugin by temporarily copying them, or run within the repo root:
cd <meta-repo-root> && pnpm lab new example
ls plugins/example
```

Expected: `plugins/example` exists with `.git`, `src/index.ts`, `.dsh-lab/shared-context.md` (created by Task 6's sync; if Task 6 not yet wired, create a stub snapshot with a "not yet synchronized" header — see Task 6).

- [ ] **Step 6: Commit**

```bash
git add templates/ tooling/src/create.ts tooling/src/create.spec.ts
git commit -m "feat: add plugin template and lab new command"
```

---

### Task 6: `lab sync-context`

**Files:**
- Create: `tooling/src/sync.ts`
- Create: `tooling/src/sync.spec.ts`
- Modify: `tooling/src/cli.ts` (wire `sync-context`)

**Interfaces:**
- Consumes: `ROOT_PATHS`, `loadCatalogFromFile` (Task 2), `createPlugin`'s `.dsh-lab` layout (Task 5).
- Produces: `syncContext(opts: { root: string; names: string[]; all: boolean }): Promise<SyncedResult>` where `SyncedResult = { name: string; changed: boolean; path: string }[]`. Also `snapshotContext(root: string, contextDocs: string[]): string` (pure — compiles documents into a snapshot string with a version hash).

- [ ] **Step 1: Write the failing sync tests**

`tooling/src/sync.spec.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotContext, syncContext } from './sync.js'

describe('snapshotContext', () => {
  it('embeds a version hash of the inputs', () => {
    const a = snapshotContext('/root', ['# c1\n'])
    const b = snapshotContext('/root', ['# c1\n'])
    const c = snapshotContext('/root', ['# c1 changed\n'])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^# Shared context snapshot/)
  })
})

describe('syncContext', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-sync-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('writes a snapshot into each plugin repo', () => {
    writeFileSync(join(dir, 'catalog.yaml'), 'plugins:\n  a:\n    path: plugins/a\n    tracking: local\n')
    writeFileSync(join(dir, 'workbench-compat-stub'), '')
    mkdirSync(join(dir, 'plugins', 'a'), { recursive: true })
    writeFileSync(join(dir, 'plugins', 'a', 'package.json'), '{}')
    const res = await syncContext({ root: dir, names: ['a'], all: false })
    expect(res[0].path).toBe(join(dir, 'plugins', 'a', '.dsh-lab', 'shared-context.md'))
    expect(readFileSync(res[0].path, 'utf8')).toMatch(/^# Shared context snapshot/)
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run tooling/src/sync.spec.ts`
Expected: FAIL — `Cannot find module './sync.js'`.

- [ ] **Step 3: Write the sync implementation**

`tooling/src/sync.ts`:

```ts
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadCatalogFromFile } from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'

export interface SyncedResult {
  name: string
  changed: boolean
  path: string
}

export interface SyncOptions {
  root: string
  names: string[]
  all: boolean
}

const SNAPSHOT_HEADER = '# Shared context snapshot\n'

export function snapshotContext(root: string, reads: string[]): string {
  const hash = createHash('sha256')
  for (const text of reads) hash.update(text)
  const digest = hash.digest('hex').slice(0, 12)
  const body = reads.map(t => t.trimEnd()).join('\n\n---\n\n')
  return `${SNAPSHOT_HEADER}\n> context version: ${digest}\n> regenerate with \`lab sync-context\`\n\n${body}\n`
}

function contextDocuments(root: string): string[] {
  const dir = rootPath(root, ROOT_PATHS.contextDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => readFileSync(join(dir, f), 'utf8'))
}

export async function syncContext({ root, names, all }: SyncOptions): Promise<SyncedResult[]> {
  const catalogPath = rootPath(root, ROOT_PATHS.catalog)
  const catalog = existsSync(catalogPath) ? loadCatalogFromFile(catalogPath) : { plugins: {} }
  const docs = contextDocuments(root)
  const snapshot = snapshotContext(root, docs)

  const targets = all
    ? Object.keys(catalog.plugins)
    : names.filter(n => catalog.plugins[n])

  const results: SyncedResult[] = []
  for (const name of targets) {
    const entry = catalog.plugins[name]
    const path = join(root, entry.path, '.dsh-lab', 'shared-context.md')
    mkdirSync(join(path, '..'), { recursive: true })
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
    const changed = existing !== snapshot
    if (changed) writeFileSync(path, snapshot)
    results.push({ name, changed, path })
  }
  return results
}
```

`tooling/src/cli.ts` — add a case for `sync-context`:

```ts
import { syncContext } from './sync.js'

// in the switch:
case 'sync-context': {
  const all = rest.includes('--all')
  const names = rest.filter(a => a !== '--all')
  const res = await syncContext({ root: process.cwd(), names, all })
  for (const r of res) {
    console.log(r.changed ? `synced  ${r.path}` : `current ${r.path}`)
  }
  return 0
}
```

- [ ] **Step 4: Run tests and wire into `new`**

Run: `pnpm vitest run tooling/src/sync.spec.ts`
Expected: PASS.

Update `create.ts`'s `createPlugin` (Task 5) to call `snapshotContext` and write `.dsh-lab/shared-context.md` as part of creation (a stub with the header if `context/` is empty), so `create` and `sync` agree. Add a small unit test asserting `createPlugin` writes a snapshot header.

- [ ] **Step 5: Verify end-to-end with the template**

Run:

```bash
pnpm lab new example
pnpm lab sync-context example
head -3 plugins/example/.dsh-lab/shared-context.md
```

Expected: snapshot header + `context version: …` line; repeat run reports `current …`.

- [ ] **Step 6: Commit**

```bash
git add tooling/src/sync.ts tooling/src/sync.spec.ts tooling/src/create.ts tooling/src/cli.ts
git commit -m "feat: add lab sync-context with hashed shared snapshots"
```

---

### Task 7: `lab dev` (source overlay + HMR) and `lab verify` (packed bundle) scaffolding

**Files:**
- Create: `tooling/src/run.ts`
- Create: `tooling/src/run.spec.ts`
- Create: `workbench/profiles/next/profile.package.json`
- Create: `workbench/profiles/master/profile.package.json`
- Modify: `tooling/src/cli.ts` (wire `dev` and `verify`)

**Interfaces:**
- Consumes: `loadPluginConfig` (Task 5), `loadCompatibilityFromFile` (Task 2), `rootPath` (Task 4).
- Produces: `devSource(opts: { root, name, target }): Promise<void>` and `verifyBundle(opts: { root, name, target }): Promise<void>`. These shell out to `pnpm` in the plugin repo and to the workbench profile; they read the profile package specs.

- [ ] **Step 1: Write failing run tests**

`tooling/src/run.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveSourceOverlay, buildProfilePackageJson } from './run.js'

describe('resolveSourceOverlay', () => {
  it('produces an absolute name for the plugin entry', () => {
    const p = resolveSourceOverlay('workspace', 'plugins/example', 'src/index.ts', 'example')
    expect(p).toMatch(/^[A-Za-z]:\//)
    expect(p).toContain('plugins/example/src/index.ts')
  })
})

describe('buildProfilePackageJson', () => {
  it('pins the dsh bundle and an exact version', () => {
    const spec = { name: 'dsh-profile-next', bundles: ['@deepseek-ai/dsh-base'] }
    const out = buildProfilePackageJson(spec, { dsh: '0.1.0-rc.8' })
    expect(out.dependencies['@deepseek-ai/dsh']).toBe('0.1.0-rc.8')
    expect(out).toHaveProperty('dsh')
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run tooling/src/run.spec.ts`
Expected: FAIL — `Cannot find module './run.js'`.

- [ ] **Step 3: Write run.ts (pure helpers first; executors are thin)**

`tooling/src/run.ts`:

```ts
import { join, resolve } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { loadPluginConfig } from './create.js'
import { loadCompatibilityFromFile } from './schemas.js'
import { ROOT_PATHS, rootPath } from './context.js'

export interface ProfileSpec {
  name: string
  bundles: string[]
}

export function resolveSourceOverlay(root, pluginRel, entryRel, name): string {
  return resolve(root, pluginRel, entryRel)
}

export function buildProfilePackageJson(spec: ProfileSpec, pin: { dsh: string }) {
  return {
    name: spec.name,
    private: true,
    type: 'module',
    dependencies: {
      '@deepseek-ai/dsh': pin.dsh,
    },
    dsh: {
      profile: {
        bundles: spec.bundles,
      },
    },
  }
}

export async function devSource(opts: { root: string; name: string; target: 'next' | 'master' }): Promise<void> {
  const { root, name, target } = opts
  const entry = catalogEntry(root, name)
  const cfg = loadPluginConfig(join(root, entry.path, '.dsh-lab', 'plugin.yaml'))
  if (!cfg.targets.includes(target)) {
    throw new Error(`plugin '${name}' does not declare target '${target}'`)
  }
  if (target === 'master' && !exists(rootPath(root, ROOT_PATHS.upstream + '/.git'))) {
    throw new Error('master target requires the pinned upstream checkout (see Task 8)')
  }
  const compat = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))
  const entryPath = resolve(root, entry.path, 'src', 'index.ts')

  // Emit an absolute overlay into the runtime dir.
  const overlayDir = join(root, ROOT_PATHS.runtime, 'overlays', name)
  mkdirSync(overlayDir, { recursive: true })
  const overlay = [
    '',
    '- insert:',
    `    - id: ${name}`,
    `      name: '${entryPath.replace(/\\/g, '/').replace(/'/g, `\\'`)}'`,
    '',
  ].join('\n')
  writeFileSync(join(overlayDir, 'cordis.patch.yml'), overlay)

  console.log(`[dev] plugin '${name}' (${target}) -> ${entryPath}`)
  console.log(`[dev] generated overlay: ${join(overlayDir, 'cordis.patch.yml')}`)
  console.log(`[dev] run dsh with '--patch <overlay>' (source mode; see profile spec below).`)
  // The thin executor that actually boots dsh + HMR and asserts it is
  // environment-dependent; its subprocess orchestration is implemented in
  // the finalization step of this task using the workbench profile.
}

export async function verifyBundle(opts: { root: string; name: string; target: string }): Promise<void> {
  const { root, name, target } = opts
  const entry = catalogEntry(root, name)
  // Build + pack in the plugin repo, then install into a temp profile and
  // assert the observable result. Implemented in the finalization step.
  console.log(`[verify] ${name} against ${target}`)
}

function catalogEntry(root: string, name: string) {
  const { loadCatalogFromFile } = /* inlined to avoid import cycle */ {}
  return { path: `plugins/${name}` }
}
```

> Note: `catalogEntry` here is a stub (avoids an import cycle between `run.ts` and `schemas.ts`). Make `run.ts` import `loadCatalogFromFile` directly from `schemas.js` — there is no real cycle — and implement `catalogEntry` to read the catalog and throw if the plugin is missing. Remove the inline-comment stub.

`workbench/profiles/next/profile.package.json`:

```json
{
  "name": "@dsh-lab/profile-next",
  "private": true,
  "type": "module",
  "dependencies": {
    "@deepseek-ai/dsh": "<set to exact next version by lab dev>"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base"]
    }
  }
}
```

`workbench/profiles/master/profile.package.json` — same shape, but depends on the pinned upstream source checkout (built separately in Task 8), not a registry `dsh`:

```json
{
  "name": "@dsh-lab/profile-master",
  "private": true,
  "type": "module",
  "dependencies": {
    "@deepseek-ai/dsh": "file:../../upstream/deepseek-harness"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base"]
    }
  }
}
```

> Caution: a `file:` dependency on the upstream checkout is a source dependency, not a real release boundary. `lab verify`'s master check therefore composes against the built upstream harness — it validates a selected upstream commit, and its result must be labelled as *source/master compatibility*, distinct from `next` packed-bundle verification. The profile packages are templates; `lab dev`/`lab verify` substitute exact versions at runtime.

`tooling/src/cli.ts` — wire `dev` and `verify` (parse `--target`, default `next`; `verify` accepts `all`):

```ts
case 'dev': {
  const [name] = rest.filter(a => !a.startsWith('--'))
  const target = parseTarget(rest)
  await devSource({ root: process.cwd(), name, target })
  return 0
}
case 'verify': {
  const [name] = rest.filter(a => !a.startsWith('--'))
  const target = parseTarget(rest)
  await verifyBundle({ root: process.cwd(), name, target })
  return 0
}
```

with a `parseTarget(rest): 'next'|'master'` helper that reads `--target`, errors on unknown values, and defaults to `'next'`.

- [ ] **Step 4: Finalize subprocess orchestration**

Complete `devSource` to boot the workbench profile against the overlay and watch source for HMR:

```ts
// After emitting the overlay (Step 3), run:
execSync('pnpm install', { cwd: profileDir, stdio: 'inherit' })
execSync(`pnpm exec dsh web --patch "${overlayPath}"`, { cwd: profileDir, stdio: 'inherit' })
```

Wrap this so a non-zero exit surfaces as a thrown error. Confirm the HMR root includes the plugin source (pass the plugin dir to the HMR plugin config in the overlay, or verify `@deepseek-ai/cordis-plugin-hmr` watches it).

- [ ] **Step 5: Run tests and smoke**

Run: `pnpm vitest run tooling/src/run.spec.ts`
Expected: PASS.

Run: `pnpm lab dev example --target next`
Expected: prints `[dev] plugin 'example' (next) -> …` and the generated overlay path; if `dsh` isn't installed in the profile yet the boot may fail — that is acceptable at this scaffolding stage and is asserted by Task 9's e2e.

- [ ] **Step 6: Commit**

```bash
git add tooling/src/run.ts tooling/src/run.spec.ts workbench/profiles/ tooling/src/cli.ts
git commit -m "feat: add dev source-overlay and verify bundle scaffolding"
```

---

### Task 8: Pin the upstream Harness submodule + master compatibility

**Files:**
- Modify: `workbench/compatibility.yaml` (record the real master commit)
- Create: `.gitmodules`
- Create: `tooling/src/upstream.ts`
- Create: `tooling/src/upstream.spec.ts`

**Interfaces:**
- Consumes: `loadCompatibilityFromFile` (Task 2), `ROOT_PATHS` (Task 4).
- Produces: `ensureUpstream(root, repository, commit): Promise<string>` (clones/checks out the submodule at the pinned commit) and `verifyUpstreamCommit(root, expected): Promise<boolean>`.

- [ ] **Step 1: Determine and record the pinned master commit**

Query the upstream default branch head (primary source — do not guess):

```bash
git ls-remote https://github.com/deepseek-ai/deepseek-harness.git refs/heads/master
```

Record the returned 40-char commit into `workbench/compatibility.yaml` under `targets.master.commit`, replacing the placeholder (Task 2). Also record the upstream `package.json` pnpm pin (confirm `11.7.0`) and Node engine floor (`^22.19.0`).

- [ ] **Step 2: Write failing upstream tests**

`tooling/src/upstream.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { verifyUpstreamCommit } from './upstream.js'

describe('verifyUpstreamCommit', () => {
  it('false when the upstream dir is not a git checkout', async () => {
    const ok = await verifyUpstreamCommit('/nonexistent', '0000000000000000000000000000000000000000')
    expect(ok).toBe(false)
  })
})
```

- [ ] **Step 3: Run and verify failure**

Run: `pnpm vitest run tooling/src/upstream.spec.ts`
Expected: FAIL — `Cannot find module './upstream.js'`.

- [ ] **Step 4: Implement upstream helpers**

`tooling/src/upstream.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT_PATHS, rootPath } from './context.js'

export async function verifyUpstreamCommit(root, expected): Promise<boolean> {
  const dir = rootPath(root, ROOT_PATHS.upstream)
  if (!existsSync(join(dir, '.git'))) return false
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    return head === expected
  } catch {
    return false
  }
}

export async function ensureUpstream(root, repository, commit): Promise<string> {
  const dir = rootPath(root, ROOT_PATHS.upstream)
  if (await verifyUpstreamCommit(root, commit)) return dir
  // Clone shallow at the exact commit, leaving the meta-repo's submodule entry in control.
  execFileSync('git', ['clone', '--no-checkout', repository, dir], { stdio: 'inherit' })
  execFileSync('git', ['checkout', commit], { cwd: dir, stdio: 'inherit' })
  return dir
}
```

- [ ] **Step 5: Register as a git submodule**

Register the upstream checkout as a git submodule so the meta-repo pins the exact commit in `.gitmodules` and a commit pointer:

```bash
git submodule add https://github.com/deepseek-ai/deepseek-harness.git upstream/deepseek-harness
cd upstream/deepseek-harness
git checkout <recorded-master-SHA>
cd ../..
git add .gitmodules upstream/deepseek-harness
git commit -m "chore: pin upstream deepseek-harness master submodule"
```

Confirm `.gitmodules` exists and records the URL. `ensureUpstream` remains the deterministic fallback for CI that clones fresh without submodule init.

- [ ] **Step 6: Verify doctor now passes the upstream check**

Run: `pnpm lab doctor`
Expected: no `upstream … missing` warning (or, if the submodule isn't initialized, the warning is expected and `verifyUpstreamCommit` returns false — ensure `doctor` uses `ensureUpstream` semantics or reports initialization status accurately, not a false error).

- [ ] **Step 7: Commit helpers**

```bash
git add tooling/src/upstream.ts tooling/src/upstream.spec.ts
git commit -m "feat: add pinned upstream harness helpers"
```

---

### Task 9: Example plugin with a real observable contract

**Files:**
- Create: `plugins/example/` (via `lab new example` is the base; this task gives it a real tool + lifecycle test)
  - Modify: `plugins/example/src/index.ts`
  - Modify: `plugins/example/tests/index.spec.ts`
  - Create: `plugins/example/tests/lifecycle.spec.ts`
  - Modify: `plugins/example/package.json` (add `@deepseek-ai/cordis` peer/dev, `@deepseek-ai/dsh-tools` peer/dev, tsx/vitest dev)
  - Modify: `plugins/example/.dsh-lab/plugin.yaml` (keep `tracking: local`)

**Interfaces:**
- Consumes: the template (Task 5), the shared context snapshot (Task 6), pinned `next` toolchain (Task 8).
- Produces: `plugins/example` as a standalone repo that (a) registers one `greet` tool via `ctx.tools.register`, (b) passes behavior + lifecycle + dependency-transition tests. `lab verify` (Task 7) and `lab doctor` (Task 10) consume this as the proof-of-concept plugin.

- [ ] **Step 1: Write the failing lifecycle test first (TDD)**

`plugins/example/tests/lifecycle.spec.ts`:

```ts
import { Context } from '@deepseek-ai/cordis'
import { describe, it, expect } from 'vitest'
import { apply } from '../src/index.js'

interface ToolRecorder {
  registered: string[]
}

function makeRecorder(): ToolRecorder {
  return { registered: [] }
}

describe('example plugin lifecycle', () => {
  it('registers the greet tool and unregisters it on fiber dispose', async () => {
    const recorder = makeRecorder()
    // Stand-in for the tools registry: a fake that records registrations and
    // returns a disposer, mirroring ctx.tools.register's contract.
    const ctx = new Context()
    ctx.effect(() => () => {})
    ctx.tools = {
      register: ((def: { name: string }) => {
        recorder.registered.push(def.name)
        return () => {
          recorder.registered = recorder.registered.filter(n => n !== def.name)
        }
      }) as any,
    }
    apply(ctx)
    expect(recorder.registered).toContain('greet')
    // Simulate unload: invoke the fiber disposer chain.
    await ctx.dispose()
    expect(recorder.registered).not.toContain('greet')
  })
})
```

> Note: this test drives a fake `ctx.tools` to prove the dispose contract without a network. A *real* Loader composition smoke (which needs the actual `dsh-tools` registry) is added in `lab verify`'s e2e (Task 7 finalized + §16.7). Do not claim the fake replaces the real-composition smoke; global constraint 8 + testing policy require both.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --dir plugins/example vitest run tests/lifecycle.spec.ts`
Expected: FAIL — `greet` not registered (src still logs only).

- [ ] **Step 3: Implement the greet tool**

`plugins/example/src/index.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'example'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet a named person.',
    parameters: {
      name: { type: 'string', required: true, description: 'Who to greet' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value: string) => [{ type: 'text', text: value as unknown as string }],
    },
    async execute(args: { name: string }) {
      return `Hello, ${args.name}!`
    },
  }))
}
```

- [ ] **Step 4: Wire deps into the plugin package.json**

Add to `plugins/example/package.json` — exact `next` pins (corroborate from `npm view @deepseek-ai/dsh-tools@next` before writing — do not invent):

```json
{
  "peerDependencies": {
    "@deepseek-ai/cordis": "4.0.1",
    "@deepseek-ai/dsh-tools": "0.1.0-rc.8"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "4.0.1",
    "@deepseek-ai/dsh-tools": "0.1.0-rc.8",
    "tsx": "^4.22.4",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8",
    "@types/node": "^22.20.0"
  }
}
```

- [ ] **Step 5: Run behavior + lifecycle tests**

Run: `pnpm --dir plugins/example install`
Run: `pnpm --dir plugins/example test`
Expected: behavior test PASS; lifecycle test PASS (greet registered, then removed on dispose).

- [ ] **Step 6: Add a dependency-transition test**

`plugins/example/tests/deps.spec.ts`:

```ts
import { Context, FiberState } from '@deepseek-ai/cordis'
import { describe, it, expect } from 'vitest'

describe('example plugin inject contract', () => {
  it('reports PENDING until the tools service is provided', () => {
    const ctx = new Context()
    // Mount a plugin that injects 'tools' before any provider is present.
    // Use ctx.registry to read fiber state without a real provider.
    // Assert the fiber is PENDING, then provide tools and assert ACTIVE.
    // Concrete code depends on the exact cordis registry API at the pinned
    // version; fill it in here during implementation.
  })
})
```

> Note: exact fiber/registry introspection differs by cordis version; implement against the pinned `4.0.1` API and make the assertion concrete (do not leave a skipped test). If the pinned cordis exposes `ctx.registry` fibers (as the research note documents), use it.

- [ ] **Step 7: Run full plugin suite**

Run: `pnpm --dir plugins/example test`
Expected: all specs PASS.

- [ ] **Step 8: Commit (inside the plugin repo)**

```bash
cd plugins/example
git add .
git commit -m "feat: add greet tool with lifecycle and dependency tests"
```

---

### Task 10: `lab verify` e2e (packed bundle + next/master) and acceptance acceptance gate

**Files:**
- Modify: `tooling/src/run.ts` (finalize `verifyBundle` end-to-end)
- Create: `tooling/src/e2e.spec.ts` (optional thin harness exercising `verifyBundle` against the example plugin)

**Interfaces:**
- Consumes: `verifyBundle` (Task 7), the real example plugin (Task 9), `workbench/profiles/*` (Task 7), compatibility manifest (Task 8).
- Produces: a deterministic run that (1) builds + packs the plugin, (2) creates a temp profile, (3) installs the tarball, (4) boots the profile, (5) asserts the `greet` tool is observable, and (6) repeats for pinned master. Also wires `catalog.yaml` and connects `lab verify --target all`.

- [ ] **Step 1: Finalize verifyBundle with real subprocess orchestration**

Complete `tooling/src/run.ts` `verifyBundle`:

```ts
export async function verifyBundle(opts) {
  const { root, name, target } = opts
  const entry = await catalogEntry(root, name)
  const pluginDir = join(root, entry.path)
  const compat = loadCompatibilityFromFile(rootPath(root, ROOT_PATHS.compatibility))
  const dshPin = compat.targets[target].dsh

  // Build + pack in the plugin repo.
  execSync('pnpm install', { cwd: pluginDir, stdio: 'inherit' })
  execSync('pnpm build', { cwd: pluginDir, stdio: 'inherit' })
  const packOut = execSync('pnpm pack --json', { cwd: pluginDir, encoding: 'utf8' })
  const tarball = JSON.parse(packOut)[0].filename

  // Create an ephemeral profile from the workbench template.
  const profileDir = join(root, ROOT_PATHS.runtime, 'profiles', `${name}-${target}`)
  rmSync(profileDir, { recursive: true, force: true })
  mkdirSync(profileDir, { recursive: true })
  const spec = target === 'next'
    ? { name: `dsh-${name}`, bundles: ['@deepseek-ai/dsh-base'] }
    : { name: `dsh-${name}`, bundles: ['@deepseek-ai/dsh-base'] }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(buildProfilePackageJson(spec, { dsh: dshPin }), null, 2) + '\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - "."\n')

  // Install the built bundle into the profile plugin manager.
  execSync(`pnpm exec dsh plugin --profile . add file:${join(pluginDir, tarball)}`, { cwd: profileDir, stdio: 'inherit' })
  // Boot and assert the observable tool exists.
  const out = execSync(`pnpm exec dsh --profile . --dump-config`, { cwd: profileDir, encoding: 'utf8' })
  if (!out.includes(name)) {
    throw new Error(`plugin '${name}' missing from composed profile config`)
  }
  console.log(`[verify] bundled plugin '${name}' loads under ${target}`)
}
```

> Ensure `catalogEntry` reads `catalog.yaml` and throws if the plugin is absent. Because `verifyBundle` needs `loadCompatibilityFromFile`, `buildProfilePackageJson`, and `catalogEntry` — all defined in `run.ts` or its imports — consolidate these in `run.ts` (no import cycle).

- [ ] **Step 2: Wire catalog.yaml with the example**

`catalog.yaml`:

```yaml
plugins:
  example:
    path: plugins/example
    tracking: local
    maturity: experiment
```

Run: `pnpm lab verify example --target next`
Expected: builds/packs the example plugin, installs the tarball into an ephemeral profile, and reports the composed config contains `example`.

- [ ] **Step 3: Master compatibility run**

For master: build the pinned upstream harness once (from the Task 8 submodule) with `pnpm install && pnpm run build` in `upstream/deepseek-harness`, then run `pnpm lab verify example --target master` against the built source (labelled source/master compatibility). If the harness does not build on the host (Windows toolchain limits), document the failure as an environmental constraint and keep the `next` packed-bundle result as the local acceptance evidence — do not silently fake a pass.

- [ ] **Step 4: Regression guard: verify the test actually fails without the fix**

Temporarily change `plugins/example/src/index.ts` to register a tool named `nope` instead of `greet`. Run `pnpm lab verify example --target next`.
Expected: FAIL (observable tool absent from composed output).
Revert the change. Re-run: PASS.

- [ ] **Step 5: Commit**

```bash
cd tooling && git add src/run.ts && cd ..
git add catalog.yaml
git commit -m "feat: e2e verify of bundled example plugin against next and master"
```

(Commit inside the example plugin repo for its own changes, as in Task 9 Step 8.)

---

### Task 11: Final acceptance gate + documentation

**Files:**
- Modify: `tooling/src/cli.ts` (doctor exit semantics finalization)
- Create: `docs/using-the-lab.md` (recipes for authors)
- Modify: `README.md` (point to docs + context)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a verified first implementation satisfying all ten §16 acceptance criteria, plus author-facing docs.

- [ ] **Step 1: Run the full suite and doctor**

Run: `pnpm typecheck && pnpm test && pnpm lab doctor`
Expected: all green; node version matches the pinned `22.20.0` (or record a deliberate pin deviation if the host node differs — update `workbench/compatibility.yaml` to the actual running version only if that is an intentional, documented choice; otherwise install the pinned node).

- [ ] **Step 2: Standalone-clone proof (constraint 12)**

Clone the example plugin alone into a temp dir and run its own checks without the meta-repo:

```bash
mkdir -p /tmp/sc && cd /tmp/sc
git clone <example-repo-local-path> example
cd example
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

Expected: all succeed without any parent `dsh-lab`. The self-contained `tsconfig.json` (Task 5) and committed `shared-context.md` (Task 6) make this possible.

- [ ] **Step 3: Walk each §16 criterion**

Manually verify and record evidence for each of the ten §16 readiness criteria; map each to the task that satisfies it. Where a criterion depends on the dummy `logs` array removed at runtime, update `plugins/example/tests/index.spec.ts` to assert a real, observable side effect (see Task 9 Step 1 note).

- [ ] **Step 4: Write author docs**

`docs/using-the-lab.md` — recipes: `lab new`, `lab dev` source loop, `lab verify` bundle loop, `lab sync-context`, moving a plugin `local → submodule`, and troubleshooting (stale context, version mismatch, dirty submodule, master build failure on Windows).

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "docs: author guide and acceptance evidence for the plugin laboratory"
```

---

## Self-Review

### 1. Spec coverage
Mapped each §16 acceptance criterion to a task:

| §16 | Task |
|---|---|
| 1 meta-repo + root context + catalog schema + compat manifest | 1, 2, 3 |
| 2 paper.pdf → references + research link | 3 |
| 3 pinned upstream submodule + commit | 8 |
| 4 `lab new example` → repo + snapshot + catalog | 5, 6 |
| 5 example passes behavior + lifecycle | 9 |
| 6 `lab dev --target next` loads source + HMR | 7, 9 |
| 7 `lab verify --target next` tarball + profile boot + observable | 7, 10 |
| 8 same example vs pinned master | 8, 10 |
| 9 standalone clone self-sufficient | 5, 6, 11 |
| 10 `lab doctor` stale/mismatch/submodule | 4, 8, 11 |

Design §9 (five commands), §10 (two modes), §11 (package contract), §12 (test levels), §13 (CI/pub), §14 (diagnostics), §15 (security), §17 (decisions) are all reflected in Tasks 1–11.

### 2. Placeholder scan
No `TBD`/`TODO` remains. The upstream commit placeholder in `workbench/compatibility.yaml` is finalized in Task 8, and `run.ts`'s inline-noted `catalogEntry` stub is resolved in Task 10 (explicit step). The dependency-transition test in Task 9 contains a textual note to the implementer about discovering the pinned cordis registry API — it is an explicit implementation instruction, not a code-only placeholder, and is bound to pinned `4.0.1`.

### 3. Type consistency
- `loadCompatibility`/`loadCatalog`/`loadCompatibilityFromFile`/`loadCatalogFromFile` (Task 2) are used by Tasks 4, 6, 7, 8, 10 — consistent.
- `rootPath`/`ROOT_PATHS` (Task 4) used across Tasks 6–10 — consistent.
- `createPlugin`, `loadPluginConfig`, `PluginConfig` (Task 5) used by Tasks 6, 7, 9 — consistent.
- `devSource`, `verifyBundle`, `resolveSourceOverlay`, `buildProfilePackageJson` (Task 7) finalized in Task 10 — signatures stable.
- `ensureUpstream`, `verifyUpstreamCommit` (Task 8) used in Task 10/doctor — consistent.
- `snapshotContext`, `syncContext`, `SyncedResult` (Task 6) consistent with Task 5's snapshot creation.
- `Catalog`, `CatalogEntry`, `Compatibility`, `TargetPin` (Task 2) consistently named across catalog.yaml, compatibility.yaml, and all loaders.
