import { join } from 'node:path'

export const ROOT_PATHS = {
  compatibility: 'workbench/compatibility.yaml',
  catalog: 'catalog.yaml',
  contextDir: 'context',
  plugins: 'plugins',
  upstream: 'upstream/deepseek-harness',
  runtime: '.lab/runtime',
  uiRuns: '.lab/ui-runs',
} as const

export function rootPath(root: string, rel: string): string {
  return join(root, rel)
}
