import { describe, it, expect, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { buildServer, doctorMeta } from './server.js'
import { handleInspect } from './handlers.js'
import { inspectPlugin } from '../inspect.js'
import { resolvePluginRef } from '../plugin-ref.js'
import { createUiSession, type UiSessionStateV1 } from '../ui-session.js'
import { loadCatalogFromFile } from '../schemas.js'
import { computePluginDigest } from '../plugin-snapshot.js'
import { computeContextDigest } from '../status.js'

const roots: string[] = []
const NEXT = '0.1.1-rc.2'
const MASTER = 'c'.repeat(40)

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRootWithPlugin(): { root: string; pluginPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-server-'))
  roots.push(root)
  const pluginPath = join(root, 'plugin')
  mkdirSync(join(pluginPath, 'src'), { recursive: true })
  mkdirSync(join(pluginPath, '.dsh-lab'), { recursive: true })
  mkdirSync(join(root, 'workbench'), { recursive: true })
  mkdirSync(join(root, 'context'), { recursive: true })
  writeFileSync(join(root, 'context', 'harness-contracts.md'), '# harness\n')
  writeFileSync(join(root, 'context', 'cordis-model.md'), '# cordis\n')
  writeFileSync(join(root, 'context', 'plugin-anatomy.md'), '# anatomy\n')
  writeFileSync(join(root, 'context', 'testing-policy.md'), '# policy\n')
  writeFileSync(join(root, 'context', 'lab-author-guide.md'), '# guide\n')
  mkdirSync(join(root, '.agents', 'skills', 'dsh-plugin-development'), { recursive: true })
  writeFileSync(join(root, '.agents', 'skills', 'dsh-plugin-development', 'SKILL.md'), '# skill\n')
  writeFileSync(
    join(root, 'workbench', 'compatibility.yaml'),
    [
      'targets:',
      '  next:',
      `    dsh: ${NEXT}`,
      '    cordis: 4.0.1',
      '    node: 22.20.0',
      '    pnpm: 11.7.0',
      '  master:',
      '    repository: deepseek-ai/deepseek-harness',
      `    commit: ${MASTER}`,
      '    pnpm: 11.7.0',
      '    node: ^22.19.0',
    ].join('\n'),
  )
  writeFileSync(join(pluginPath, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(pluginPath, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(pluginPath, 'cordis.patch.yml'), '- insert:\n    - id: demo\n')
  writeFileSync(join(pluginPath, 'src', 'index.ts'), 'export const name = \"demo\"\n')
  writeFileSync(
    join(pluginPath, 'package.json'),
    JSON.stringify(
      {
        name: '@fixture/demo',
        version: '0.0.0',
        type: 'module',
        packageManager: 'pnpm@11.7.0',
        main: 'lib/index.js',
        exports: { '.': './lib/index.js' },
        files: ['lib', 'cordis.patch.yml'],
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
        scripts: { build: 'tsc', typecheck: 'tsc --noEmit', test: 'vitest run', 'pack-smoke': 'node scripts/pack-smoke.mjs' },
        peerDependencies: { '@deepseek-ai/cordis': '4.0.1', '@deepseek-ai/dsh-tools': NEXT },
        devDependencies: { '@deepseek-ai/cordis': '4.0.1', '@deepseek-ai/dsh-tools': NEXT },
      },
      null,
      2,
    ) + '\n',
  )
  writeFileSync(join(pluginPath, '.dsh-lab', 'plugin.yaml'), 'name: demo\ntracking: local\nmaturity: experiment\ntargets:\n  - next\n')
  return { root, pluginPath }
}

function mkAuthoringRoot(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-authoring-'))
  roots.push(root)
  mkdirSync(join(root, 'context'), { recursive: true })
  writeFileSync(join(root, 'context', 'harness-contracts.md'), '# harness\n')
  return { root }
}

function scArray<T>(sc: unknown): T[] {
  return Array.isArray(sc) ? (sc as T[]) : (((sc as { result?: unknown })?.result) as T[] ?? [])
}

async function rpc(handler: { fetch: (req: Request) => Promise<Response> }, body: unknown) {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  })
  const res = await handler.fetch(req)
  const text = await res.text()
  // handler returns SSE (event: message\ndata: {...}) for both eras; unwrap it
  let jsonText = text
  if (text.startsWith('event:')) {
    const dataLine = text.split('\n').find(line => line.startsWith('data:'))
    if (dataLine !== undefined) jsonText = dataLine.slice(5).trim()
  }
  try {
    return JSON.parse(jsonText)
  } catch {
    return text
  }
}

describe('mcp server integration via createMcpHandler', () => {
  it('lists the 4 tools', async () => {
    const { root } = mkRootWithPlugin()
    const handler = createMcpHandler(() => buildServer(root))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const tools = json.result?.tools ?? json.tools
    const names = (tools as Array<{ name: string }>).map(t => t.name)
    expect(names).toEqual(expect.arrayContaining(['dsh_lab.inspect', 'dsh_lab.status', 'dsh_lab.doctor', 'dsh_lab.get_evidence', 'dsh_lab.list_plugins', 'dsh_lab.verify', 'dsh_lab.ui_start', 'dsh_lab.ui_status', 'dsh_lab.ui_finish', 'dsh_lab.ui_abort']))
    expect(names).toHaveLength(10)
    await handler.close().catch(() => {})
  })

  it('tools/call inspect returns structuredContent parity with handler and core function', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const handler = createMcpHandler(() => buildServer(root))
    const json = await rpc(handler, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'dsh_lab.inspect', arguments: { path: pluginPath } },
    })
    // legacy-era path: result may be in json.result or directly json
    const result = json.result ?? json
    // result should have structuredContent and content
    expect(result.structuredContent).toBeDefined()
    expect(result.content).toBeDefined()
    expect(result.isError).toBeUndefined()
    // parity: handler returns same as direct inspectPlugin
    const pluginRef = resolvePluginRef({ root, selector: { path: pluginPath } })
    const direct = inspectPlugin({ root, plugin: pluginRef })
    expect(result.structuredContent).toEqual(direct)
    expect(JSON.parse(result.content[0].text)).toEqual(direct)
    // also parity with handleInspect
    const viaHandler = handleInspect(root, { path: pluginPath })
    expect(result.structuredContent).toEqual(viaHandler)
    expect(JSON.stringify(result.structuredContent)).toBe(JSON.stringify(direct))
    await handler.close().catch(() => {})
  })

  it('resources/list advertises the 7 live resources', async () => {
    const { root } = mkRootWithPlugin()
    const handler = createMcpHandler(() => buildServer(root))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} })
    const result = json.result ?? json
    const resources = result.resources as Array<{ uri: string }>
    const uris = resources.map(r => r.uri)
    expect(uris).toEqual(
      expect.arrayContaining([
        'dsh://contracts/harness',
        'dsh://contracts/cordis',
        'dsh://contracts/anatomy',
        'dsh://testing-policy',
        'dsh://compatibility',
        'dsh://lab-guide',
        'dsh://skill',
      ]),
    )
    expect(uris).toHaveLength(7)
    await handler.close().catch(() => {})
  })

  it('resources/read returns live file content', async () => {
    const { root } = mkRootWithPlugin()
    // mutate a file after server built to ensure live read
    const handler = createMcpHandler(() => buildServer(root))
    const liveText = '# updated harness\nunique-' + Date.now()
    writeFileSync(join(root, 'context', 'harness-contracts.md'), liveText)
    const json = await rpc(handler, {
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri: 'dsh://contracts/harness' },
    })
    const result = json.result ?? json
    const contents = result.contents as Array<{ text: string; uri: string }>
    expect(contents[0]!.text).toBe(liveText)
    // also compatibility
    const yaml = readFileSync(join(root, 'workbench', 'compatibility.yaml'), 'utf8')
    const json2 = await rpc(handler, {
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/read',
      params: { uri: 'dsh://compatibility' },
    })
    const result2 = json2.result ?? json2
    expect((result2.contents as Array<{ text: string }>)[0]!.text).toBe(yaml)
    await handler.close().catch(() => {})
  })

  it('doctor and get_evidence tools work via handler', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const handler = createMcpHandler(() => buildServer(root))
    const doc = await rpc(handler, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'dsh_lab.doctor', arguments: {} } })
    const docResult = (doc.result ?? doc) as { structuredContent: unknown; isError?: boolean }
    expect(docResult.isError).toBeUndefined()
    const docDiagnostics = Array.isArray(docResult.structuredContent) ? docResult.structuredContent : (docResult.structuredContent as any)?.result
    expect(Array.isArray(docDiagnostics)).toBe(true)

    const ev = await rpc(handler, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'dsh_lab.get_evidence', arguments: { path: pluginPath, kind: 'all', limit: 5 } },
    })
    const evResult = (ev.result ?? ev) as { structuredContent: { verify: unknown[]; ui: unknown[] } }
    expect(evResult.structuredContent.verify).toEqual([])
    expect(evResult.structuredContent.ui).toEqual([])
    await handler.close().catch(() => {})
  })

  it('list_plugins and enriched unknown plugin error via handler', async () => {
    const { root } = mkRootWithPlugin()
    // missing catalog -> []
    let handler = createMcpHandler(() => buildServer(root))
    let list = await rpc(handler, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'dsh_lab.list_plugins', arguments: {} } })
    let listResult = (list.result ?? list) as { structuredContent: unknown }
    const empty = Array.isArray(listResult.structuredContent) ? listResult.structuredContent : (listResult.structuredContent as any)?.result ?? listResult.structuredContent
    expect(Array.isArray(empty) ? empty : []).toEqual([])
    await handler.close().catch(() => {})
    // with catalog
    writeFileSync(join(root, 'catalog.yaml'), ['plugins:', '  example:', '    path: plugin', '    tracking: local', '  chat-annotations:', '    path: plugins/chat-annotations', '    tracking: submodule', '    repository: org/repo'].join('\n') + '\n')
    handler = createMcpHandler(() => buildServer(root))
    list = await rpc(handler, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'dsh_lab.list_plugins', arguments: {} } })
    listResult = (list.result ?? list) as { structuredContent: unknown }
    const entries = Array.isArray(listResult.structuredContent) ? listResult.structuredContent : (listResult.structuredContent as any)?.result ?? listResult.structuredContent
    expect((entries as any[]).map((e:any)=>e.name).sort()).toEqual(['chat-annotations','example'])
    // unknown plugin should enrich
    const err = await rpc(handler, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'dsh_lab.inspect', arguments: { plugin: 'nonexistent' } } })
    const errResult = (err.result ?? err) as { isError?: boolean; content?: Array<{text:string}> }
    expect(errResult.isError).toBe(true)
    const msg = errResult.content?.[0]?.text ?? ''
    expect(msg).toContain('UNKNOWN_PLUGIN')
    expect(msg).toContain('available:')
    expect(msg).toContain('example')
    await handler.close().catch(() => {})
  })

  it('verify tool with mocked deps returns pass and persists (via server)', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const deps: any = {
      inspectPlugin: vi.fn(() => ({ schemaVersion: 1, plugin: { packageName: '@fixture/demo', sourcePath: pluginPath }, faces: { host: true, client: 'unknown' }, diagnostics: [], ok: true })),
      verifyPackage: vi.fn(() => ({
        tarball: join(root, 'dummy.tgz'),
        steps: [
          { id: 'install', status: 'pass' as const, durationMs: 1 },
          { id: 'typecheck', status: 'pass' as const, durationMs: 1 },
          { id: 'test', status: 'pass' as const, durationMs: 1 },
          { id: 'build', status: 'pass' as const, durationMs: 1 },
          { id: 'pack', status: 'pass' as const, durationMs: 1 },
          { id: 'pack-smoke', status: 'pass' as const, durationMs: 1 },
        ],
      })),
      verifyTarget: vi.fn(async () => {}),
      createRunId: vi.fn(() => 'verify-server-0001'),
      now: vi.fn(() => new Date('2026-08-23T10:00:00.000Z')),
    }
    const handler = createMcpHandler(() => buildServer(root, { verifyDeps: deps }))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'dsh_lab.verify', arguments: { path: pluginPath, target: 'next' } } })
    const result = json.result ?? json
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toBeDefined()
    expect((result.structuredContent as any).result).toBe('pass')
    expect((result.structuredContent as any).runId).toBe('verify-server-0001')
    await handler.close().catch(() => {})
    // fresh root for INVALID_TARGET
    const { root: root2, pluginPath: pluginPath2 } = mkRootWithPlugin()
    writeFileSync(join(pluginPath2, '.dsh-lab', 'plugin.yaml'), 'name: demo\ntracking: local\nmaturity: experiment\n')
    const handler2 = createMcpHandler(() => buildServer(root2))
    const err2 = await rpc(handler2, { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'dsh_lab.verify', arguments: { path: pluginPath2 } } })
    const errResult = err2.result ?? err2
    expect(errResult.isError).toBe(true)
    expect(errResult.content?.[0]?.text).toContain('INVALID_TARGET')
    await handler2.close().catch(() => {})
  })
})

const UI_SESSION = 'ui-20260824T120000000Z-a1b2c3d4'
const UI_NOW = '2026-08-24T12:00:04.000Z'

function uiReadyState(root: string, pluginPath: string, sessionId: string): UiSessionStateV1 {
  return {
    schemaVersion: 1,
    sessionId,
    state: 'ready',
    plugin: { packageName: '@fixture/demo', sourcePath: pluginPath, digest: computePluginDigest(pluginPath).digest },
    target: { name: 'next', dsh: NEXT },
    contextDigest: computeContextDigest(root),
    supervisorPid: 7001,
    childPid: 7002,
    url: 'http://127.0.0.1:49152',
    startedAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:00.000Z',
  }
}

describe('mcp UI server integration', () => {
  it('tools/list advertises exactly the 10 ui-enabled tools', async () => {
    const { root } = mkRootWithPlugin()
    const handler = createMcpHandler(() => buildServer(root))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 19, method: 'tools/list', params: {} })
    const tools = json.result?.tools ?? json.tools
    const names = (tools as Array<{ name: string }>).map(tool => tool.name)
    expect(names).toHaveLength(10)
    expect(names).toEqual(
      expect.arrayContaining([
        'dsh_lab.inspect',
        'dsh_lab.status',
        'dsh_lab.doctor',
        'dsh_lab.get_evidence',
        'dsh_lab.list_plugins',
        'dsh_lab.verify',
        'dsh_lab.ui_start',
        'dsh_lab.ui_status',
        'dsh_lab.ui_finish',
        'dsh_lab.ui_abort',
      ]),
    )
    await handler.close().catch(() => {})
  })

  it('ui_status returns a ready view through the handler', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    createUiSession({ runtimeRoot: join(root, '.lab', 'runtime'), state: uiReadyState(root, pluginPath, UI_SESSION) })
    const handler = createMcpHandler(() => buildServer(root, { uiDeps: { now: () => UI_NOW, processAlive: () => true } }))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'dsh_lab.ui_status', arguments: { sessionId: UI_SESSION } } })
    const result = json.result ?? json
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ sessionId: UI_SESSION, state: 'ready', stale: false, url: 'http://127.0.0.1:49152' })
    await handler.close().catch(() => {})
  })

  it('ui_status returns an isError UI_NOT_FOUND for an unknown session', async () => {
    const { root } = mkRootWithPlugin()
    const handler = createMcpHandler(() => buildServer(root))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'dsh_lab.ui_status', arguments: { sessionId: UI_SESSION } } })
    const result = json.result ?? json
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('UI_NOT_FOUND')
    await handler.close().catch(() => {})
  })
})

describe('mcp authoring gating', () => {
  const AUTH_TOOLS = ['dsh_lab.create_plugin', 'dsh_lab.sync_context']

  it('default server lists 10 and rejects authoring tools without mutation', async () => {
    const { root } = mkAuthoringRoot()
    const handler = createMcpHandler(() => buildServer(root))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 100, method: 'tools/list', params: {} })
    const names = ((json.result?.tools ?? json.tools) as Array<{ name: string }>).map(t => t.name)
    expect(names).toHaveLength(10)
    expect(names).not.toContain('dsh_lab.create_plugin')
    expect(names).not.toContain('dsh_lab.sync_context')
    const call = await rpc(handler, { jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'dsh_lab.create_plugin', arguments: { name: 'acme-test' } } })
    expect(call.error !== undefined || (call.result ?? call).isError === true).toBe(true)
    expect(existsSync(join(root, 'plugins', 'acme-test'))).toBe(false)
    await handler.close().catch(() => {})
  })

  it('gated server lists 12 including authoring tools', async () => {
    const { root } = mkAuthoringRoot()
    const handler = createMcpHandler(() => buildServer(root, { allowAuthoring: true }))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 200, method: 'tools/list', params: {} })
    const names = ((json.result?.tools ?? json.tools) as Array<{ name: string }>).map(t => t.name)
    expect(names).toHaveLength(12)
    expect(names).toEqual(expect.arrayContaining(AUTH_TOOLS))
    await handler.close().catch(() => {})
  })

  it('gated create_plugin scaffolds a nested repo + catalog and rejects dup/invalid', async () => {
    const { root } = mkAuthoringRoot()
    const handler = createMcpHandler(() => buildServer(root, { allowAuthoring: true }))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 300, method: 'tools/call', params: { name: 'dsh_lab.create_plugin', arguments: { name: 'acme-test' } } })
    const result = (json.result ?? json) as { structuredContent?: { sourcePath: string; catalogName: string }; isError?: boolean }
    expect(result.isError).toBeUndefined()
    const sc = result.structuredContent!
    expect(sc.catalogName).toBe('acme-test')
    expect(sc.sourcePath).toBe(join(root, 'plugins', 'acme-test'))
    expect(existsSync(join(sc.sourcePath, '.git'))).toBe(true)
    const pkg = JSON.parse(readFileSync(join(sc.sourcePath, 'package.json'), 'utf8'))
    expect(pkg.type).toBe('module')
    expect(pkg.main).toBe('lib/index.js')
    expect(pkg.dsh?.bundle?.patch).toBe('cordis.patch.yml')
    expect(existsSync(join(sc.sourcePath, 'pnpm-workspace.yaml'))).toBe(true)
    expect(existsSync(join(sc.sourcePath, '.dsh-lab', 'shared-context.md'))).toBe(true)
    const catalog = loadCatalogFromFile(join(root, 'catalog.yaml'))
    expect(catalog.plugins['acme-test']).toMatchObject({ path: 'plugins/acme-test', tracking: 'local', maturity: 'experiment' })

    const dup = await rpc(handler, { jsonrpc: '2.0', id: 301, method: 'tools/call', params: { name: 'dsh_lab.create_plugin', arguments: { name: 'acme-test' } } })
    const dupResult = (dup.result ?? dup) as { isError?: boolean; content?: Array<{ text: string }> }
    expect(dupResult.isError).toBe(true)
    expect(dupResult.content?.[0]?.text).toContain('INVALID_NAME')
    // Bad_Name is rejected at the zod schema boundary (.regex(NAME_RE)) before
    // the handler runs — assert the input-validation shape, not INVALID_NAME.
    const bad = await rpc(handler, { jsonrpc: '2.0', id: 302, method: 'tools/call', params: { name: 'dsh_lab.create_plugin', arguments: { name: 'Bad_Name' } } })
    const badResult = (bad.result ?? bad) as { isError?: boolean; content?: Array<{ text: string }> }
    expect(badResult.isError).toBe(true)
    expect(badResult.content?.[0]?.text).toContain('Input validation error')
    expect(existsSync(join(root, 'plugins', 'Bad_Name'))).toBe(false)
    await handler.close().catch(() => {})
  })

  it('gated sync_context rewrites snapshots, is idempotent, and validates args/unknown/non-git', async () => {
    const { root } = mkAuthoringRoot()
    const handler = createMcpHandler(() => buildServer(root, { allowAuthoring: true }))
    await rpc(handler, { jsonrpc: '2.0', id: 400, method: 'tools/call', params: { name: 'dsh_lab.create_plugin', arguments: { name: 'acme-test' } } })
    writeFileSync(join(root, 'context', 'harness-contracts.md'), '# harness changed\n')
    const s1 = await rpc(handler, { jsonrpc: '2.0', id: 401, method: 'tools/call', params: { name: 'dsh_lab.sync_context', arguments: { plugin: 'acme-test' } } })
    const r1 = (s1.result ?? s1) as { structuredContent: Array<{ kind: string; name: string; changed: boolean; path: string }>; isError?: boolean }
    expect(r1.isError).toBeUndefined()
    expect(scArray(r1.structuredContent)[0]).toMatchObject({ kind: 'plugin-context', name: 'acme-test', changed: true })
    const s2 = await rpc(handler, { jsonrpc: '2.0', id: 402, method: 'tools/call', params: { name: 'dsh_lab.sync_context', arguments: { plugin: 'acme-test' } } })
    const r2 = (s2.result ?? s2) as { structuredContent: Array<{ changed: boolean }> }
    expect(scArray<{ changed: boolean }>(r2.structuredContent)[0]!.changed).toBe(false)
    const all = await rpc(handler, { jsonrpc: '2.0', id: 403, method: 'tools/call', params: { name: 'dsh_lab.sync_context', arguments: { all: true } } })
    const rAll = (all.result ?? all) as { structuredContent: Array<{ name: string }>; isError?: boolean }
    expect(rAll.isError).toBeUndefined()
    expect(scArray<{ name: string }>(rAll.structuredContent).map(r => r.name)).toContain('acme-test')
    for (const args of [{}, { plugin: 'acme-test', all: true }]) {
      const bad = await rpc(handler, { jsonrpc: '2.0', id: 404, method: 'tools/call', params: { name: 'dsh_lab.sync_context', arguments: args } })
      const badResult = (bad.result ?? bad) as { isError?: boolean; content?: Array<{ text: string }> }
      expect(badResult.isError).toBe(true)
      expect(badResult.content?.[0]?.text).toContain('INVALID_ARGS')
    }
    const unknown = await rpc(handler, { jsonrpc: '2.0', id: 405, method: 'tools/call', params: { name: 'dsh_lab.sync_context', arguments: { plugin: 'nope' } } })
    const unknownResult = (unknown.result ?? unknown) as { isError?: boolean; content?: Array<{ text: string }> }
    expect(unknownResult.isError).toBe(true)
    expect(unknownResult.content?.[0]?.text).toContain('UNKNOWN_PLUGIN')
    writeFileSync(join(root, 'catalog.yaml'), 'plugins:\n  nongit:\n    path: plugins/nongit\n    tracking: local\n')
    mkdirSync(join(root, 'plugins', 'nongit'), { recursive: true })
    const nongit = await rpc(handler, { jsonrpc: '2.0', id: 406, method: 'tools/call', params: { name: 'dsh_lab.sync_context', arguments: { plugin: 'nongit' } } })
    const nongitResult = (nongit.result ?? nongit) as { isError?: boolean; content?: Array<{ text: string }> }
    expect(nongitResult.isError).toBe(true)
    expect(nongitResult.content?.[0]?.text).toContain('NOT_A_PLUGIN_REPO')
    await handler.close().catch(() => {})
  })
})

const MODERN_ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'meta-test-client', version: '0.0.0' },
  'io.modelcontextprotocol/clientCapabilities': { tools: {} },
}

async function modernRpc(handler: { fetch: (req: Request) => Promise<Response> }, body: unknown, method: string, extraHeaders: Record<string, string> = {}) {
  const req = new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-method': method, ...extraHeaders },
    body: JSON.stringify(body),
  })
  const res = await handler.fetch(req)
  const text = await res.text()
  let jsonText = text
  if (text.startsWith('event:')) {
    const dataLine = text.split('\n').find(line => line.startsWith('data:'))
    if (dataLine !== undefined) jsonText = dataLine.slice(5).trim()
  }
  return JSON.parse(jsonText)
}

describe('mcp dshLab metadata contract', () => {
  it('inspect fail carries _meta.dshLab { exitCode: 1, ok: false }', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const pkg = JSON.parse(readFileSync(join(pluginPath, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    delete pkg.scripts.test
    writeFileSync(join(pluginPath, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
    const handler = createMcpHandler(() => buildServer(root))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 500, method: 'tools/call', params: { name: 'dsh_lab.inspect', arguments: { path: pluginPath } } })
    const result = (json.result ?? json) as { structuredContent?: { ok: boolean }; isError?: boolean; _meta?: { dshLab?: Record<string, unknown> } }
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent!.ok).toBe(false)
    expect(result._meta?.dshLab).toMatchObject({ exitCode: 1, ok: false })
    await handler.close().catch(() => {})
  })

  it('status not-run carries _meta.dshLab exitCode 2', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const handler = createMcpHandler(() => buildServer(root))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 501, method: 'tools/call', params: { name: 'dsh_lab.status', arguments: { path: pluginPath } } })
    const result = (json.result ?? json) as { _meta?: { dshLab?: Record<string, unknown> } }
    expect(result._meta?.dshLab).toMatchObject({ exitCode: 2 })
    await handler.close().catch(() => {})
  })

  it('doctor meta helper: [] is hasError false/exit 0, error diag is true/nonzero', () => {
    expect(doctorMeta([])).toEqual({ hasError: false, exitCode: 0 })
    expect(doctorMeta([{ level: 'error', message: 'boom' }])).toEqual({ hasError: true, exitCode: 1 })
    expect(doctorMeta([{ level: 'warn', message: 'x' }])).toEqual({ hasError: false, exitCode: 0 })
  })

  it('doctor result carries _meta.dshLab hasError true/exit 1 on a broken forge', async () => {
    const { root } = mkRootWithPlugin()
    const handler = createMcpHandler(() => buildServer(root))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 502, method: 'tools/call', params: { name: 'dsh_lab.doctor', arguments: {} } })
    const result = (json.result ?? json) as { _meta?: { dshLab?: Record<string, unknown> } }
    expect(result._meta?.dshLab).toMatchObject({ hasError: true, exitCode: 1 })
    await handler.close().catch(() => {})
  })

  it('verify pass carries _meta.dshLab { exitCode: 0, result: pass, runId }', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const deps: any = {
      inspectPlugin: vi.fn(() => ({ schemaVersion: 1, plugin: { packageName: '@fixture/demo', sourcePath: pluginPath }, faces: { host: true, client: 'unknown' }, diagnostics: [], ok: true })),
      verifyPackage: vi.fn(() => ({
        tarball: join(root, 'dummy.tgz'),
        steps: [
          { id: 'install', status: 'pass' as const, durationMs: 1 },
          { id: 'typecheck', status: 'pass' as const, durationMs: 1 },
          { id: 'test', status: 'pass' as const, durationMs: 1 },
          { id: 'build', status: 'pass' as const, durationMs: 1 },
          { id: 'pack', status: 'pass' as const, durationMs: 1 },
          { id: 'pack-smoke', status: 'pass' as const, durationMs: 1 },
        ],
      })),
      verifyTarget: vi.fn(async () => {}),
      createRunId: vi.fn(() => 'verify-meta-0001'),
      now: vi.fn(() => new Date('2026-08-23T10:00:00.000Z')),
    }
    const handler = createMcpHandler(() => buildServer(root, { verifyDeps: deps }))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 503, method: 'tools/call', params: { name: 'dsh_lab.verify', arguments: { path: pluginPath, target: 'next' } } })
    const result = (json.result ?? json) as { _meta?: { dshLab?: Record<string, unknown> } }
    expect(result._meta?.dshLab).toMatchObject({ exitCode: 0, result: 'pass', runId: 'verify-meta-0001' })
    await handler.close().catch(() => {})
  })

  it('verify fail carries _meta.dshLab { exitCode: 1, result: fail, runId }', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const codedSteps = [
      { id: 'install', status: 'pass' as const, durationMs: 1 },
      { id: 'build', status: 'fail' as const, durationMs: 2, summary: 'build failed', code: 'pnpm.build.fail' as const, detail: 'tail' },
    ]
    const failure = Object.assign(new Error('package failed'), { steps: codedSteps })
    const deps: any = {
      inspectPlugin: vi.fn(() => ({ schemaVersion: 1, plugin: { packageName: '@fixture/demo', sourcePath: pluginPath }, faces: { host: true, client: 'unknown' }, diagnostics: [], ok: true })),
      verifyPackage: vi.fn(() => { throw failure }),
      verifyTarget: vi.fn(async () => {}),
      createRunId: vi.fn(() => 'verify-fail-0001'),
      now: vi.fn(() => new Date('2026-08-23T10:00:01.000Z')),
    }
    const handler = createMcpHandler(() => buildServer(root, { verifyDeps: deps }))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 504, method: 'tools/call', params: { name: 'dsh_lab.verify', arguments: { path: pluginPath, target: 'next' } } })
    const result = (json.result ?? json) as { _meta?: { dshLab?: Record<string, unknown> } }
    expect(result._meta?.dshLab).toMatchObject({ exitCode: 1, result: 'fail', runId: 'verify-fail-0001' })
    await handler.close().catch(() => {})
  })

  it('ui_finish stale carries _meta.dshLab { code: UI_STALE, exitCode: 2 }', async () => {
    const { root, pluginPath } = mkRootWithPlugin()
    const state = uiReadyState(root, pluginPath, UI_SESSION)
    createUiSession({ runtimeRoot: join(root, '.lab', 'runtime'), state: { ...state, staleReasons: ['plugin-changed'] } })
    const handler = createMcpHandler(() => buildServer(root, { uiDeps: { now: () => UI_NOW, processAlive: () => true } }))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 505, method: 'tools/call', params: { name: 'dsh_lab.ui_finish', arguments: { sessionId: UI_SESSION, verdict: 'pass', summary: 'x' } } })
    const result = (json.result ?? json) as { isError?: boolean; content?: Array<{ text: string }>; _meta?: { dshLab?: Record<string, unknown> } }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('UI_STALE')
    expect(result._meta?.dshLab).toMatchObject({ code: 'UI_STALE', exitCode: 2 })
    await handler.close().catch(() => {})
  })

  it('create_plugin duplicate name carries _meta.dshLab { code: INVALID_NAME, exitCode: 1 }', async () => {
    const { root } = mkAuthoringRoot()
    const handler = createMcpHandler(() => buildServer(root, { allowAuthoring: true }))
    await rpc(handler, { jsonrpc: '2.0', id: 506, method: 'tools/call', params: { name: 'dsh_lab.create_plugin', arguments: { name: 'acme-meta' } } })
    const dup = await rpc(handler, { jsonrpc: '2.0', id: 507, method: 'tools/call', params: { name: 'dsh_lab.create_plugin', arguments: { name: 'acme-meta' } } })
    const result = (dup.result ?? dup) as { isError?: boolean; content?: Array<{ text: string }>; _meta?: { dshLab?: Record<string, unknown> } }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('INVALID_NAME')
    expect(result._meta?.dshLab).toMatchObject({ code: 'INVALID_NAME', exitCode: 1 })
    await handler.close().catch(() => {})
  })
})

describe('mcp schema-boundary validation', () => {
  it('invalid create_plugin name is rejected at the schema boundary before mutation', async () => {
    const { root } = mkAuthoringRoot()
    const handler = createMcpHandler(() => buildServer(root, { allowAuthoring: true }))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 600, method: 'tools/call', params: { name: 'dsh_lab.create_plugin', arguments: { name: 'Bad_Name' } } })
    const result = (json.result ?? json) as { isError?: boolean; content?: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('Input validation error')
    expect(result.content?.[0]?.text).toContain('catalog slug')
    expect(existsSync(join(root, 'plugins', 'Bad_Name'))).toBe(false)
    await handler.close().catch(() => {})
  })

  it('invalid ui sessionId is rejected at the schema boundary before any fs read', async () => {
    const { root } = mkRootWithPlugin()
    const handler = createMcpHandler(() => buildServer(root))
    const json = await rpc(handler, { jsonrpc: '2.0', id: 601, method: 'tools/call', params: { name: 'dsh_lab.ui_status', arguments: { sessionId: 'not-a-valid-session' } } })
    const result = (json.result ?? json) as { isError?: boolean; content?: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content?.[0]?.text).toContain('Input validation error')
    expect(existsSync(join(root, '.lab'))).toBe(false)
    await handler.close().catch(() => {})
  })
})

describe('mcp modern 2026-07-28 era', () => {
  it('server/discover advertises the 2026-07-28 protocol revision with a modern envelope', async () => {
    const { root } = mkRootWithPlugin()
    const handler = createMcpHandler(() => buildServer(root))
    const json = await modernRpc(handler, { jsonrpc: '2.0', id: 700, method: 'server/discover', params: { _meta: MODERN_ENVELOPE } }, 'server/discover')
    const result = (json.result ?? json) as { supportedVersions?: string[]; capabilities?: Record<string, unknown>; _meta?: Record<string, unknown> }
    expect(result.supportedVersions).toContain('2026-07-28')
    expect((result.supportedVersions ?? []).length).toBeGreaterThan(0)
    expect(result.capabilities).toBeDefined()
    expect(result._meta?.['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'dsh-lab', version: '0.0.0' })
    await handler.close().catch(() => {})
  })

  it('modern tools/call returns _meta.dshLab alongside serverInfo (not a legacy initialize)', async () => {
    const { root } = mkRootWithPlugin()
    const handler = createMcpHandler(() => buildServer(root))
    const json = await modernRpc(handler, { jsonrpc: '2.0', id: 701, method: 'tools/call', params: { _meta: MODERN_ENVELOPE, name: 'dsh_lab.list_plugins', arguments: {} } }, 'tools/call', { 'mcp-name': 'dsh_lab.list_plugins' })
    const result = (json.result ?? json) as { isError?: boolean; _meta?: Record<string, unknown> }
    expect(result.isError).toBeUndefined()
    expect(result._meta?.['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'dsh-lab', version: '0.0.0' })
    expect((result._meta as { dshLab?: unknown } | undefined)?.dshLab).toMatchObject({ exitCode: 0 })
    await handler.close().catch(() => {})
  })
})
