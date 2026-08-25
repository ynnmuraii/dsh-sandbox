import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { buildServer, type McpServerOptions } from './server.js'

export async function runMcp(root: string, options?: McpServerOptions): Promise<number> {
  const handle = serveStdio(() => buildServer(root, options))
  console.error('[dsh-lab] MCP server ready (stdio)')
  await new Promise<void>(resolve => {
    const done = () => resolve()
    process.stdin.on('end', done)
    process.stdin.on('close', done)
    process.stdin.on('error', done)
  })
  await handle.close().catch(() => {})
  return 0
}

export { buildServer } from './server.js'
