import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { buildServer } from './server.js'
import { handleInspect } from './handlers.js'
import { inspectPlugin } from '../inspect.js'
import { resolvePluginRef } from '../plugin-ref.js'

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
    expect(names).toEqual(expect.arrayContaining(['dsh_lab.inspect', 'dsh_lab.status', 'dsh_lab.doctor', 'dsh_lab.get_evidence', 'dsh_lab.list_plugins', 'dsh_lab.verify']))
    expect(names).toHaveLength(6)
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
    const handler = createMcpHandler(() => buildServer(root, deps))
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
