import { createHash, type Hash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type DevRestartReason = 'plugin-manifest' | 'plugin-metadata' | 'target-pin'

export interface DevRestartBaseline {
  pluginManifest: `sha256:${string}`
  pluginMetadata: `sha256:${string}`
  targetPin: `sha256:${string}`
}

export interface ComputeRestartInput {
  pluginSourcePath: string
  targetPin: string
}

export const EMPTY_DIGEST: `sha256:${string}` = digestString('')

function hex(hash: Hash): `sha256:${string}` {
  return `sha256:${hash.digest('hex')}` as `sha256:${string}`
}

export function digestString(text: string): `sha256:${string}` {
  return hex(createHash('sha256').update(text, 'utf8'))
}

type ReadText = (path: string) => string

export function digestRequiredFile(path: string, read: ReadText = p => readFileSync(p, 'utf8')): `sha256:${string}` {
  return digestString(read(path))
}

export function digestOptionalFile(path: string, read: ReadText = p => readFileSync(p, 'utf8')): `sha256:${string}` {
  try { return digestString(read(path)) } catch (error) {
    if (isNotFound(error)) return EMPTY_DIGEST
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function computeDevRestartBaseline(input: ComputeRestartInput): DevRestartBaseline {
  const { pluginSourcePath, targetPin } = input
  return {
    pluginManifest: digestRequiredFile(join(pluginSourcePath, 'package.json')),
    pluginMetadata: digestOptionalFile(join(pluginSourcePath, '.dsh-lab', 'plugin.yaml')),
    targetPin: digestString(targetPin),
  }
}

export function aggregateRestartHash(baseline: DevRestartBaseline): `sha256:${string}` {
  const hash = createHash('sha256')
  for (const [key, value] of [
    ['pluginManifest', baseline.pluginManifest],
    ['pluginMetadata', baseline.pluginMetadata],
    ['targetPin', baseline.targetPin],
  ] as const) {
    const byte = Buffer.from(`${key}:${value}`, 'utf8')
    const len = Buffer.allocUnsafe(8)
    len.writeBigUInt64BE(BigInt(byte.length))
    hash.update(len)
    hash.update(byte)
  }
  return hex(hash)
}

export function restartReasonsForBaseline(current: DevRestartBaseline, baseline: DevRestartBaseline): DevRestartReason[] {
  const reasons: DevRestartReason[] = []
  if (current.pluginManifest !== baseline.pluginManifest) reasons.push('plugin-manifest')
  if (current.pluginMetadata !== baseline.pluginMetadata) reasons.push('plugin-metadata')
  if (current.targetPin !== baseline.targetPin) reasons.push('target-pin')
  return reasons.sort((a, b) => a.localeCompare(b))
}
